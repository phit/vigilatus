import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MainLayoutArea } from '../src/components/MainLayoutArea';
import { useCameraStore } from '../src/store/cameras';
import type { CameraConfig, LayoutTile } from '../src/types';
import { createVigilatusMock, installVigilatusMock } from './helpers/mockVigilatus';

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

function tileFor(cameraId: string, z: number): LayoutTile {
  return { id: `tile-${cameraId}`, cameraId, x: 0, y: 0, w: 0.5, h: 0.5, z, locked: false };
}

describe('MainLayoutArea tile stacking', () => {
  beforeEach(() => {
    installVigilatusMock(createVigilatusMock());
    useCameraStore.setState({
      cameras: [
        { config: camera('cam-a', 'Front Door'), status: 'idle' },
        { config: camera('cam-b', 'Back Patio'), status: 'idle' },
      ],
      selectedId: 'cam-b',
      layout: {
        tiles: [tileFor('cam-a', 1), tileFor('cam-b', 2)],
        focusedTileId: 'tile-cam-b',
      },
      playbackMode: 'live',
    });
  });

  it('raises a tile via z-index without reordering the tile DOM nodes', () => {
    const { container } = render(<MainLayoutArea />);
    const before = Array.from(container.querySelectorAll('.camera-tile'));
    expect(before).toHaveLength(2);

    act(() => {
      // Focus switch to the back tile: what a click on a tile triggers.
      useCameraStore.getState().bringToFront('tile-cam-a');
      useCameraStore.getState().focusTile('tile-cam-a');
    });

    // Same nodes in the same document order — moving a tile's DOM node would
    // relocate its <video> element and cause a visible flicker. The raised
    // tile must win the stacking purely through its z-index.
    const after = Array.from(container.querySelectorAll('.camera-tile'));
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect((after[0] as HTMLElement).style.zIndex).toBe('3');
    expect((after[1] as HTMLElement).style.zIndex).toBe('2');
    expect(after[0]?.classList.contains('camera-tile--focused')).toBe(true);
  });
});
