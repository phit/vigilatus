import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { TFunction } from 'i18next';
import Hls, { ErrorTypes } from 'hls.js';
import { createLogger } from '../log';

export interface VideoStats {
  resolution: string;
  codec: string;
  fps: number;
  bitrate: number;
}

interface VideoPlaybackQualityWithCreationTime extends VideoPlaybackQuality {
  creationTime?: number;
}

export function useFullscreen(containerRef: RefObject<HTMLDivElement | null>) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const toggleFullscreen = async () => {
    const container = containerRef.current;
    if (!container) return;

    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    await container.requestFullscreen();
  };

  return { isFullscreen, toggleFullscreen };
}

export function useVideoStats(
  videoRef: RefObject<HTMLVideoElement | null>,
  hlsRef: RefObject<Hls | null>,
  enabled: boolean,
  hlsUrl: string | undefined,
): VideoStats | null {
  const [videoStats, setVideoStats] = useState<VideoStats | null>(null);

  // Poll video stats for the debug overlay
  useEffect(() => {
    if (!enabled) return;

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
        const q: VideoPlaybackQualityWithCreationTime = video.getVideoPlaybackQuality();
        if (q.totalVideoFrames > 0) {
          const elapsed = (performance.now() - (q.creationTime ?? 0)) / 1000;
          if (elapsed > 0) fps = Math.round(q.totalVideoFrames / elapsed);
        }
      }

      setVideoStats({ resolution, codec, fps, bitrate });
    }, 1000);

    return () => clearInterval(interval);
  }, [enabled, hlsUrl, hlsRef, videoRef]);

  return enabled ? videoStats : null;
}

export function useHlsPlayer(
  videoRef: RefObject<HTMLVideoElement | null>,
  hlsRef: RefObject<Hls | null>,
  hlsUrl: string | undefined,
  isHlsSource: boolean,
  t: TFunction,
) {
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [prevSource, setPrevSource] = useState({ hlsUrl, isHlsSource });

  // Reset transient player state when the source changes. Done during render
  // (the React "adjust state on prop change" pattern) so it lands before the
  // setup effect runs — and avoids a synchronous setState inside the effect.
  if (prevSource.hlsUrl !== hlsUrl || prevSource.isHlsSource !== isHlsSource) {
    setPrevSource({ hlsUrl, isHlsSource });
    setPlayerError(null);
    setIsPaused(false);
  }

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

    const onVideoError = () => {
      const mediaError = video.error;
      const message = mediaError
        ? t('viewer.html5VideoError', { code: mediaError.code })
        : t('viewer.html5VideoFailed');
      createLogger('viewer:video').error('error', mediaError);
      setPlayerError(message);
    };

    if (!isHlsSource) {
      const startPlayback = () => {
        video.play().catch(() => {
          // Ignore early autoplay failures until the media pipeline has buffered enough data.
        });
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
  }, [hlsUrl, isHlsSource, t, hlsRef, videoRef]);

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

  return { playerError, isPaused, togglePause };
}

export function usePlaybackTimeSync(
  videoRef: RefObject<HTMLVideoElement | null>,
  playbackMode: 'live' | 'playback',
  playbackStartTime: number | null,
  setPlaybackTime: (time: number | null) => void,
  hlsUrl: string | undefined,
): void {
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
  }, [playbackMode, playbackStartTime, setPlaybackTime, hlsUrl, videoRef]);
}
