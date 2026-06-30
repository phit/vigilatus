import { useRef } from 'react';
import type { CameraState, LayoutTile } from '../types';
import { useCameraStore } from '../store/cameras';
import { CameraViewer } from './CameraViewer';
import { clampRect, toPixels } from './layoutGeometry';

interface Props {
  tile: LayoutTile;
  camera: CameraState;
  containerW: number;
  containerH: number;
  isFocused: boolean;
}

type DragMode = 'move' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se';

interface DragState {
  startX: number;
  startY: number;
  startRect: { x: number; y: number; w: number; h: number };
  mode: DragMode;
}

export function CameraTile({ tile, camera, containerW, containerH, isFocused }: Props) {
  const playbackMode = useCameraStore((s) => s.playbackMode);
  const startStream = useCameraStore((s) => s.startStream);
  const focusTile = useCameraStore((s) => s.focusTile);
  const moveTile = useCameraStore((s) => s.moveTile);
  const resizeTile = useCameraStore((s) => s.resizeTile);
  const bringToFront = useCameraStore((s) => s.bringToFront);
  const removeTile = useCameraStore((s) => s.removeTile);
  const setTileLocked = useCameraStore((s) => s.setTileLocked);
  const lockAllTiles = useCameraStore((s) => s.lockAllTiles);
  const unlockAllTiles = useCameraStore((s) => s.unlockAllTiles);
  const clearTiles = useCameraStore((s) => s.clearTiles);

  const dragState = useRef<DragState | null>(null);
  const px = toPixels(tile, containerW, containerH);

  const startDrag = (e: React.PointerEvent, mode: DragMode) => {
    if (tile.locked) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      startRect: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
      mode,
    };
  };

  const handleDragPointerMove = (e: React.PointerEvent) => {
    if (!dragState.current || tile.locked) return;
    const { startX, startY, startRect, mode } = dragState.current;
    const dxN = (e.clientX - startX) / containerW;
    const dyN = (e.clientY - startY) / containerH;

    let r = { ...startRect };
    if (mode === 'move') {
      r = { ...r, x: startRect.x + dxN, y: startRect.y + dyN };
    } else if (mode === 'resize-se') {
      r = { ...r, w: startRect.w + dxN, h: startRect.h + dyN };
    } else if (mode === 'resize-sw') {
      r = { ...r, x: startRect.x + dxN, w: startRect.w - dxN, h: startRect.h + dyN };
    } else if (mode === 'resize-ne') {
      r = { ...r, y: startRect.y + dyN, w: startRect.w + dxN, h: startRect.h - dyN };
    } else {
      // resize-nw
      r = { ...r, x: startRect.x + dxN, y: startRect.y + dyN, w: startRect.w - dxN, h: startRect.h - dyN };
    }
    r = clampRect(r);

    if (mode === 'move') {
      moveTile(tile.id, r);
    } else {
      resizeTile(tile.id, r);
    }
  };

  const handleDragPointerUp = () => {
    dragState.current = null;
  };

  const handleTileMouseDown = (e: React.MouseEvent) => {
    // Bring to front and focus on any click within the tile
    e.stopPropagation();
    bringToFront(tile.id);
    focusTile(tile.id);
  };

  const handleTileClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Start stream if the camera is idle and this tile is focused
    if (camera.status === 'idle' && !camera.hlsUrl) {
      void startStream(camera.config.id);
    }
  };

  const handleContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const action = await window.vigilatus.contextMenu.showTileContextMenu(tile.locked);
    if (action === 'lock') setTileLocked(tile.id, true);
    else if (action === 'unlock') setTileLocked(tile.id, false);
    else if (action === 'removeTile') removeTile(tile.id);
    else if (action === 'lockAll') lockAllTiles();
    else if (action === 'unlockAll') unlockAllTiles();
    else if (action === 'clearTiles') clearTiles();
  };

  return (
    <div
      className={`camera-tile${isFocused ? ' camera-tile--focused' : ''}${tile.locked ? ' camera-tile--locked' : ''}`}
      style={{
        position: 'absolute',
        left: px.left,
        top: px.top,
        width: px.width,
        height: px.height,
        zIndex: tile.z,
      }}
      onMouseDown={handleTileMouseDown}
      onClick={handleTileClick}
      onContextMenu={handleContextMenu}
    >
      {!tile.locked && (
        <div
          className="tile-titlebar"
          onPointerDown={(e) => startDrag(e, 'move')}
          onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerUp}
          onPointerCancel={handleDragPointerUp}
        />
      )}
      <div className="tile-content">
        <CameraViewer camera={camera} playbackMode={isFocused ? playbackMode : 'live'} />
      </div>
      {!tile.locked &&
        (['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
          <div
            key={corner}
            className={`tile-resize-${corner}`}
            onPointerDown={(e) => startDrag(e, `resize-${corner}`)}
            onPointerMove={handleDragPointerMove}
            onPointerUp={handleDragPointerUp}
            onPointerCancel={handleDragPointerUp}
          />
        ))}
    </div>
  );
}
