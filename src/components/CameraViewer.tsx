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
  const [isMuted, setIsMuted] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const hlsUrl = camera?.hlsUrl;
  const isHlsSource = Boolean(hlsUrl && hlsUrl.toLowerCase().includes('.m3u8'));
  const snapshot = camera?.snapshotDataUrl;
  const status = camera?.status ?? 'idle';
  const isPlaybackLoading = playbackMode === 'playback' && status === 'connecting' && !hlsUrl;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = isMuted;
    video.volume = isMuted ? 0 : 1;
  }, [isMuted, hlsUrl]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

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
      const startPlayback = () => {
        video.play().catch(() => {
          // Ignore early autoplay failures until the media pipeline has buffered enough data.
        });
      };

      const onVideoError = () => {
        const mediaError = video.error;
        const message = mediaError
          ? `HTML5 video error ${mediaError.code}`
          : 'HTML5 video playback failed';
        console.error('[viewer:video] error', mediaError);
        setPlayerError(message);
      };

      video.src = hlsUrl;
      video.load();
      video.addEventListener('loadedmetadata', startPlayback);
      video.addEventListener('canplay', startPlayback);
      video.addEventListener('error', onVideoError);
      return () => {
        video.removeEventListener('loadedmetadata', startPlayback);
        video.removeEventListener('canplay', startPlayback);
        video.removeEventListener('error', onVideoError);
      };
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode: true,
        enableWorker: true,
        // Retry quickly while stream is starting
        manifestLoadingMaxRetry: 120,
        manifestLoadingRetryDelay: 500,
        levelLoadingMaxRetry: 120,
        levelLoadingRetryDelay: 500,
        fragLoadingMaxRetry: 60,
        fragLoadingRetryDelay: 500,
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

  const toggleMute = () => {
    setIsMuted((value) => !value);
  };

  const toggleFullscreen = async () => {
    const video = videoRef.current;
    if (!video) return;

    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    await video.requestFullscreen();
  };

  return (
    <div className="viewer">
      {hlsUrl && !displayError ? (
        <>
          <video
            ref={videoRef}
            className="viewer-video"
            autoPlay
            muted={isMuted}
            playsInline
          />
          <div className="viewer-controls">
            <button
              type="button"
              className="viewer-control-btn"
              onClick={toggleMute}
              title={isMuted ? 'Enable audio' : 'Mute audio'}
            >
              {isMuted ? 'Unmute' : 'Mute'}
            </button>
            <button
              type="button"
              className="viewer-control-btn"
              onClick={() => void toggleFullscreen()}
              title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            >
              {isFullscreen ? 'Window' : 'Fullscreen'}
            </button>
          </div>
        </>
      ) : snapshot ? (
        <img src={snapshot} alt={label} className="viewer-snapshot" />
      ) : (
        <div className="viewer-placeholder">
          {status === 'connecting' && <div className="spinner" />}
          <span className="viewer-label">
            {status === 'connecting'
              ? isPlaybackLoading ? 'Loading recording...' : 'Connecting...'
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
