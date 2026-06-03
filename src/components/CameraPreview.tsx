import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CameraState } from '../types';

interface Props {
  camera: CameraState;
  isSelected: boolean;
  isFirst: boolean;
  isLast: boolean;
  playbackMode: 'live' | 'playback';
  onSelect(): void;
  onEdit(): void;
  onRemove(): void;
  onMoveUp(): void;
  onMoveDown(): void;
}

const REFRESH_BASE_MS = 20_000;
const REFRESH_HTTP_BASE_MS = 120_000; // 2 minutes for battery-powered HTTP cameras

export function CameraPreview({
  camera,
  isSelected,
  isFirst,
  isLast,
  playbackMode,
  onSelect,
  onEdit,
  onRemove,
  onMoveUp,
  onMoveDown,
}: Props) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<string | null>(camera.snapshotDataUrl ?? null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHttp = camera.config.streamProtocol === 'http';

  useEffect(() => {
    // When selected, the stream is active — pause polling for HTTP cameras
    // (the backend grabs from HLS anyway, but no point waking the camera).
    if (isHttp && isSelected) return;

    let cancelled = false;
    const interval = isHttp ? REFRESH_HTTP_BASE_MS : REFRESH_BASE_MS;

    const refresh = async () => {
      if (cancelled) return;
      try {
        const data = await window.vigilatus.snapshot.get(camera.config.id);
        if (!cancelled && data) {
          setSnapshot(data);
        }
      } catch {
        /* camera offline — keep last snapshot */
      }
      if (!cancelled) {
        // Stagger: add small jitter so all cameras don't hit ffmpeg at once
        const jitter = Math.random() * 2000;
        timerRef.current = setTimeout(refresh, interval + jitter);
      }
    };

    void refresh();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [camera.config.id, isHttp, isSelected]);

  const { name } = camera.config;
  const { status } = camera;
  const statusLabel =
    playbackMode === 'playback' && isSelected && status === 'connecting' && !camera.hlsUrl
      ? t('preview.loadingRecording')
      : status;

  const handleContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const action = await window.vigilatus.contextMenu.showCameraMenu(isFirst, isLast);
    if (action === 'moveUp') onMoveUp();
    else if (action === 'moveDown') onMoveDown();
    else if (action === 'edit') onEdit();
    else if (action === 'remove') onRemove();
  };

  return (
    <button
      type="button"
      className={`preview-card${isSelected ? ' preview-card--selected' : ''}`}
      onClick={onSelect}
      onContextMenu={handleContextMenu}
      title={t('preview.switchTo', { name })}
    >
      <div className="preview-thumb">
        {snapshot ? (
          <img src={snapshot} alt={name} className="preview-img" />
        ) : (
          <div className="preview-empty">
            {status === 'connecting' ? <div className="spinner spinner--sm" /> : '—'}
          </div>
        )}
      </div>
      <div className="preview-footer">
        <span className="preview-name">{name}</span>
        <span className={`preview-dot dot-${status}`} title={statusLabel} />
      </div>
    </button>
  );
}
