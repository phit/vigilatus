import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type Hls from 'hls.js';
import type { CameraState } from '../types';
import { useCameraStore } from '../store/cameras';
import { useFullscreen, useHlsPlayer, usePlaybackTimeSync, useVideoStats } from './cameraViewerHooks';
import {
  VolumeMutedIcon,
  VolumeLowIcon,
  VolumeHighIcon,
  EnterFullscreenIcon,
  ExitFullscreenIcon,
} from './icons';

interface Props {
  camera: CameraState | undefined;
  playbackMode: 'live' | 'playback';
}

export function CameraViewer({ camera, playbackMode }: Props) {
  const { t } = useTranslation();
  const viewerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [prevVolume, setPrevVolume] = useState(0.5);
  const [retryTick, setRetryTick] = useState(0);
  const showDebugOverlay = useCameraStore((s) => s.showDebugOverlay);
  const setCameraVolume = useCameraStore((s) => s.setCameraVolume);
  const restartStream = useCameraStore((s) => s.restartStream);
  const playbackStartTime = useCameraStore((s) => s.playbackStartTime);
  const setPlaybackTime = useCameraStore((s) => s.setPlaybackTime);

  const cameraId = camera?.config.id;
  const volume = camera?.config.volume ?? 0;
  const setVolume = (v: number) => {
    if (cameraId) setCameraVolume(cameraId, v);
  };

  const hlsUrl = camera?.hlsUrl;
  const isHlsSource = Boolean(hlsUrl && hlsUrl.toLowerCase().includes('.m3u8'));
  const snapshot = camera?.snapshotDataUrl;
  const status = camera?.status ?? 'idle';
  const isPlaybackLoading = playbackMode === 'playback' && status === 'connecting' && !hlsUrl;
  const retryAt = camera?.retryAt;

  useEffect(() => {
    if (status !== 'error' || !retryAt) return;

    const update = () => setRetryTick(Date.now());
    const initialTimer = setTimeout(update, 0);
    const timer = setInterval(() => {
      update();
    }, 1000);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(timer);
    };
  }, [retryAt, status]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = volume === 0;
    video.volume = volume;
  }, [volume, hlsUrl]);

  const { isFullscreen, toggleFullscreen } = useFullscreen(viewerRef);
  const { playerError, isPaused, togglePause, videoCodecRef } = useHlsPlayer(
    videoRef,
    hlsRef,
    hlsUrl,
    isHlsSource,
    t,
  );
  const videoStats = useVideoStats(videoRef, hlsRef, showDebugOverlay, hlsUrl, videoCodecRef);
  usePlaybackTimeSync(videoRef, playbackMode, playbackStartTime, setPlaybackTime, hlsUrl);

  const label = camera?.config.name ?? t('viewer.noCamera');

  const retrySeconds =
    status === 'error' && retryAt
      ? Math.max(1, Math.ceil((retryAt - (retryTick || retryAt - 1000)) / 1000))
      : null;

  const displayError =
    playerError ??
    (status === 'error'
      ? retrySeconds
        ? t('viewer.retrying', { seconds: retrySeconds })
        : (camera?.errorMessage ?? t('viewer.streamError'))
      : null);

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

  const volumeIcon =
    volume === 0 ? <VolumeMutedIcon /> : volume < 0.5 ? <VolumeLowIcon /> : <VolumeHighIcon />;

  const fullscreenIcon = isFullscreen ? <ExitFullscreenIcon /> : <EnterFullscreenIcon />;

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
              : retrySeconds
                ? t('viewer.retrying', { seconds: retrySeconds })
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
          {playbackMode === 'live' && status === 'live' && cameraId ? (
            <button
              type="button"
              className="viewer-badge badge-live"
              onClick={() => restartStream(cameraId)}
              title={t('viewer.restartStream')}
            >
              {t('viewer.live')}
            </button>
          ) : (
            <span
              className={`viewer-badge badge-${playbackMode === 'playback' ? 'playback' : status}`}
            >
              {playbackMode === 'playback'
                ? t('viewer.playback')
                : status === 'live'
                  ? t('viewer.live')
                  : status}
            </span>
          )}
        </div>
      )}

      {showDebugOverlay && videoStats && (
        <div className="viewer-debug-overlay">
          <span>{videoStats.resolution}</span>
          <span>{videoStats.codec}</span>
          <span>{videoStats.fps ? `${videoStats.fps} fps` : '— fps'}</span>
        </div>
      )}
    </div>
  );
}
