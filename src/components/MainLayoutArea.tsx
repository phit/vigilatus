import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCameraStore } from '../store/cameras';
import { CameraTile } from './CameraTile';
import { CameraViewer } from './CameraViewer';

export function MainLayoutArea() {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 1, h: 1 });

  const layout = useCameraStore((s) => s.layout);
  const cameras = useCameraStore((s) => s.cameras);
  const playbackMode = useCameraStore((s) => s.playbackMode);
  const selectedId = useCameraStore((s) => s.selectedId);
  const addTile = useCameraStore((s) => s.addTile);
  const clearFocus = useCameraStore((s) => s.clearFocus);
  const lockAllTiles = useCameraStore((s) => s.lockAllTiles);
  const unlockAllTiles = useCameraStore((s) => s.unlockAllTiles);
  const clearTiles = useCameraStore((s) => s.clearTiles);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        setContainerSize({ w: width, h: height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const cameraId = e.dataTransfer.getData('cameraId');
    if (!cameraId) return;

    const rect = containerRef.current!.getBoundingClientRect();
    const { w, h } = containerSize;
    const TILE_W = 0.5;
    const TILE_H = 0.5;
    const normX = Math.max(0, Math.min(1 - TILE_W, (e.clientX - rect.left) / w - TILE_W / 2));
    const normY = Math.max(0, Math.min(1 - TILE_H, (e.clientY - rect.top) / h - TILE_H / 2));

    addTile(cameraId, { x: normX, y: normY, w: TILE_W, h: TILE_H });
  };

  const handleAreaClick = (e: React.MouseEvent) => {
    if (e.target === containerRef.current) {
      clearFocus();
    }
  };

  const handleAreaContextMenu = async (e: React.MouseEvent) => {
    if (e.target !== containerRef.current) return;
    e.preventDefault();
    const action = await window.vigilatus.contextMenu.showLayoutContextMenu();
    if (action === 'lockAll') lockAllTiles();
    else if (action === 'unlockAll') unlockAllTiles();
    else if (action === 'clearTiles') clearTiles();
  };

  const selectedCamera = cameras.find((c) => c.config.id === selectedId);

  return (
    <div
      ref={containerRef}
      className="main-layout"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={handleAreaClick}
      onContextMenu={(e) => void handleAreaContextMenu(e)}
    >
      {playbackMode === 'playback' && selectedCamera ? (
        <div className="tile-content">
          <CameraViewer camera={selectedCamera} playbackMode="playback" />
        </div>
      ) : (
        <>
          {/* Render in stable array order — stacking is done purely via each tile's
              z-index. Sorting here would make React move the tile DOM nodes when a
              tile is raised (focus click → bringToFront), and relocating a playing
              <video> element causes a visible flicker. */}
          {layout.tiles.map((tile) => {
            const camera = cameras.find((c) => c.config.id === tile.cameraId);
            if (!camera) return null;
            return (
              <CameraTile
                key={tile.id}
                tile={tile}
                camera={camera}
                containerW={containerSize.w}
                containerH={containerSize.h}
                isFocused={layout.focusedTileId === tile.id}
              />
            );
          })}
          {layout.tiles.length === 0 && (
            <div className="main-layout-empty">
              <p>{t('viewer.dragCameraHere')}</p>
              <p className="main-layout-empty-sub">{t('viewer.addCameraFromPreview')}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
