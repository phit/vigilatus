import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCameraStore } from '../src/store/cameras';
import type { CameraConfig } from '../src/types';
import { createTapoStudioMock, installTapoStudioMock } from './helpers/mockTapoStudio';

function resetStore(): void {
  useCameraStore.setState({
    cameras: [],
    selectedId: null,
    showPreviews: true,
    showTimeline: true,
    previewPosition: 'right',
    playbackMode: 'live',
    playbackTime: null,
    recordings: [],
    recordingsLoading: false,
    recordingsError: null,
  });
}

describe('useCameraStore', () => {
  beforeEach(() => {
    installTapoStudioMock(createTapoStudioMock());
    resetStore();
  });

  it('selects a camera and starts its stream', async () => {
    const mock = createTapoStudioMock();
    mock.stream.start.mockResolvedValueOnce('http://127.0.0.1/live.m3u8');
    installTapoStudioMock(mock);

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
    const mock = createTapoStudioMock();
    mock.recordings.play.mockResolvedValueOnce('blob:recording-playback');
    installTapoStudioMock(mock);

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