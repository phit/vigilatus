import { useEffect, useRef } from 'react';
import Hls from 'hls.js';
import type { CameraState } from '../types';

interface Props {
  camera: CameraState | undefined;
  playbackMode: 'live' | 'playback';
}

export function CameraViewer({ camera, playbackMode }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const hlsUrl = camera?.hlsUrl;
  const snapshot = camera?.snapshotDataUrl;
  const status = camera?.status ?? 'idle';

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Clean up previous instance
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    video.src = '';

    if (!hlsUrl) return;

    if (Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode: true,
        enableWorker: true,
        // Retry quickly while stream is starting
        manifestLoadingMaxRetry: 20,
        manifestLoadingRetryDelay: 500,
        fragLoadingMaxRetry: 10,
      });
      hlsRef.current = hls;
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {/* autoplay may be blocked */});
      });
      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = hlsUrl;
      video.play().catch(() => {/* ignore */});
    }
  }, [hlsUrl]);

  const label = camera?.config.name ?? 'No camera selected';

  return (
    <div className="viewer">
      {hlsUrl ? (
        <video
          ref={videoRef}
          className="viewer-video"
          autoPlay
          muted
          playsInline
        />
      ) : snapshot ? (
        <img src={snapshot} alt={label} className="viewer-snapshot" />
      ) : (
        <div className="viewer-placeholder">
          {status === 'connecting' && <div className="spinner" />}
          <span className="viewer-label">
            {status === 'connecting'
              ? 'Connecting…'
              : status === 'error'
              ? camera?.errorMessage ?? 'Stream error'
              : status === 'offline'
              ? 'Camera offline'
              : camera
              ? 'Click to start stream'
              : 'Select a camera'}
          </span>
        </div>
      )}

      {camera && (
        <div className="viewer-overlay-meta">
          <span className="viewer-cam-name">{label}</span>
          <span className={`viewer-badge badge-${playbackMode === 'playback' ? 'playback' : status}`}>
            {playbackMode === 'playback' ? 'Playback' : status === 'live' ? 'Live' : status}
          </span>
        </div>
      )}
    </div>
  );
}
