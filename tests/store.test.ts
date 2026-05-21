import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetRecordingsCache, useCameraStore } from '../src/store/cameras';
import type { CameraConfig } from '../src/types';
import { createVigilatusMock, installVigilatusMock } from './helpers/mockVigilatus';

function resetStore(): void {
  useCameraStore.setState({
    cameras: [],
    selectedId: null,
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
