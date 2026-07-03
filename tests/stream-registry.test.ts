import { afterEach, describe, expect, it } from 'vitest';
import { releaseStreamEntry, streams, type StreamEntry } from '../electron/tapo/streamRegistry';

function makeEntry(playlistPath: string): StreamEntry {
  return {
    proc: null,
    hlsUrl: 'http://127.0.0.1:1234/cam-1/stream-abc.m3u8',
    playlistPath,
    kind: 'live',
    readyResolved: true,
    lastHlsActivityAt: Date.now(),
    ready: Promise.resolve('http://127.0.0.1:1234/cam-1/stream-abc.m3u8'),
  };
}

describe('releaseStreamEntry', () => {
  afterEach(() => {
    streams.clear();
  });

  it('removes the entry and returns true when the playlist path matches', () => {
    streams.set('cam-1', makeEntry('/tmp/hls/cam-1/stream-abc.m3u8'));

    expect(releaseStreamEntry('cam-1', '/tmp/hls/cam-1/stream-abc.m3u8')).toBe(true);
    expect(streams.has('cam-1')).toBe(false);
  });

  it('leaves a newer session entry in place and returns false on mismatch', () => {
    const newer = makeEntry('/tmp/hls/cam-1/stream-new.m3u8');
    streams.set('cam-1', newer);

    // A stale cleanup handler from the previous session must not clobber it.
    expect(releaseStreamEntry('cam-1', '/tmp/hls/cam-1/stream-old.m3u8')).toBe(false);
    expect(streams.get('cam-1')).toBe(newer);
  });

  it('returns false when no entry is registered', () => {
    expect(releaseStreamEntry('cam-1', '/tmp/hls/cam-1/stream-abc.m3u8')).toBe(false);
  });

  it('does not touch entries of other cameras', () => {
    streams.set('cam-2', makeEntry('/tmp/hls/cam-2/stream-abc.m3u8'));

    expect(releaseStreamEntry('cam-1', '/tmp/hls/cam-2/stream-abc.m3u8')).toBe(false);
    expect(streams.has('cam-2')).toBe(true);
  });
});
