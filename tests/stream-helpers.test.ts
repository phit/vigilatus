import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CameraConfig } from '../electron/types';
import {
  buildRtspUrl,
  createHlsSessionToken,
  getFirstHlsSegmentPath,
  summarizeFfmpegDetails,
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

  it('uses rtspSubUrl for the sub stream of an external source, else the main URL', () => {
    const ext = makeCfg({ rtspUrl: 'rtsp://proxy:8554/cam', rtspUsername: 'u', rtspPassword: 'p' });
    expect(buildRtspUrl(ext, 'sub')).toBe('rtsp://u:p@proxy:8554/cam');
    expect(buildRtspUrl({ ...ext, rtspSubUrl: 'rtsp://proxy:8554/cam_sub' }, 'sub')).toBe(
      'rtsp://u:p@proxy:8554/cam_sub',
    );
    expect(buildRtspUrl({ ...ext, rtspSubUrl: 'rtsp://proxy:8554/cam_sub' }, 'main')).toBe(
      'rtsp://u:p@proxy:8554/cam',
    );
  });

  it('url-encodes special characters in credentials', () => {
    const url = buildRtspUrl(makeCfg({ streamUser: 'a b', streamPassword: 'p@ss/w?rd' }), 'main');
    expect(url).toBe('rtsp://a%20b:p%40ss%2Fw%3Frd@10.0.0.5:554/stream1');
  });

  it('falls back to the API username/password when stream creds are empty', () => {
    const url = buildRtspUrl(makeCfg({ streamUser: '', streamPassword: '' }), 'main');
    expect(url).toBe('rtsp://admin:apipass@10.0.0.5:554/stream1');
  });

  it('passes an unparseable external rtspUrl through unchanged', () => {
    expect(
      buildRtspUrl(makeCfg({ rtspUrl: 'not a url', rtspUsername: 'u', rtspPassword: 'p' }), 'main'),
    ).toBe('not a url');
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
  it('is unique across calls and safe to embed in segment file names and URLs', () => {
    const token = createHlsSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9-]+$/);
    expect(createHlsSessionToken()).not.toBe(token);
  });
});
