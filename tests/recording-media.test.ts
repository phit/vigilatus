import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDownloadFfmpegArgs,
  buildPlaybackFfmpegArgs,
  buildRetryWindowSizes,
  getHeader,
  parseDigestFields,
  parseHeaders,
  parseStatusCode,
  writeAlignedTsPackets,
} from '../electron/tapo/recordingDownloader';

/** Collects written chunks into an array for assertions, mimicking a real Writable. */
class CollectingWritable extends Writable {
  readonly chunks: Buffer[] = [];

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  get written(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Builds a 188-byte TS packet whose first byte is the 0x47 sync byte and whose body is `fill`. */
function tsPacket(fill: number): Buffer {
  const packet = Buffer.alloc(188, fill);
  packet[0] = 0x47;
  return packet;
}

vi.mock('electron', () => {
  return {
    app: {
      isPackaged: true,
      getAppPath: vi.fn().mockReturnValue('/mocked/app/path'),
    },
  };
});

describe('writeAlignedTsPackets', () => {
  it('resynchronises past leading garbage before a 0x47 sync byte', async () => {
    const writable = new CollectingWritable();
    const packet = tsPacket(0xaa);
    const garbage = Buffer.from([0x00, 0x11, 0x22]);
    const input = Buffer.concat([garbage, packet]);

    const remainder = await writeAlignedTsPackets(Buffer.alloc(0), input, writable);

    expect(remainder.length).toBe(0);
    expect(writable.chunks).toHaveLength(1);
    expect(writable.written.equals(packet)).toBe(true);
  });

  it('writes only whole 188-byte packets and returns the partial trailing remainder', async () => {
    const writable = new CollectingWritable();
    const packetA = tsPacket(0x01);
    const packetB = tsPacket(0x02);
    const partial = Buffer.alloc(50, 0x47); // a partial third packet (< 188 bytes)
    const input = Buffer.concat([packetA, packetB, partial]);

    const remainder = await writeAlignedTsPackets(Buffer.alloc(0), input, writable);

    expect(writable.chunks).toHaveLength(2);
    expect(writable.chunks[0].equals(packetA)).toBe(true);
    expect(writable.chunks[1].equals(packetB)).toBe(true);
    expect(remainder.equals(partial)).toBe(true);
  });

  it('returns an empty Buffer and writes nothing when no sync byte exists', async () => {
    const writable = new CollectingWritable();
    // 200 bytes (>= 188) of non-0x47 data so the resync loop runs and finds no sync byte.
    const input = Buffer.alloc(200, 0x00);

    const remainder = await writeAlignedTsPackets(Buffer.alloc(0), input, writable);

    expect(remainder.length).toBe(0);
    expect(writable.chunks).toHaveLength(0);
  });

  it('concatenates the prior buffer with the new chunk before aligning', async () => {
    const writable = new CollectingWritable();
    const packet = tsPacket(0x03);
    const firstHalf = packet.subarray(0, 100);
    const secondHalf = packet.subarray(100);

    const remainder = await writeAlignedTsPackets(firstHalf, secondHalf, writable);

    expect(writable.chunks).toHaveLength(1);
    expect(writable.written.equals(packet)).toBe(true);
    expect(remainder.length).toBe(0);
  });
});

describe('parseDigestFields', () => {
  it('parses a realistic WWW-Authenticate digest header and strips quotes', () => {
    const header =
      'realm="Login to abc", nonce="0123456789abcdef", qop="auth", opaque="deadbeef", algorithm=MD5';
    expect(parseDigestFields(header)).toEqual({
      realm: 'Login to abc',
      nonce: '0123456789abcdef',
      qop: 'auth',
      opaque: 'deadbeef',
      algorithm: 'MD5',
    });
  });

  it('parses unquoted values and ignores tokens without a key=value shape', () => {
    expect(parseDigestFields('username=admin, nonce=abc123')).toEqual({
      username: 'admin',
      nonce: 'abc123',
    });
  });
});

describe('parseHeaders', () => {
  it('parses CRLF-separated headers into a lowercased-key map and trims values', () => {
    const block = 'Content-Type: video/mp2t\r\nX-Session-Id:   42  \r\nWWW-Authenticate: Digest realm="x"';
    expect(parseHeaders(block)).toEqual({
      'content-type': 'video/mp2t',
      'x-session-id': '42',
      'www-authenticate': 'Digest realm="x"',
    });
  });

  it('skips lines without a colon', () => {
    const block = 'Content-Type: application/json\r\nthis-line-has-no-colon\r\nX-Data-Sequence: 7';
    expect(parseHeaders(block)).toEqual({
      'content-type': 'application/json',
      'x-data-sequence': '7',
    });
  });
});

describe('getHeader', () => {
  it('looks up a header case-insensitively', () => {
    const headers = { 'content-type': 'video/mp2t' };
    expect(getHeader(headers, 'Content-Type')).toBe('video/mp2t');
  });

  it('falls back to the first non-empty candidate name', () => {
    const headers = { 'key-exchange': '', 'x-key-exchange': 'secret' };
    expect(getHeader(headers, 'key-exchange', 'x-key-exchange', 'key_exchange')).toBe('secret');
  });

  it('returns undefined when no candidate matches a non-empty value', () => {
    const headers = { 'x-empty': '' };
    expect(getHeader(headers, 'missing', 'x-empty')).toBeUndefined();
  });
});

describe('parseStatusCode', () => {
  it('parses a standard HTTP/1.1 200 status line', () => {
    expect(parseStatusCode('HTTP/1.1 200 OK')).toBe(200);
  });

  it('parses a HTTP/1.0 401 status line', () => {
    expect(parseStatusCode('HTTP/1.0 401 Unauthorized')).toBe(401);
  });

  it('strips the non-standard "HTTP ERROR 401" prefix and parses the trailing status', () => {
    expect(parseStatusCode('HTTP ERROR 401HTTP/1.1 401 Unauthorized')).toBe(401);
  });

  it('throws on a malformed status line', () => {
    expect(() => parseStatusCode('garbage line')).toThrow(/Unable to parse recording-stream status line/);
  });
});

describe('buildRetryWindowSizes', () => {
  it('keeps a finite positive value then appends the fallback', () => {
    expect(buildRetryWindowSizes(200)).toEqual([200, 50]);
  });

  it('uses the 200 default for undefined, then dedupes the appended fallback', () => {
    expect(buildRetryWindowSizes(undefined)).toEqual([200, 50]);
  });

  it('treats zero/negative/non-finite as the 200 default', () => {
    expect(buildRetryWindowSizes(0)).toEqual([200, 50]);
    expect(buildRetryWindowSizes(-5)).toEqual([200, 50]);
    expect(buildRetryWindowSizes(Number.POSITIVE_INFINITY)).toEqual([200, 50]);
    expect(buildRetryWindowSizes(Number.NaN)).toEqual([200, 50]);
  });

  it('dedupes when the requested value equals the fallback', () => {
    expect(buildRetryWindowSizes(50)).toEqual([50]);
  });
});

describe('buildDownloadFfmpegArgs', () => {
  it('builds video-only copy args', () => {
    expect(buildDownloadFfmpegArgs('/out/clip.mp4')).toMatchInlineSnapshot(`
      [
        "-loglevel",
        "error",
        "-y",
        "-f",
        "mpegts",
        "-i",
        "pipe:0",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "/out/clip.mp4",
      ]
    `);
  });

  it('builds args with pcma (alaw) audio', () => {
    expect(buildDownloadFfmpegArgs('/out/clip.mp4', { codec: 'pcma', sampleRate: 8000 }))
      .toMatchInlineSnapshot(`
      [
        "-loglevel",
        "error",
        "-y",
        "-f",
        "mpegts",
        "-i",
        "pipe:0",
        "-analyzeduration",
        "0",
        "-probesize",
        "32",
        "-f",
        "alaw",
        "-ar",
        "8000",
        "-ac",
        "1",
        "-i",
        "pipe:3",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        "/out/clip.mp4",
      ]
    `);
  });

  it('builds args with pcmu (mulaw) audio', () => {
    expect(buildDownloadFfmpegArgs('/out/clip.mp4', { codec: 'pcmu', sampleRate: 8000 }))
      .toMatchInlineSnapshot(`
      [
        "-loglevel",
        "error",
        "-y",
        "-f",
        "mpegts",
        "-i",
        "pipe:0",
        "-analyzeduration",
        "0",
        "-probesize",
        "32",
        "-f",
        "mulaw",
        "-ar",
        "8000",
        "-ac",
        "1",
        "-i",
        "pipe:3",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        "/out/clip.mp4",
      ]
    `);
  });
});

describe('buildPlaybackFfmpegArgs', () => {
  it('builds video-only transcode args', () => {
    expect(buildPlaybackFfmpegArgs('/out/stream.mp4')).toMatchInlineSnapshot(`
      [
        "-loglevel",
        "error",
        "-y",
        "-fflags",
        "+genpts+discardcorrupt",
        "-err_detect",
        "ignore_err",
        "-analyzeduration",
        "1000000",
        "-probesize",
        "1000000",
        "-f",
        "mpegts",
        "-i",
        "pipe:0",
        "-map",
        "0:v:0",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "50",
        "-sc_threshold",
        "0",
        "-f",
        "mp4",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "/out/stream.mp4",
      ]
    `);
  });

  it('builds args with pcma (alaw) audio', () => {
    expect(buildPlaybackFfmpegArgs('/out/stream.mp4', { codec: 'pcma', sampleRate: 8000 }))
      .toMatchInlineSnapshot(`
      [
        "-loglevel",
        "error",
        "-y",
        "-fflags",
        "+genpts+discardcorrupt",
        "-err_detect",
        "ignore_err",
        "-analyzeduration",
        "1000000",
        "-probesize",
        "1000000",
        "-f",
        "mpegts",
        "-i",
        "pipe:0",
        "-analyzeduration",
        "0",
        "-probesize",
        "32",
        "-f",
        "alaw",
        "-ar",
        "8000",
        "-ac",
        "1",
        "-i",
        "pipe:3",
        "-map",
        "0:v:0",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "50",
        "-sc_threshold",
        "0",
        "-map",
        "1:a:0",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-f",
        "mp4",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "/out/stream.mp4",
      ]
    `);
  });

  it('builds args with pcmu (mulaw) audio', () => {
    expect(buildPlaybackFfmpegArgs('/out/stream.mp4', { codec: 'pcmu', sampleRate: 8000 }))
      .toMatchInlineSnapshot(`
      [
        "-loglevel",
        "error",
        "-y",
        "-fflags",
        "+genpts+discardcorrupt",
        "-err_detect",
        "ignore_err",
        "-analyzeduration",
        "1000000",
        "-probesize",
        "1000000",
        "-f",
        "mpegts",
        "-i",
        "pipe:0",
        "-analyzeduration",
        "0",
        "-probesize",
        "32",
        "-f",
        "mulaw",
        "-ar",
        "8000",
        "-ac",
        "1",
        "-i",
        "pipe:3",
        "-map",
        "0:v:0",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "50",
        "-sc_threshold",
        "0",
        "-map",
        "1:a:0",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-f",
        "mp4",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "/out/stream.mp4",
      ]
    `);
  });

  it('inserts a seek before the input when seekOffsetSec > 0', () => {
    expect(buildPlaybackFfmpegArgs('/out/stream.mp4', undefined, 12)).toMatchInlineSnapshot(`
      [
        "-loglevel",
        "error",
        "-y",
        "-fflags",
        "+genpts+discardcorrupt",
        "-err_detect",
        "ignore_err",
        "-analyzeduration",
        "1000000",
        "-probesize",
        "1000000",
        "-ss",
        "12",
        "-f",
        "mpegts",
        "-i",
        "pipe:0",
        "-map",
        "0:v:0",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "50",
        "-sc_threshold",
        "0",
        "-f",
        "mp4",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "/out/stream.mp4",
      ]
    `);
  });

  it('omits the seek when seekOffsetSec is 0', () => {
    expect(buildPlaybackFfmpegArgs('/out/stream.mp4', undefined, 0)).toEqual(
      buildPlaybackFfmpegArgs('/out/stream.mp4'),
    );
  });
});
