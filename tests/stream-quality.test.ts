import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCameraStore } from '../src/store/cameras';
import {
  desiredStreamQuality,
  maxTileHeightPx,
  pickStreamQuality,
  supportsSubStream,
} from '../src/streamQuality';
import type { CameraConfig, LayoutTile } from '../src/types';
import { createVigilatusMock, installVigilatusMock } from './helpers/mockVigilatus';

function cfg(overrides: Partial<CameraConfig> = {}): CameraConfig {
  return {
    id: 'cam-1',
    name: 'Cam 1',
    host: '10.0.0.5',
    username: 'admin',
    password: 'pw',
    streamUser: 'admin',
    streamPassword: 'pw',
    ...overrides,
  };
}

function tile(id: string, cameraId: string, h: number): LayoutTile {
  return { id, cameraId, x: 0, y: 0, w: 0.5, h, z: 1, locked: false } as LayoutTile;
}

const viewport = { w: 1600, h: 1000, dpr: 1 };

describe('supportsSubStream', () => {
  it('native RTSP has stream2; external sources need rtspSubUrl; HTTP has none', () => {
    expect(supportsSubStream(cfg())).toBe(true);
    expect(supportsSubStream(cfg({ rtspUrl: 'rtsp://proxy/cam' }))).toBe(false);
    expect(supportsSubStream(cfg({ rtspUrl: 'rtsp://proxy/cam', rtspSubUrl: 'rtsp://proxy/cam_sub' }))).toBe(
      true,
    );
    expect(supportsSubStream(cfg({ streamProtocol: 'http' }))).toBe(false);
  });
});

describe('maxTileHeightPx', () => {
  it('uses the tallest tile of the camera, in device pixels', () => {
    const tiles = [tile('a', 'cam-1', 0.3), tile('b', 'cam-1', 0.6), tile('c', 'cam-2', 1)];
    expect(maxTileHeightPx(tiles, 'cam-1', { ...viewport, dpr: 1.5 })).toBeCloseTo(900);
    expect(maxTileHeightPx(tiles, 'cam-3', viewport)).toBe(0);
  });
});

describe('pickStreamQuality', () => {
  it('applies hysteresis around the thresholds', () => {
    expect(pickStreamQuality(800, 'main')).toBe('main');
    expect(pickStreamQuality(800, 'sub')).toBe('sub');
    expect(pickStreamQuality(650, 'main')).toBe('sub');
    expect(pickStreamQuality(950, 'sub')).toBe('main');
  });

  it('splits the band in the middle when there is no current stream', () => {
    expect(pickStreamQuality(790, undefined)).toBe('sub');
    expect(pickStreamQuality(810, undefined)).toBe('main');
  });
});

describe('desiredStreamQuality', () => {
  it('falls back to main without a viewport or sub-stream', () => {
    const tiles = [tile('a', 'cam-1', 0.2)];
    expect(desiredStreamQuality(cfg(), tiles, null, undefined)).toBe('main');
    expect(desiredStreamQuality(cfg({ rtspUrl: 'rtsp://p/c' }), tiles, viewport, undefined)).toBe('main');
  });

  it('picks sub for a small tile and main for a large one', () => {
    expect(desiredStreamQuality(cfg(), [tile('a', 'cam-1', 0.4)], viewport, undefined)).toBe('sub');
    expect(desiredStreamQuality(cfg(), [tile('a', 'cam-1', 1)], viewport, undefined)).toBe('main');
  });
});

describe('store stream quality switching', () => {
  beforeEach(() => {
    useCameraStore.setState({
      cameras: [],
      selectedId: null,
      layout: { tiles: [], focusedTileId: null },
      playbackMode: 'live',
      viewport: null,
    });
  });

  it('starts with the quality matching the tile and restarts when the tile grows', async () => {
    const mock = createVigilatusMock();
    mock.stream.start.mockResolvedValue('http://127.0.0.1/live.m3u8');
    installVigilatusMock(mock);

    useCameraStore.setState({
      cameras: [{ config: cfg(), status: 'idle' }],
      layout: { tiles: [tile('t1', 'cam-1', 0.4)], focusedTileId: 't1' },
      viewport,
    });

    await useCameraStore.getState().startStream('cam-1');
    expect(mock.stream.start).toHaveBeenLastCalledWith('cam-1', { hevc: false, quality: 'sub' });

    // Within the hysteresis band: no switch.
    useCameraStore.setState({ layout: { tiles: [tile('t1', 'cam-1', 0.8)], focusedTileId: 't1' } });
    useCameraStore.getState().syncStreamQualities();
    expect(mock.stream.start).toHaveBeenCalledTimes(1);

    useCameraStore.setState({ layout: { tiles: [tile('t1', 'cam-1', 1)], focusedTileId: 't1' } });
    useCameraStore.getState().syncStreamQualities();
    expect(mock.stream.stop).toHaveBeenCalledWith('cam-1');
    await waitFor(() =>
      expect(mock.stream.start).toHaveBeenLastCalledWith('cam-1', { hevc: false, quality: 'main' }),
    );
    expect(useCameraStore.getState().cameras[0]?.streamQuality).toBe('main');
  });

  it('does not restart idle cameras', () => {
    const mock = createVigilatusMock();
    installVigilatusMock(mock);
    useCameraStore.setState({
      cameras: [{ config: cfg(), status: 'idle', streamQuality: 'main' }],
      layout: { tiles: [tile('t1', 'cam-1', 0.2)], focusedTileId: 't1' },
      viewport,
    });
    useCameraStore.getState().syncStreamQualities();
    expect(mock.stream.stop).not.toHaveBeenCalled();
    expect(mock.stream.start).not.toHaveBeenCalled();
  });
});
