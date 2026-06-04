import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CameraConfig } from '../electron/types';
import {
  buildRtspUrl,
  createHlsSessionToken,
  getFirstHlsSegmentPath,
  summarizeFfmpegDetails,
  withRtspAuth,
} from '../electron/tapo/streamHelpers';

function makeCfg(overrides: Partial<CameraConfig> = {}): CameraConfig {
  return {
    id: 'cam1',
    name: 'Cam 1',
    host: '10.0.0.5',
    username: 'admin',
    password: 'apipass',
    streamUser: 'admin',
    streamPassword: 'streampass',
    ...overrides,
  };
}

describe('buildRtspUrl', () => {
  it('builds the main stream URL from camera credentials', () => {
    expect(buildRtspUrl(makeCfg(), 'main')).toBe('rtsp://admin:streampass@10.0.0.5:554/stream1');
  });

  it('uses stream2 for the sub stream', () => {
    expect(buildRtspUrl(makeCfg(), 'sub')).toBe('rtsp://admin:streampass@10.0.0.5:554/stream2');
  });

  it('url-encodes special characters in credentials', () => {
    const url = buildRtspUrl(makeCfg({ streamUser: 'a b', streamPassword: 'p@ss/w?rd' }), 'main');
    expect(url).toBe('rtsp://a%20b:p%40ss%2Fw%3Frd@10.0.0.5:554/stream1');
  });

  it('falls back to the API username/password when stream creds are empty', () => {
    const url = buildRtspUrl(makeCfg({ streamUser: '', streamPassword: '' }), 'main');
    expect(url).toBe('rtsp://admin:apipass@10.0.0.5:554/stream1');
  });

  it('uses an explicit rtspUrl with injected proxy auth when provided', () => {
    const url = buildRtspUrl(
      makeCfg({ rtspUrl: 'rtsp://proxy.local:8554/feed', rtspUsername: 'u', rtspPassword: 'p' }),
      'main',
    );
    expect(url).toBe('rtsp://u:p@proxy.local:8554/feed');
  });
});

describe('withRtspAuth', () => {
  it('injects username and password into the URL', () => {
    expect(withRtspAuth('rtsp://host:554/s', 'user', 'pass')).toBe('rtsp://user:pass@host:554/s');
  });

  it('returns the input unchanged when it is not a valid URL', () => {
    expect(withRtspAuth('not a url', 'user', 'pass')).toBe('not a url');
  });
});

describe('summarizeFfmpegDetails', () => {
  it('returns an empty string for empty input', () => {
    expect(summarizeFfmpegDetails('')).toBe('');
  });

  it('drops banner/version lines but keeps real error lines', () => {
    const input = [
      'ffmpeg version 6.0 Copyright (c) 2000',
      '  built with gcc 13',
      'configuration: --enable-gpl',
      'libavutil 58. 2.100',
      'Connection refused',
    ].join('\n');
    expect(summarizeFfmpegDetails(input)).toBe('Connection refused');
  });
});

describe('getFirstHlsSegmentPath', () => {
  it('resolves the first non-comment line relative to the playlist dir', () => {
    const playlist = path.join('/tmp', 'cam', 'stream.m3u8');
    const content = '#EXTM3U\n#EXT-X-VERSION:3\nsegment-0.ts\nsegment-1.ts\n';
    expect(getFirstHlsSegmentPath(playlist, content)).toBe(
      path.resolve(path.dirname(playlist), 'segment-0.ts'),
    );
  });

  it('returns null when there are no segment lines', () => {
    expect(getFirstHlsSegmentPath('/tmp/cam/stream.m3u8', '#EXTM3U\n#EXT-X-ENDLIST\n')).toBeNull();
  });
});

describe('createHlsSessionToken', () => {
  it('returns two base36 segments and is unique across calls', () => {
    const token = createHlsSessionToken();
    expect(token).toMatch(/^[a-z0-9]+-[a-z0-9]{1,6}$/);
    expect(createHlsSessionToken()).not.toBe(token);
  });
});
