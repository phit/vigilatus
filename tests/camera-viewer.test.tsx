import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CameraViewer } from '../src/components/CameraViewer';
import { useCameraStore } from '../src/store/cameras';
import type { CameraConfig, CameraState } from '../src/types';
import { createVigilatusMock, installVigilatusMock } from './helpers/mockVigilatus';

const config: CameraConfig = {
  id: 'cam-1',
  name: 'Front Door',
  host: '192.168.1.100',
  username: 'admin',
  password: 'secret',
  streamUser: 'admin',
  streamPassword: 'stream-secret',
};

describe('CameraViewer status badge', () => {
  let mock: ReturnType<typeof createVigilatusMock>;

  beforeEach(() => {
    mock = createVigilatusMock();
    mock.stream.start.mockResolvedValue('http://127.0.0.1/live.m3u8');
    installVigilatusMock(mock);
  });

  it.each<CameraState['status']>(['error', 'offline'])('restarts a %s stream when clicked', (status) => {
    const camera: CameraState = { config, status, errorMessage: 'boom' };
    useCameraStore.setState({ cameras: [camera], playbackMode: 'live' });

    const { container } = render(<CameraViewer camera={camera} playbackMode="live" />);
    const badge = container.querySelector('button.viewer-badge');
    expect(badge).not.toBeNull();
    fireEvent.click(badge!);

    expect(mock.stream.stop).toHaveBeenCalledWith('cam-1');
    expect(mock.stream.start).toHaveBeenCalledWith('cam-1', expect.anything());
  });

  it('is not a restart button during playback', () => {
    const camera: CameraState = { config, status: 'live' };
    const { container } = render(<CameraViewer camera={camera} playbackMode="playback" />);
    expect(container.querySelector('button.viewer-badge')).toBeNull();
  });
});
