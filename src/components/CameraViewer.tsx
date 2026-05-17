import { useEffect, useRef, useState } from 'react';
import Hls, { ErrorTypes } from 'hls.js';
import type { CameraState } from '../types';

interface Props {
  camera: CameraState | undefined;
  playbackMode: 'live' | 'playback';
}

export function CameraViewer({ camera, playbackMode }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);

  const hlsUrl = camera?.hlsUrl;
  const isHlsSource = Boolean(hlsUrl && hlsUrl.toLowerCase().includes('.m3u8'));
  const snapshot = camera?.snapshotDataUrl;
  const status = camera?.status ?? 'idle';

  useEffect(() => {
    setPlayerError(null);

    const video = videoRef.current;
    if (!video) return;

    // Clean up previous instance
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    video.src = '';

    if (!hlsUrl) return;

    if (!isHlsSource) {
      video.src = hlsUrl;
      video.play().catch(() => {
        setPlayerError('Playback failed to start');
      });
      return;
    }

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
      hls.on(Hls.Events.ERROR, (_event, data) => {
        console.error('[viewer:hls] error', data);
        if (!data.fatal) return;

        if (data.type === ErrorTypes.NETWORK_ERROR) {
          setPlayerError('Failed to load HLS stream from local server');
        } else if (data.type === ErrorTypes.MEDIA_ERROR) {
          setPlayerError('Browser could not decode the stream');
        } else {
          setPlayerError(data.details || 'HLS playback failed');
        }

        hls.destroy();
        hlsRef.current = null;
      });

      const onVideoError = () => {
        const mediaError = video.error;
        const message = mediaError
          ? `HTML5 video error ${mediaError.code}`
          : 'HTML5 video playback failed';
        console.error('[viewer:video] error', mediaError);
        setPlayerError(message);
      };

      video.addEventListener('error', onVideoError);
      return () => {
        video.removeEventListener('error', onVideoError);
        hls.destroy();
        hlsRef.current = null;
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = hlsUrl;
      video.play().catch(() => {
        setPlayerError('Native HLS playback failed');
      });
    }
  }, [hlsUrl, isHlsSource]);

  const label = camera?.config.name ?? 'No camera selected';

  const displayError = playerError ?? (status === 'error' ? camera?.errorMessage ?? 'Stream error' : null);

  return (
    <div className="viewer">
      {hlsUrl && !displayError ? (
        <video
          ref={videoRef}
          className="viewer-video"
          autoPlay
          muted
          playsInline
          controls={playbackMode === 'playback'}
        />
      ) : snapshot ? (
        <img src={snapshot} alt={label} className="viewer-snapshot" />
      ) : (
        <div className="viewer-placeholder">
          {status === 'connecting' && <div className="spinner" />}
          <span className="viewer-label">
            {status === 'connecting'
              ? 'Connecting…'
              : displayError
              ? displayError
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
