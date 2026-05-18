import { useEffect, useRef, useState } from 'react';
import type { CameraState } from '../types';

interface Props {
  camera: CameraState;
  isSelected: boolean;
  playbackMode: 'live' | 'playback';
  onSelect(): void;
}

const REFRESH_BASE_MS = 5000;

export function CameraPreview({ camera, isSelected, playbackMode, onSelect }: Props) {
  const [snapshot, setSnapshot] = useState<string | null>(camera.snapshotDataUrl ?? null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      if (cancelled) return;
      try {
        const data = await window.tapoStudio.snapshot.get(camera.config.id);
        if (!cancelled && data) {
          setSnapshot(data);
        }
      } catch {
        /* camera offline — keep last snapshot */
      }
      if (!cancelled) {
        // Stagger: add small jitter so all cameras don't hit ffmpeg at once
        const jitter = Math.random() * 2000;
        timerRef.current = setTimeout(refresh, REFRESH_BASE_MS + jitter);
      }
    };

    void refresh();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [camera.config.id]);

  const { name } = camera.config;
  const { status } = camera;
  const statusLabel = (playbackMode === 'playback' && isSelected && status === 'connecting' && !camera.hlsUrl)
    ? 'Loading recording...'
    : status;

  return (
    <button
      type="button"
      className={`preview-card${isSelected ? ' preview-card--selected' : ''}`}
      onClick={onSelect}
      title={`Switch to ${name}`}
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
