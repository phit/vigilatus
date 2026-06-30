import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRecordingsCache, useCameraStore } from '../src/store/cameras';
import type { CameraConfig } from '../src/types';
import { createVigilatusMock, installVigilatusMock } from './helpers/mockVigilatus';

function resetStore(): void {
  useCameraStore.setState({
    cameras: [],
    selectedId: null,
    layout: { tiles: [], focusedTileId: null },
    showPreviews: true,
    showTimeline: true,
    previewPosition: 'right',
    playbackMode: 'live',
    playbackTime: null,
    playbackStartTime: null,
    recordings: [],
    recordingEvents: [],
    recordingsLoading: false,
    recordingsError: null,
    notice: null,
  });
}

describe('useCameraStore', () => {
  beforeEach(() => {
    resetRecordingsCache();
    installVigilatusMock(createVigilatusMock());
    resetStore();
  });

  it('selects a camera and starts its stream', async () => {
    const mock = createVigilatusMock();
    mock.stream.start.mockResolvedValueOnce('http://127.0.0.1/live.m3u8');
    installVigilatusMock(mock);

    useCameraStore.setState({
      cameras: [
        {
          config: camera('cam-1'),
          status: 'idle',
        },
      ],
    });

    useCameraStore.getState().selectCamera('cam-1');

    await waitFor(() => expect(mock.stream.start).toHaveBeenCalledWith('cam-1'));
    expect(useCameraStore.getState().selectedId).toBe('cam-1');
    expect(useCameraStore.getState().cameras[0]?.status).toBe('live');
    expect(useCameraStore.getState().cameras[0]?.hlsUrl).toBe('http://127.0.0.1/live.m3u8');
  });

  it('reselects a live camera without restarting its stream', async () => {
    const mock = createVigilatusMock();
    installVigilatusMock(mock);

    useCameraStore.setState({
      cameras: [
        {
          config: camera('cam-1'),
          status: 'live',
          hlsUrl: 'http://127.0.0.1/live.m3u8',
        },
        {
          config: camera('cam-2', 'Side Yard'),
          status: 'idle',
        },
      ],
      selectedId: 'cam-2',
    });

    useCameraStore.getState().selectCamera('cam-1');

    expect(mock.stream.start).not.toHaveBeenCalled();
    expect(useCameraStore.getState().selectedId).toBe('cam-1');
    expect(useCameraStore.getState().cameras[0]?.status).toBe('live');
    expect(useCameraStore.getState().cameras[0]?.hlsUrl).toBe('http://127.0.0.1/live.m3u8');
  });

  it('promotes the next camera when the selected one is removed', async () => {
    useCameraStore.setState({
      cameras: [
        { config: camera('cam-a', 'Front Door'), status: 'idle' },
        { config: camera('cam-b', 'Back Patio'), status: 'idle' },
      ],
      selectedId: 'cam-b',
    });

    await useCameraStore.getState().removeCamera('cam-b');

    expect(useCameraStore.getState().cameras).toHaveLength(1);
    expect(useCameraStore.getState().cameras[0]?.config.id).toBe('cam-a');
    expect(useCameraStore.getState().selectedId).toBe('cam-a');
  });

  it('seeks into a recording clip and requests playback', async () => {
    const mock = createVigilatusMock();
    mock.recordings.play.mockResolvedValueOnce('blob:recording-playback');
    installVigilatusMock(mock);

    useCameraStore.setState({
      cameras: [{ config: camera('cam-1'), status: 'idle' }],
      selectedId: 'cam-1',
      recordings: [{ startTime: 100_000, endTime: 250_000 }],
    });

    await useCameraStore.getState().seekTo(150_000);

    expect(mock.recordings.play).toHaveBeenCalledWith('cam-1', 145_000, 250_000, 150_000, 100_000);
    expect(useCameraStore.getState().playbackMode).toBe('playback');
    expect(useCameraStore.getState().playbackTime).toBe(150_000);
    expect(useCameraStore.getState().cameras[0]?.hlsUrl).toBe('blob:recording-playback');
  });

  it('loads recording events alongside recordings', async () => {
    const mock = createVigilatusMock();
    mock.recordings.list.mockResolvedValueOnce([{ startTime: 100_000, endTime: 250_000 }]);
    mock.recordings.events.mockResolvedValueOnce([{ startTime: 120_000, endTime: 140_000, alarmType: 2 }]);
    installVigilatusMock(mock);

    await useCameraStore.getState().loadRecordings('cam-1', '20260521');

    expect(mock.recordings.list).toHaveBeenCalledWith('cam-1', '20260521');
    expect(mock.recordings.events).toHaveBeenCalledWith('cam-1', '20260521');
    expect(useCameraStore.getState().recordings).toEqual([{ startTime: 100_000, endTime: 250_000 }]);
    expect(useCameraStore.getState().recordingEvents).toEqual([
      { startTime: 120_000, endTime: 140_000, alarmType: 2 },
    ]);
  });

  it('reuses cached recordings for the same camera and date within the cooldown window', async () => {
    const mock = createVigilatusMock();
    mock.recordings.list.mockResolvedValue([{ startTime: 100_000, endTime: 250_000 }]);
    mock.recordings.events.mockResolvedValue([{ startTime: 120_000, endTime: 140_000, alarmType: 2 }]);
    installVigilatusMock(mock);

    await useCameraStore.getState().loadRecordings('cam-1', '20260521');
    await useCameraStore.getState().loadRecordings('cam-1', '20260521');

    expect(mock.recordings.list).toHaveBeenCalledTimes(1);
    expect(mock.recordings.events).toHaveBeenCalledTimes(1);
  });

  it('clears previous camera timeline data when switching to an uncached camera', async () => {
    const mock = createVigilatusMock();
    mock.stream.start.mockResolvedValue(null);
    installVigilatusMock(mock);

    useCameraStore.setState({
      recordings: [{ startTime: 100_000, endTime: 250_000 }],
      recordingEvents: [{ startTime: 120_000, endTime: 140_000, alarmType: 2 }],
    });

    useCameraStore.getState().selectCamera('cam-2');

    expect(useCameraStore.getState().recordings).toEqual([]);
    expect(useCameraStore.getState().recordingEvents).toEqual([]);
  });
});

describe('layout actions', () => {
  beforeEach(() => {
    resetRecordingsCache();
    installVigilatusMock(createVigilatusMock());
    resetStore();
  });

  it('addTile creates a tile and starts the stream', async () => {
    const mock = createVigilatusMock();
    mock.stream.start.mockResolvedValueOnce('http://127.0.0.1/live.m3u8');
    installVigilatusMock(mock);

    useCameraStore.setState({ cameras: [{ config: camera('cam-1'), status: 'idle' }] });

    useCameraStore.getState().addTile('cam-1');

    const { layout, selectedId } = useCameraStore.getState();
    expect(layout.tiles).toHaveLength(1);
    expect(layout.tiles[0]?.cameraId).toBe('cam-1');
    expect(layout.focusedTileId).toBe(layout.tiles[0]?.id);
    expect(selectedId).toBe('cam-1');
    await waitFor(() => expect(mock.stream.start).toHaveBeenCalledWith('cam-1'));
  });

  it('addTile with a position uses the given rect', () => {
    useCameraStore.setState({ cameras: [{ config: camera('cam-1'), status: 'idle' }] });

    useCameraStore.getState().addTile('cam-1', { x: 0.1, y: 0.2, w: 0.4, h: 0.4 });

    const tile = useCameraStore.getState().layout.tiles[0]!;
    expect(tile.x).toBeCloseTo(0.1);
    expect(tile.y).toBeCloseTo(0.2);
    expect(tile.w).toBeCloseTo(0.4);
    expect(tile.h).toBeCloseTo(0.4);
  });

  it('addTile with an existing camera focuses the existing tile instead of duplicating', () => {
    useCameraStore.setState({ cameras: [{ config: camera('cam-1'), status: 'idle' }] });

    const store = useCameraStore.getState();
    store.addTile('cam-1');
    const tileIdFirst = useCameraStore.getState().layout.tiles[0]?.id;

    store.addTile('cam-1');

    const { layout } = useCameraStore.getState();
    expect(layout.tiles).toHaveLength(1);
    expect(layout.focusedTileId).toBe(tileIdFirst);
  });

  it('removeTile removes the tile and stops the stream when no other tile uses the camera', async () => {
    const mock = createVigilatusMock();
    installVigilatusMock(mock);

    useCameraStore.setState({ cameras: [{ config: camera('cam-1'), status: 'live', hlsUrl: 'http://x' }] });

    useCameraStore.getState().addTile('cam-1');
    const tileId = useCameraStore.getState().layout.tiles[0]!.id;

    useCameraStore.getState().removeTile(tileId);

    const { layout, selectedId } = useCameraStore.getState();
    expect(layout.tiles).toHaveLength(0);
    expect(layout.focusedTileId).toBeNull();
    expect(selectedId).toBeNull();
    await waitFor(() => expect(mock.stream.stop).toHaveBeenCalledWith('cam-1'));
  });

  it('swapTileCamera replaces the camera and starts its stream', async () => {
    const mock = createVigilatusMock();
    mock.stream.start.mockResolvedValue('http://127.0.0.1/cam2.m3u8');
    installVigilatusMock(mock);

    useCameraStore.setState({
      cameras: [
        { config: camera('cam-1'), status: 'live', hlsUrl: 'http://x' },
        { config: camera('cam-2'), status: 'idle' },
      ],
    });

    useCameraStore.getState().addTile('cam-1');
    const tileId = useCameraStore.getState().layout.tiles[0]!.id;
    mock.stream.start.mockClear();

    useCameraStore.getState().swapTileCamera(tileId, 'cam-2');

    const { layout, selectedId } = useCameraStore.getState();
    expect(layout.tiles[0]?.cameraId).toBe('cam-2');
    expect(selectedId).toBe('cam-2');
    await waitFor(() => expect(mock.stream.start).toHaveBeenCalledWith('cam-2'));
    await waitFor(() => expect(mock.stream.stop).toHaveBeenCalledWith('cam-1'));
  });

  it('setTileLocked prevents moveTile from changing the rect', () => {
    useCameraStore.setState({ cameras: [{ config: camera('cam-1'), status: 'idle' }] });

    useCameraStore.getState().addTile('cam-1');
    const tileId = useCameraStore.getState().layout.tiles[0]!.id;
    const originalRect = { x: 0, y: 0, w: 1, h: 1 };

    useCameraStore.getState().setTileLocked(tileId, true);
    useCameraStore.getState().moveTile(tileId, { x: 0.2, y: 0.2, w: 0.5, h: 0.5 });

    const tile = useCameraStore.getState().layout.tiles[0]!;
    expect(tile.x).toBeCloseTo(originalRect.x);
    expect(tile.y).toBeCloseTo(originalRect.y);
  });

  it('removeCamera removes associated tiles and updates selectedId', async () => {
    useCameraStore.setState({
      cameras: [
        { config: camera('cam-a', 'Front Door'), status: 'idle' },
        { config: camera('cam-b', 'Back Patio'), status: 'idle' },
      ],
    });

    useCameraStore.getState().addTile('cam-a');
    useCameraStore.getState().addTile('cam-b');

    await useCameraStore.getState().removeCamera('cam-b');

    const { layout, selectedId } = useCameraStore.getState();
    expect(layout.tiles.every((t) => t.cameraId !== 'cam-b')).toBe(true);
    expect(selectedId).not.toBe('cam-b');
  });

  it('clearFocus during playback exits playback and restarts the live stream', async () => {
    const mock = createVigilatusMock();
    mock.stream.start.mockResolvedValue('http://127.0.0.1/live.m3u8');
    installVigilatusMock(mock);

    useCameraStore.setState({
      cameras: [{ config: camera('cam-1'), status: 'live', hlsUrl: 'blob:recording' }],
      selectedId: 'cam-1',
      layout: { tiles: [tileFor('cam-1')], focusedTileId: 'tile-cam-1' },
      playbackMode: 'playback',
      playbackTime: 150_000,
      playbackStartTime: 100_000,
    });

    useCameraStore.getState().clearFocus();

    const s = useCameraStore.getState();
    expect(s.playbackMode).toBe('live');
    expect(s.playbackTime).toBeNull();
    expect(s.playbackStartTime).toBeNull();
    expect(s.layout.focusedTileId).toBeNull();
    expect(s.selectedId).toBeNull();
    await waitFor(() => expect(mock.stream.start).toHaveBeenCalledWith('cam-1'));
  });

  it('clearFocus in live mode does not call goLive or restart the stream', () => {
    const mock = createVigilatusMock();
    installVigilatusMock(mock);

    useCameraStore.setState({
      cameras: [{ config: camera('cam-1'), status: 'live', hlsUrl: 'http://x' }],
      selectedId: 'cam-1',
      layout: { tiles: [tileFor('cam-1')], focusedTileId: 'tile-cam-1' },
      playbackMode: 'live',
    });

    useCameraStore.getState().clearFocus();

    const s = useCameraStore.getState();
    expect(s.playbackMode).toBe('live');
    expect(s.layout.focusedTileId).toBeNull();
    expect(s.selectedId).toBeNull();
    expect(mock.stream.start).not.toHaveBeenCalled();
  });

  it('addTile past MAX_CONCURRENT_TILES sets the tileCapReached notice', () => {
    useCameraStore.setState({
      cameras: [
        { config: camera('cam-1'), status: 'idle' },
        { config: camera('cam-2'), status: 'idle' },
        { config: camera('cam-3'), status: 'idle' },
        { config: camera('cam-4'), status: 'idle' },
        { config: camera('cam-5'), status: 'idle' },
      ],
    });

    useCameraStore.getState().addTile('cam-1');
    useCameraStore.getState().addTile('cam-2');
    useCameraStore.getState().addTile('cam-3');
    useCameraStore.getState().addTile('cam-4');

    expect(useCameraStore.getState().layout.tiles).toHaveLength(4);
    expect(useCameraStore.getState().notice).toBeNull();

    useCameraStore.getState().addTile('cam-5');

    expect(useCameraStore.getState().layout.tiles).toHaveLength(4);
    expect(useCameraStore.getState().notice).toBe('notices.tileCapReached');
  });
});

function tileFor(cameraId: string, id = `tile-${cameraId}`) {
  return { id, cameraId, x: 0, y: 0, w: 1, h: 1, z: 0, locked: false };
}

describe('scheduleStreamRestart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRecordingsCache();
    installVigilatusMock(createVigilatusMock());
    resetStore();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets retryAt immediately and calls stream.start after the initial 2 s delay', async () => {
    const mock = createVigilatusMock();
    mock.stream.start.mockResolvedValueOnce('http://127.0.0.1/live.m3u8');
    installVigilatusMock(mock);

    useCameraStore.setState({
      cameras: [{ config: camera('cam-1'), status: 'error' }],
      layout: { tiles: [tileFor('cam-1')], focusedTileId: 'tile-cam-1' },
    });

    const before = Date.now();
    useCameraStore.getState().scheduleStreamRestart('cam-1');

    expect(useCameraStore.getState().cameras[0]?.retryAt).toBe(before + 2_000);
    expect(mock.stream.start).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(mock.stream.start).toHaveBeenCalledWith('cam-1');
    expect(useCameraStore.getState().cameras[0]?.status).toBe('live');
    expect(useCameraStore.getState().cameras[0]?.retryAt).toBeUndefined();
  });

  it('does not restart if the camera is idle when the timer fires', async () => {
    const mock = createVigilatusMock();
    installVigilatusMock(mock);

    useCameraStore.setState({
      cameras: [{ config: camera('cam-1'), status: 'idle' }],
      layout: { tiles: [tileFor('cam-1')], focusedTileId: 'tile-cam-1' },
    });

    useCameraStore.getState().scheduleStreamRestart('cam-1');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mock.stream.start).not.toHaveBeenCalled();
  });

  it('reschedules with increased delay when the restart attempt fails', async () => {
    const mock = createVigilatusMock();
    mock.stream.start
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce('http://127.0.0.1/live.m3u8');
    installVigilatusMock(mock);

    useCameraStore.setState({
      cameras: [{ config: camera('cam-1'), status: 'error' }],
      layout: { tiles: [tileFor('cam-1')], focusedTileId: 'tile-cam-1' },
    });

    useCameraStore.getState().scheduleStreamRestart('cam-1');

    // First attempt fires at 2 000 ms — rejects, camera lands in 'error'
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mock.stream.start).toHaveBeenCalledTimes(1);

    // Second attempt fires at 2 000 * 1.2 = 2 400 ms — succeeds
    await vi.advanceTimersByTimeAsync(2_400);
    expect(mock.stream.start).toHaveBeenCalledTimes(2);
    expect(useCameraStore.getState().cameras[0]?.status).toBe('live');
  });

  it('does not enter the backoff loop for a camera that is not in any tile', async () => {
    const mock = createVigilatusMock();
    installVigilatusMock(mock);

    useCameraStore.setState({
      cameras: [{ config: camera('cam-1'), status: 'error' }],
      layout: { tiles: [], focusedTileId: null },
    });

    useCameraStore.getState().scheduleStreamRestart('cam-1');
    expect(useCameraStore.getState().cameras[0]?.retryAt).toBeUndefined();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.stream.start).not.toHaveBeenCalled();
  });

  it('HTTP removal race: removing the tile before the backoff fires cancels the restart', async () => {
    const mock = createVigilatusMock();
    installVigilatusMock(mock);

    useCameraStore.setState({
      cameras: [{ config: { ...camera('cam-1'), streamProtocol: 'http' }, status: 'live' }],
      layout: { tiles: [tileFor('cam-1')], focusedTileId: 'tile-cam-1' },
    });

    useCameraStore.getState().scheduleStreamRestart('cam-1');
    // Removing the tile defers the actual stopStream for an HTTP camera by
    // HTTP_STREAM_LINGER_MS — the camera is not yet 'idle' when the restart
    // timer below fires, so the membership check must be what blocks it.
    useCameraStore.getState().removeTile('tile-cam-1');
    expect(useCameraStore.getState().cameras[0]?.status).not.toBe('idle');

    await vi.advanceTimersByTimeAsync(2_000);

    expect(mock.stream.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(useCameraStore.getState().cameras[0]?.status).toBe('idle');
  });

  it('in-flight explicit stop cancels a pending restart timer', async () => {
    const mock = createVigilatusMock();
    installVigilatusMock(mock);

    useCameraStore.setState({
      cameras: [{ config: camera('cam-1'), status: 'error' }],
      layout: { tiles: [tileFor('cam-1')], focusedTileId: 'tile-cam-1' },
    });

    useCameraStore.getState().scheduleStreamRestart('cam-1');
    useCameraStore.getState().stopStream('cam-1');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(mock.stream.start).not.toHaveBeenCalled();
    expect(useCameraStore.getState().cameras[0]?.status).toBe('idle');
  });

  it('swapTileCamera: a restart pending for the swapped-out camera does not revive it', async () => {
    const mock = createVigilatusMock();
    mock.stream.start.mockResolvedValue('http://127.0.0.1/live.m3u8');
    installVigilatusMock(mock);

    // HTTP + live so swapTileCamera's stopCameraStream call defers the stop by
    // HTTP_STREAM_LINGER_MS instead of cancelling the backoff timer immediately —
    // this isolates the inView() membership check as what blocks the revival.
    useCameraStore.setState({
      cameras: [
        { config: { ...camera('cam-1'), streamProtocol: 'http' }, status: 'live' },
        { config: camera('cam-2', 'Side Yard'), status: 'idle' },
      ],
      layout: { tiles: [tileFor('cam-1')], focusedTileId: 'tile-cam-1' },
    });

    useCameraStore.getState().scheduleStreamRestart('cam-1');
    useCameraStore.getState().swapTileCamera('tile-cam-1', 'cam-2');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(mock.stream.start).not.toHaveBeenCalledWith('cam-1');
    expect(mock.stream.start).toHaveBeenCalledWith('cam-2');
  });
});

function camera(id: string, name = 'Camera'): CameraConfig {
  return {
    id,
    name,
    host: '192.168.1.100',
    username: 'admin',
    password: 'secret',
    streamUser: 'admin',
    streamPassword: 'stream-secret',
  };
}
