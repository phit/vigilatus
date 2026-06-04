import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Hls, { ErrorTypes } from 'hls.js';
import type { CameraState } from '../types';
import { useCameraStore } from '../store/cameras';
import { createLogger } from '../log';

interface VideoStats {
  resolution: string;
  codec: string;
  fps: number;
  bitrate: number;
}

interface Props {
  camera: CameraState | undefined;
  playbackMode: 'live' | 'playback';
}

export function CameraViewer({ camera, playbackMode }: Props) {
  const { t } = useTranslation();
  const viewerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [prevVolume, setPrevVolume] = useState(0.5);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [videoStats, setVideoStats] = useState<VideoStats | null>(null);
  const showDebugOverlay = useCameraStore((s) => s.showDebugOverlay);
  const volume = useCameraStore((s) => s.volume);
  const setVolume = useCameraStore((s) => s.setVolume);
  const playbackStartTime = useCameraStore((s) => s.playbackStartTime);
  const setPlaybackTime = useCameraStore((s) => s.setPlaybackTime);

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

  // Poll video stats for the debug overlay
  useEffect(() => {
    if (!showDebugOverlay) {
      setVideoStats(null);
      return;
    }

    const interval = setInterval(() => {
      const video = videoRef.current;
      const hls = hlsRef.current;
      if (!video || !hlsUrl) {
        setVideoStats(null);
        return;
      }

      const w = video.videoWidth;
      const h = video.videoHeight;
      const resolution = w && h ? `${w}×${h}` : '—';

      let codec = '—';
      let fps = 0;
      let bitrate = 0;

      if (hls) {
        const level = hls.levels?.[hls.currentLevel];
        if (level) {
          codec = level.codecSet || level.videoCodec || '—';
          fps = level.frameRate || 0;
          bitrate = Math.round((level.bitrate || 0) / 1000);
        }
      }

      // Fallback FPS from getVideoPlaybackQuality
      if (!fps && typeof video.getVideoPlaybackQuality === 'function') {
        const q = video.getVideoPlaybackQuality();
        if (q.totalVideoFrames > 0) {
          const elapsed = (performance.now() - (q as any).creationTime) / 1000;
          if (elapsed > 0) fps = Math.round(q.totalVideoFrames / elapsed);
        }
      }

      setVideoStats({ resolution, codec, fps, bitrate });
    }, 1000);

    return () => clearInterval(interval);
  }, [showDebugOverlay, hlsUrl]);

  useEffect(() => {
    setPlayerError(null);
    setIsPaused(false);

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
        createLogger('viewer:video').error('error', mediaError);
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
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 4,
        maxBufferLength: 4,
        backBufferLength: 8,
        maxLiveSyncPlaybackRate: 1.1,
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
        createLogger('viewer:hls').error('error', data);
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
        createLogger('viewer:video').error('error', mediaError);
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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const syncPlaybackTime = () => {
      if (playbackMode !== 'playback' || playbackStartTime == null) {
        return;
      }
      setPlaybackTime(playbackStartTime + Math.floor(video.currentTime * 1000));
    };

    video.addEventListener('timeupdate', syncPlaybackTime);
    video.addEventListener('seeking', syncPlaybackTime);
    video.addEventListener('loadedmetadata', syncPlaybackTime);

    return () => {
      video.removeEventListener('timeupdate', syncPlaybackTime);
      video.removeEventListener('seeking', syncPlaybackTime);
      video.removeEventListener('loadedmetadata', syncPlaybackTime);
    };
  }, [playbackMode, playbackStartTime, setPlaybackTime, hlsUrl]);

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

  const togglePause = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
      setIsPaused(false);
    } else {
      video.pause();
      setIsPaused(true);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (v > 0) setPrevVolume(v);
  };

  const volumeIcon =
    volume === 0 ? (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
        width="16"
        height="16"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M17.25 9.75 19.5 12m0 0 2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6 4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"
        />
      </svg>
    ) : volume < 0.5 ? (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
        width="16"
        height="16"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"
        />
      </svg>
    ) : (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
        width="16"
        height="16"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"
        />
      </svg>
    );

  const fullscreenIcon = isFullscreen ? (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      width="16"
      height="16"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25"
      />
    </svg>
  ) : (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      width="16"
      height="16"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15"
      />
    </svg>
  );

  const toggleFullscreen = async () => {
    const container = viewerRef.current;
    if (!container) return;

    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    await container.requestFullscreen();
  };

  return (
    <div className="viewer" ref={viewerRef}>
      {hlsUrl && !displayError ? (
        <>
          <video ref={videoRef} className="viewer-video" autoPlay muted={volume === 0} playsInline />
          <div className="viewer-controls">
            <button
              type="button"
              className="viewer-control-btn"
              onClick={togglePause}
              title={isPaused ? t('viewer.play') : t('viewer.pause')}
            >
              {isPaused ? '▶' : '⏸'}
            </button>
            <div className="volume-control">
              <button
                type="button"
                className="viewer-control-btn volume-btn"
                onClick={toggleMute}
                title={volume === 0 ? t('viewer.enableAudio') : t('viewer.muteAudio')}
              >
                {volumeIcon}
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
              {fullscreenIcon}
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

      {showDebugOverlay && videoStats && (
        <div className="viewer-debug-overlay">
          <span>{videoStats.resolution}</span>
          <span>{videoStats.codec}</span>
          <span>{videoStats.fps ? `${videoStats.fps} fps` : '— fps'}</span>
          <span>{videoStats.bitrate ? `${videoStats.bitrate} kbps` : '— kbps'}</span>
        </div>
      )}
    </div>
  );
}
