import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHttpLiveFfmpegArgs } from '../electron/tapo/httpStream';
import {
  keyframeOnlyInputArgs,
  liveHwDecodeInputArgs,
  liveSegmentNames,
  liveVideoArgs,
} from '../electron/tapo/ffmpegFragments';
import { getLastHlsSegment, parseFfmpegVideoStream } from '../electron/tapo/streamHelpers';
import { chooseLiveVideoMode, copyFailedCameras } from '../electron/tapo/streamRegistry';
import { detectTsVideoCodec } from '../electron/tapo/tsDemux';

vi.mock('electron', () => {
  return {
    app: {
      isPackaged: true,
      getAppPath: vi.fn().mockReturnValue('/mocked/app/path'),
    },
  };
});

/** A 188-byte TS packet carrying one PSI section (pointer_field 0), padded with 0xFF. */
function psiPacket(pid: number, section: number[]): Buffer {
  const packet = Buffer.alloc(188, 0xff);
  packet[0] = 0x47;
  packet[1] = 0x40 | ((pid >> 8) & 0x1f); // payload_unit_start
  packet[2] = pid & 0xff;
  packet[3] = 0x10; // payload only
  packet[4] = 0x00; // pointer_field
  Buffer.from(section).copy(packet, 5);
  return packet;
}

/** PAT mapping program 1 → `pmtPid`. section_length = 5 header + 4 program + 4 CRC. */
function patPacket(pmtPid: number): Buffer {
  return psiPacket(0, [
    0x00,
    0xb0,
    13,
    0x00,
    0x01,
    0xc1,
    0x00,
    0x00,
    0x00,
    0x01,
    0xe0 | (pmtPid >> 8),
    pmtPid & 0xff,
    0,
    0,
    0,
    0,
  ]);
}

/** PMT listing the given elementary stream types (no descriptors). */
function pmtPacket(pmtPid: number, streamTypes: number[]): Buffer {
  const es = streamTypes.flatMap((type, i) => [type, 0xe1, i, 0xf0, 0x00]);
  const sectionLength = 9 + es.length + 4;
  return psiPacket(pmtPid, [
    0x02,
    0xb0,
    sectionLength,
    0x00,
    0x01,
    0xc1,
    0x00,
    0x00,
    0xe1,
    0x00,
    0xf0,
    0x00,
    ...es,
    0,
    0,
    0,
    0,
  ]);
}

describe('detectTsVideoCodec', () => {
  it('detects H.264 from the PMT', () => {
    const ts = Buffer.concat([patPacket(0x1000), pmtPacket(0x1000, [0x1b, 0x90])]);
    expect(detectTsVideoCodec(ts)).toBe('h264');
  });

  it('detects HEVC even when listed after the audio stream', () => {
    const ts = Buffer.concat([patPacket(0x1000), pmtPacket(0x1000, [0x91, 0x24])]);
    expect(detectTsVideoCodec(ts)).toBe('hevc');
  });

  it('resyncs past leading garbage', () => {
    const ts = Buffer.concat([Buffer.from([1, 2, 3]), patPacket(0x100), pmtPacket(0x100, [0x1b])]);
    expect(detectTsVideoCodec(ts)).toBe('h264');
  });

  it('returns null without a PMT', () => {
    expect(detectTsVideoCodec(patPacket(0x1000))).toBeNull();
    expect(detectTsVideoCodec(Buffer.alloc(0))).toBeNull();
  });
});

describe('parseFfmpegVideoStream', () => {
  it('parses codec and resolution from the input banner', () => {
    const stderr = [
      "Input #0, rtsp, from 'rtsp://cam/stream1':",
      '  Stream #0:0: Video: h264 (High), yuvj420p(pc, bt709, progressive), 3840x2160, 15 fps, 90k tbn',
      '  Stream #0:1: Audio: pcm_alaw, 8000 Hz, mono, s16, 64 kb/s',
      'At least one output file must be specified',
    ].join('\r\n');
    expect(parseFfmpegVideoStream(stderr)).toEqual({ codec: 'h264', width: 3840, height: 2160 });
  });

  it('handles stream ids with a language/id suffix', () => {
    expect(parseFfmpegVideoStream('Stream #0:0[0x100]: Video: hevc (Main), yuv420p, 2560x1440')).toEqual({
      codec: 'hevc',
      width: 2560,
      height: 1440,
    });
  });

  it('returns null when no video stream is present', () => {
    expect(parseFfmpegVideoStream('Connection refused')).toBeNull();
  });
});

describe('chooseLiveVideoMode', () => {
  afterEach(() => copyFailedCameras.clear());

  it('copies H.264 and transcodes anything else', () => {
    expect(chooseLiveVideoMode('cam', 'h264')).toBe('copy');
    expect(chooseLiveVideoMode('cam', 'hevc')).toBe('transcode');
    expect(chooseLiveVideoMode('cam', undefined)).toBe('transcode');
  });

  it('transcodes a camera whose passthrough already failed', () => {
    copyFailedCameras.add('cam');
    expect(chooseLiveVideoMode('cam', 'h264')).toBe('transcode');
    expect(chooseLiveVideoMode('other', 'h264')).toBe('copy');
  });
});

describe('live video fragments', () => {
  it('copy mode is a plain stream copy with no hw decode', () => {
    expect(liveVideoArgs('copy')).toEqual(['-c:v', 'copy']);
    expect(liveHwDecodeInputArgs('copy')).toEqual([]);
  });

  it('transcode mode caps height at 1080 and enables hw decode', () => {
    expect(liveVideoArgs('transcode').slice(0, 4)).toEqual([
      '-vf',
      "scale=-2:'min(ih,1080)'",
      '-c:v',
      'libx264',
    ]);
    expect(liveHwDecodeInputArgs('transcode')).toEqual(['-hwaccel', 'auto']);
  });

  it('keyframe-only snapshot input', () => {
    expect(keyframeOnlyInputArgs()).toEqual(['-skip_frame', 'nokey']);
  });

  it('HTTP live pipeline in copy mode neither scales nor encodes', () => {
    const args = buildHttpLiveFfmpegArgs({
      audioCodec: undefined,
      audioRate: 8000,
      segDir: '/seg',
      sessionToken: 'tok',
      m3u8: '/seg/stream.m3u8',
      videoMode: 'copy',
    });
    expect(args).toContain('copy');
    expect(args).not.toContain('libx264');
    expect(args).not.toContain('-hwaccel');
    expect(args).not.toContain('-vf');
  });
});

describe('getLastHlsSegment', () => {
  it('returns the newest segment resolved against the playlist dir', () => {
    const playlist = path.join('/hls', 'cam', 'stream.m3u8');
    const content = '#EXTM3U\n#EXTINF:1.0,\nsegment-001.ts\n#EXTINF:1.0,\nsegment-002.ts\n';
    expect(getLastHlsSegment(playlist, content)).toEqual({
      segment: path.resolve('/hls/cam', 'segment-002.ts'),
    });
  });

  it('includes the fMP4 init segment from EXT-X-MAP', () => {
    const playlist = path.join('/hls', 'cam', 'stream.m3u8');
    const content = [
      '#EXTM3U',
      '#EXT-X-MAP:URI="init-tok.mp4"',
      '#EXTINF:1.0,',
      'segment-tok-007.m4s',
      '',
    ].join('\n');
    expect(getLastHlsSegment(playlist, content)).toEqual({
      segment: path.resolve('/hls/cam', 'segment-tok-007.m4s'),
      init: path.resolve('/hls/cam', 'init-tok.mp4'),
    });
  });

  it('returns null for a playlist without segments', () => {
    expect(getLastHlsSegment('/hls/cam/stream.m3u8', '#EXTM3U\n')).toBeNull();
  });
});

describe('chooseLiveVideoMode with HEVC playback', () => {
  afterEach(() => copyFailedCameras.clear());

  it('passes HEVC through only when the renderer can play it', () => {
    expect(chooseLiveVideoMode('cam', 'hevc', true)).toBe('copy-hevc');
    expect(chooseLiveVideoMode('cam', 'hevc', false)).toBe('transcode');
    expect(chooseLiveVideoMode('cam', 'h264', true)).toBe('copy');
  });

  it('transcodes HEVC after a failed passthrough', () => {
    copyFailedCameras.add('cam');
    expect(chooseLiveVideoMode('cam', 'hevc', true)).toBe('transcode');
  });
});

describe('HEVC fMP4 live args', () => {
  it('tags hvc1 and muxes fMP4 segments with a per-session init file', () => {
    expect(liveVideoArgs('copy-hevc')).toEqual(['-c:v', 'copy', '-tag:v', 'hvc1']);
    expect(liveSegmentNames('copy-hevc', 'tok')).toEqual({
      segment: 'segment-tok-%03d.m4s',
      init: 'init-tok.mp4',
    });
    expect(liveSegmentNames('copy', 'tok')).toEqual({ segment: 'segment-tok-%03d.ts' });

    const args = buildHttpLiveFfmpegArgs({
      audioCodec: 'pcma',
      audioRate: 8000,
      segDir: '/seg',
      sessionToken: 'tok',
      m3u8: '/seg/stream.m3u8',
      videoMode: 'copy-hevc',
    }).map((a) => a.replace(/\\/g, '/'));
    expect(args.join(' ')).toContain(
      '-hls_segment_type fmp4 -hls_fmp4_init_filename init-tok.mp4 -hls_segment_filename /seg/segment-tok-%03d.m4s',
    );
    expect(args).not.toContain('-hwaccel');
  });
});
