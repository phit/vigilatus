import { create } from 'zustand';
import type {
  CameraConfig,
  CameraState,
  Recording,
  RecordingEvent,
  PlaybackMode,
  PreviewPosition,
} from '../types';
import { createLogger } from '../log';

const log = createLogger('cameras');

const PLAYBACK_PREROLL_MS = 5_000;
const PLAYBACK_WINDOW_MS = 120_000;
const RECORDINGS_CACHE_TTL_MS = 2 * 60_000;
const HTTP_STREAM_LINGER_MS = 60_000;

type RecordingsCacheEntry = {
  recordings: Recording[];
  recordingEvents: RecordingEvent[];
  fetchedAt: number;
};

const recordingsCache = new Map<string, RecordingsCacheEntry>();

function getRecordingsCacheKey(cameraId: string, date: string): string {
  return `${cameraId}:${date}`;
}

function getCurrentDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function getFreshRecordingsCache(cameraId: string, date: string): RecordingsCacheEntry | null {
  const cached = recordingsCache.get(getRecordingsCacheKey(cameraId, date));
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.fetchedAt >= RECORDINGS_CACHE_TTL_MS) {
    recordingsCache.delete(getRecordingsCacheKey(cameraId, date));
    return null;
  }
  return cached;
}

function clearRecordingsCache(cameraId: string): void {
  for (const key of Array.from(recordingsCache.keys())) {
    if (key.startsWith(`${cameraId}:`)) {
      recordingsCache.delete(key);
    }
  }
}

export function resetRecordingsCache(): void {
  recordingsCache.clear();
}

/** Pending timers to stop deselected HTTP streams after a grace period. */
const httpStopTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Renderer-side in-flight start operations keyed by camera id. */
const pendingStreamStarts = new Map<string, Promise<void>>();

interface CamerasStore {
  cameras: CameraState[];
  selectedId: string | null;
  showPreviews: boolean;
  showTimeline: boolean;
  showHeader: boolean;
  showDebugOverlay: boolean;
  previewPosition: PreviewPosition;
  playbackMode: PlaybackMode;
  playbackTime: number | null;
  playbackStartTime: number | null;
  recordings: Recording[];
  recordingEvents: RecordingEvent[];
  recordingsLoading: boolean;
  recordingsError: string | null;

  loadCameras(): Promise<void>;
  addCamera(cfg: CameraConfig): Promise<void>;
  updateCamera(id: string, updates: Partial<CameraConfig>): Promise<void>;
  removeCamera(id: string): Promise<void>;
  moveCamera(id: string, direction: 'up' | 'down'): Promise<void>;

  selectCamera(id: string): void;
  startStream(id: string): Promise<void>;
  stopStream(id: string): void;
  restartActiveStreams(): void;
  updateSnapshot(id: string, dataUrl: string): void;
  setStatus(id: string, status: CameraState['status'], error?: string): void;
  setRetryAt(id: string, retryAt?: number): void;

  togglePreviews(): void;
  setPreviewsVisible(visible: boolean): void;
  setTimelineVisible(visible: boolean): void;
  setHeaderVisible(visible: boolean): void;
  setDebugOverlayVisible(visible: boolean): void;
  setPreviewPosition(position: PreviewPosition): void;
  setVolume(volume: number): void;
  setPlaybackTime(time: number | null): void;
  volume: number;
  loadRecordings(cameraId: string, date: string): Promise<void>;
  seekTo(time: number): Promise<void>;
  goLive(): void;
}

export const useCameraStore = create<CamerasStore>((set, get) => {
  /** Patch a single camera (matched by config id) with new fields. */
  const patchCamera = (
    id: string,
    patch: Partial<CameraState> | ((cam: CameraState) => Partial<CameraState>),
  ) =>
    set((s) => ({
      cameras: s.cameras.map((c) =>
        c.config.id === id ? { ...c, ...(typeof patch === 'function' ? patch(c) : patch) } : c,
      ),
    }));

  return {
    cameras: [],
    selectedId: null,
    showPreviews: true,
    showTimeline: true,
    showHeader: true,
    showDebugOverlay: false,
    previewPosition: 'right',
    playbackMode: 'live',
    playbackTime: null,
    playbackStartTime: null,
    volume: 0,
    recordings: [],
    recordingEvents: [],
    recordingsLoading: false,
    recordingsError: null,

    // ------------------------------------------------------------------
    // Config operations
    // ------------------------------------------------------------------

    async loadCameras() {
      const configs = await window.vigilatus.cameras.getAll();
      set({
        cameras: configs.map((config) => ({ config, status: 'idle' })),
      });
    },

    async addCamera(cfg) {
      await window.vigilatus.cameras.add(cfg);
      await get().loadCameras();
    },

    async updateCamera(id, updates) {
      await window.vigilatus.cameras.update(id, updates);
      clearRecordingsCache(id);
      await get().loadCameras();
    },

    async removeCamera(id) {
      await window.vigilatus.cameras.remove(id);
      clearRecordingsCache(id);
      set((s) => {
        const cameras = s.cameras.filter((c) => c.config.id !== id);
        const selectedId = s.selectedId === id ? (cameras[0]?.config.id ?? null) : s.selectedId;
        return { cameras, selectedId };
      });
    },

    async moveCamera(id, direction) {
      await window.vigilatus.cameras.move(id, direction);
      await get().loadCameras();
    },

    // ------------------------------------------------------------------
    // Selection + streaming
    // ------------------------------------------------------------------

    selectCamera(id) {
      const cached = getFreshRecordingsCache(id, getCurrentDateString());
      const prevId = get().selectedId;
      set({
        selectedId: id,
        playbackMode: 'live',
        playbackTime: null,
        playbackStartTime: null,
        recordings: cached?.recordings ?? [],
        recordingEvents: cached?.recordingEvents ?? [],
        recordingsLoading: false,
        recordingsError: null,
      });

      // Cancel any pending stop for the newly selected camera
      const pending = httpStopTimers.get(id);
      if (pending) {
        clearTimeout(pending);
        httpStopTimers.delete(id);
      }

      // Schedule stop for the previously selected HTTP camera after a grace period
      if (prevId && prevId !== id) {
        const prev = get().cameras.find((c) => c.config.id === prevId);
        if (
          prev?.config.streamProtocol === 'http' &&
          (prev.status === 'live' || prev.status === 'connecting')
        ) {
          const timer = setTimeout(() => {
            httpStopTimers.delete(prevId);
            // Only stop if still not selected
            if (get().selectedId !== prevId) {
              get().stopStream(prevId);
            }
          }, HTTP_STREAM_LINGER_MS);
          httpStopTimers.set(prevId, timer);
        }
      }

      const selected = get().cameras.find((c) => c.config.id === id);
      if (!selected?.hlsUrl) {
        void get().startStream(id);
      }
    },

    async startStream(id) {
      const existingStart = pendingStreamStarts.get(id);
      patchCamera(id, (c) => ({
        status: 'connecting',
        hlsUrl: existingStart ? c.hlsUrl : undefined,
        errorMessage: undefined,
        retryAt: undefined,
      }));
      if (existingStart) {
        return existingStart;
      }

      const startPromise = window.vigilatus.stream
        .start(id)
        .then((hlsUrl) => {
          if (!hlsUrl) {
            patchCamera(id, {
              status: 'idle',
              hlsUrl: undefined,
              errorMessage: undefined,
              retryAt: undefined,
            });
            return;
          }

          patchCamera(id, { status: 'live', hlsUrl, errorMessage: undefined, retryAt: undefined });
        })
        .catch((e: unknown) => {
          const msg = (e as Error).message;
          if (msg.includes('Stream start cancelled')) {
            patchCamera(id, {
              status: 'idle',
              hlsUrl: undefined,
              errorMessage: undefined,
              retryAt: undefined,
            });
            return;
          }
          get().setStatus(id, 'error', msg);
        })
        .finally(() => {
          pendingStreamStarts.delete(id);
        });

      pendingStreamStarts.set(id, startPromise);
      return startPromise;
    },

    stopStream(id) {
      pendingStreamStarts.delete(id);
      void window.vigilatus.stream.stop(id);
      patchCamera(id, { status: 'idle', hlsUrl: undefined, errorMessage: undefined, retryAt: undefined });
    },

    restartActiveStreams() {
      const liveIds = get()
        .cameras.filter((c) => c.status === 'live' || c.status === 'connecting')
        .map((c) => c.config.id);
      if (liveIds.length === 0) return;
      log.info('restarting streams after resume:', liveIds);
      set((s) => ({
        cameras: s.cameras.map((c) =>
          liveIds.includes(c.config.id) ? { ...c, status: 'idle', hlsUrl: undefined } : c,
        ),
      }));
      for (const id of liveIds) {
        void get().startStream(id);
      }
    },

    updateSnapshot(id, dataUrl) {
      patchCamera(id, { snapshotDataUrl: dataUrl });
    },

    setStatus(id, status, error) {
      patchCamera(id, { status, errorMessage: error });
    },

    setRetryAt(id, retryAt) {
      patchCamera(id, { retryAt });
    },

    // ------------------------------------------------------------------
    // Preview strip
    // ------------------------------------------------------------------

    togglePreviews() {
      set((s) => ({ showPreviews: !s.showPreviews }));
    },

    setPreviewsVisible(visible) {
      set({ showPreviews: visible });
    },

    setTimelineVisible(visible) {
      set({ showTimeline: visible });
    },

    setHeaderVisible(visible) {
      set({ showHeader: visible });
    },

    setDebugOverlayVisible(visible) {
      set({ showDebugOverlay: visible });
    },

    setPreviewPosition(position) {
      set({ previewPosition: position });
    },

    setVolume(volume) {
      set({ volume });
      window.vigilatus.ui.saveVolume(volume);
    },

    setPlaybackTime(time) {
      set({ playbackTime: time });
    },

    // ------------------------------------------------------------------
    // Recordings + timeline
    // ------------------------------------------------------------------

    async loadRecordings(cameraId, date) {
      const cacheKey = getRecordingsCacheKey(cameraId, date);
      const cached = getFreshRecordingsCache(cameraId, date);
      if (cached) {
        set({
          recordings: cached.recordings,
          recordingEvents: cached.recordingEvents,
          recordingsLoading: false,
          recordingsError: null,
        });
        return;
      }

      set({ recordingsLoading: true, recordingsError: null });
      const maxRetries = 3;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const recs = await window.vigilatus.recordings.list(cameraId, date);
          const events = await window.vigilatus.recordings.events(cameraId, date).catch((error: unknown) => {
            createLogger(`recordings:events:${cameraId}`).warn(
              `failed for ${date}:`,
              (error as Error)?.message ?? String(error),
            );
            return [] as RecordingEvent[];
          });
          recordingsCache.set(cacheKey, {
            recordings: recs,
            recordingEvents: events,
            fetchedAt: Date.now(),
          });
          set({ recordings: recs, recordingEvents: events, recordingsLoading: false, recordingsError: null });
          return;
        } catch (e) {
          const msg = (e as Error)?.message ?? 'Failed to load recordings';
          if (attempt < maxRetries && msg.includes('unreachable')) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          set({
            recordings: [],
            recordingEvents: [],
            recordingsLoading: false,
            recordingsError: msg,
          });
        }
      }
    },

    async seekTo(time) {
      const { selectedId, recordings } = get();
      if (!selectedId) return;

      let clip = recordings.find((r) => time >= r.startTime && time <= r.endTime);
      if (!clip && recordings.length > 0) {
        // Snap to the nearest recording clip
        clip = recordings.reduce((best, r) => {
          const dist = Math.min(Math.abs(time - r.startTime), Math.abs(time - r.endTime));
          const bestDist = Math.min(Math.abs(time - best.startTime), Math.abs(time - best.endTime));
          return dist < bestDist ? r : best;
        });
        time = time < clip.startTime ? clip.startTime : clip.endTime - 1000;
      }
      if (!clip) {
        set({ playbackMode: 'live', playbackTime: null, playbackStartTime: null });
        return;
      }

      createLogger('cameras:seekTo').info('clip found:', {
        clickedTime: new Date(time).toISOString(),
        clipStart: new Date(clip.startTime).toISOString(),
        clipEnd: new Date(clip.endTime).toISOString(),
        clipStartMs: clip.startTime,
        clipEndMs: clip.endTime,
      });

      const requestedStartTime = Math.max(clip.startTime, time - PLAYBACK_PREROLL_MS);
      const requestedEndTime = Math.min(
        clip.endTime,
        Math.max(requestedStartTime + 15_000, requestedStartTime + PLAYBACK_WINDOW_MS),
      );

      set({ playbackMode: 'playback', playbackTime: time, playbackStartTime: requestedStartTime });

      // Clear live source immediately while recording clip is being prepared.
      // Do not stop the live process here because it can race with an in-flight
      // stream:start and surface SIGKILL as a start failure.
      patchCamera(selectedId, { hlsUrl: undefined, status: 'connecting', errorMessage: undefined });

      try {
        const playbackUrl = await window.vigilatus.recordings.play(
          selectedId,
          requestedStartTime,
          requestedEndTime,
          time,
          clip.startTime,
        );
        // Discard result if the user navigated away (clicked Live or a different clip)
        // while this long-running download was in flight.
        const s = get();
        if (s.playbackMode !== 'playback' || s.playbackStartTime !== requestedStartTime) return;
        patchCamera(selectedId, { hlsUrl: playbackUrl, status: 'live' });
      } catch (e) {
        // Discard error if the user navigated away while this was in flight.
        const s = get();
        if (s.playbackMode !== 'playback' || s.playbackStartTime !== requestedStartTime) return;
        const msg = (e as Error).message;
        get().setStatus(selectedId, 'error', msg || 'Failed to start recording playback');
        set({ playbackMode: 'live', playbackTime: null, playbackStartTime: null });
      }
    },

    goLive() {
      const { selectedId, playbackMode } = get();
      set({ playbackMode: 'live', playbackTime: null, playbackStartTime: null });
      if (selectedId) {
        if (playbackMode === 'live') {
          get().stopStream(selectedId);
        }
        void get().startStream(selectedId);
      }
    },
  };
});
