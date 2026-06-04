import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Hls, { ErrorTypes } from 'hls.js';
import type { CameraState } from '../types';
import { useCameraStore } from '../store/cameras';
import { createLogger } from '../log';
import {
  VolumeMutedIcon,
  VolumeLowIcon,
  VolumeHighIcon,
  EnterFullscreenIcon,
  ExitFullscreenIcon,
} from './icons';

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
    volume === 0 ? <VolumeMutedIcon /> : volume < 0.5 ? <VolumeLowIcon /> : <VolumeHighIcon />;

  const fullscreenIcon = isFullscreen ? <ExitFullscreenIcon /> : <EnterFullscreenIcon />;

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
