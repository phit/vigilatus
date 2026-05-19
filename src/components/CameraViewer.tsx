import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Hls, { ErrorTypes } from 'hls.js';
import type { CameraState } from '../types';

interface Props {
  camera: CameraState | undefined;
  playbackMode: 'live' | 'playback';
}

export function CameraViewer({ camera, playbackMode }: Props) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [volume, setVolume] = useState(0);
  const [prevVolume, setPrevVolume] = useState(0.5);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const hlsUrl = camera?.hlsUrl;
  const isHlsSource = Boolean(hlsUrl && hlsUrl.toLowerCase().includes('.m3u8'));
  const snapshot = camera?.snapshotDataUrl;
  const status = camera?.status ?? 'idle';
  const isPlaybackLoading = playbackMode === 'playback' && status === 'connecting' && !hlsUrl;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = volume === 0;
    video.volume = volume;
  }, [volume, hlsUrl]);

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
          ? t('viewer.html5VideoError', { code: mediaError.code })
          : t('viewer.html5VideoFailed');
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
        video.play().catch(() => {
          /* autoplay may be blocked */
        });
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        console.error('[viewer:hls] error', data);
        if (!data.fatal) return;

        if (data.type === ErrorTypes.NETWORK_ERROR) {
          setPlayerError(t('viewer.hlsNetworkError'));
        } else if (data.type === ErrorTypes.MEDIA_ERROR) {
          setPlayerError(t('viewer.hlsMediaError'));
        } else {
          setPlayerError(data.details || t('viewer.hlsGenericError'));
        }

        hls.destroy();
        hlsRef.current = null;
      });

      const onVideoError = () => {
        const mediaError = video.error;
        const message = mediaError
          ? t('viewer.html5VideoError', { code: mediaError.code })
          : t('viewer.html5VideoFailed');
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
        setPlayerError(t('viewer.nativeHlsError'));
      });
    }
  }, [hlsUrl, isHlsSource, t]);

  const label = camera?.config.name ?? t('viewer.noCamera');

  const displayError =
    playerError ?? (status === 'error' ? (camera?.errorMessage ?? t('viewer.streamError')) : null);

  const toggleMute = () => {
    if (volume > 0) {
      setPrevVolume(volume);
      setVolume(0);
    } else {
      setVolume(prevVolume || 0.5);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (v > 0) setPrevVolume(v);
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
          <video ref={videoRef} className="viewer-video" autoPlay muted={volume === 0} playsInline />
          <div className="viewer-controls">
            <div className="volume-control">
              <button
                type="button"
                className="viewer-control-btn volume-btn"
                onClick={toggleMute}
                title={volume === 0 ? t('viewer.enableAudio') : t('viewer.muteAudio')}
              >
                {volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
              </button>
              <input
                type="range"
                className="volume-slider"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                onChange={handleVolumeChange}
                title={t('viewer.volume')}
              />
            </div>
            <button
              type="button"
              className="viewer-control-btn"
              onClick={() => void toggleFullscreen()}
              title={isFullscreen ? t('viewer.exitFullscreen') : t('viewer.enterFullscreen')}
            >
              {isFullscreen ? t('viewer.window') : t('viewer.fullscreen')}
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
              ? isPlaybackLoading
                ? t('viewer.loadingRecording')
                : t('viewer.connecting')
              : displayError
                ? displayError
                : status === 'offline'
                  ? t('viewer.cameraOffline')
                  : camera
                    ? t('viewer.clickToStart')
                    : t('viewer.selectCamera')}
          </span>
        </div>
      )}

      {camera && (
        <div className="viewer-overlay-meta">
          <span className="viewer-cam-name">{label}</span>
          <span className={`viewer-badge badge-${playbackMode === 'playback' ? 'playback' : status}`}>
            {playbackMode === 'playback'
              ? t('viewer.playback')
              : status === 'live'
                ? t('viewer.live')
                : status}
          </span>
        </div>
      )}
    </div>
  );
}
