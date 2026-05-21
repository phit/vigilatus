import { create } from 'zustand';
import type {
  CameraConfig,
  CameraState,
  Recording,
  RecordingEvent,
  PlaybackMode,
  PreviewPosition,
} from '../types';

const PLAYBACK_PREROLL_MS = 5_000;
const PLAYBACK_WINDOW_MS = 120_000;
const RECORDINGS_CACHE_TTL_MS = 2 * 60_000;

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
  recordings: Recording[];
  recordingEvents: RecordingEvent[];
  recordingsLoading: boolean;
  recordingsError: string | null;

  loadCameras(): Promise<void>;
  addCamera(cfg: CameraConfig): Promise<void>;
  updateCamera(id: string, updates: Partial<CameraConfig>): Promise<void>;
  removeCamera(id: string): Promise<void>;

  selectCamera(id: string): void;
  startStream(id: string): Promise<void>;
  stopStream(id: string): void;
  restartActiveStreams(): void;
  updateSnapshot(id: string, dataUrl: string): void;
  setStatus(id: string, status: CameraState['status'], error?: string): void;

  togglePreviews(): void;
  setPreviewsVisible(visible: boolean): void;
  setTimelineVisible(visible: boolean): void;
  setHeaderVisible(visible: boolean): void;
  setDebugOverlayVisible(visible: boolean): void;
  setPreviewPosition(position: PreviewPosition): void;
  setVolume(volume: number): void;
  volume: number;
  loadRecordings(cameraId: string, date: string): Promise<void>;
  seekTo(time: number): Promise<void>;
  goLive(): void;
}

export const useCameraStore = create<CamerasStore>((set, get) => ({
  cameras: [],
  selectedId: null,
  showPreviews: true,
  showTimeline: true,
  showHeader: true,
  showDebugOverlay: false,
  previewPosition: 'right',
  playbackMode: 'live',
  playbackTime: null,
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

  // ------------------------------------------------------------------
  // Selection + streaming
  // ------------------------------------------------------------------

  selectCamera(id) {
    const cached = getFreshRecordingsCache(id, getCurrentDateString());
    set({
      selectedId: id,
      playbackMode: 'live',
      playbackTime: null,
      recordings: cached?.recordings ?? [],
      recordingEvents: cached?.recordingEvents ?? [],
      recordingsLoading: false,
      recordingsError: null,
    });
    void get().startStream(id);
  },

  async startStream(id) {
    get().setStatus(id, 'connecting');
    try {
      const hlsUrl = await window.vigilatus.stream.start(id);
      if (!hlsUrl) {
        set((s) => ({
          cameras: s.cameras.map((c) =>
            c.config.id === id ? { ...c, status: 'idle', hlsUrl: undefined, errorMessage: undefined } : c,
          ),
        }));
        return;
      }

      set((s) => ({
        cameras: s.cameras.map((c) =>
          c.config.id === id ? { ...c, status: 'live', hlsUrl, errorMessage: undefined } : c,
        ),
      }));
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('Stream start cancelled')) {
        set((s) => ({
          cameras: s.cameras.map((c) =>
            c.config.id === id ? { ...c, status: 'idle', hlsUrl: undefined, errorMessage: undefined } : c,
          ),
        }));
        return;
      }
      get().setStatus(id, 'error', msg);
    }
  },

  stopStream(id) {
    void window.vigilatus.stream.stop(id);
    set((s) => ({
      cameras: s.cameras.map((c) => (c.config.id === id ? { ...c, status: 'idle', hlsUrl: undefined } : c)),
    }));
  },

  restartActiveStreams() {
    const liveIds = get()
      .cameras.filter((c) => c.status === 'live' || c.status === 'connecting')
      .map((c) => c.config.id);
    if (liveIds.length === 0) return;
    console.log('[cameras] restarting streams after resume:', liveIds);
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
    set((s) => ({
      cameras: s.cameras.map((c) => (c.config.id === id ? { ...c, snapshotDataUrl: dataUrl } : c)),
    }));
  },

  setStatus(id, status, error) {
    set((s) => ({
      cameras: s.cameras.map((c) => (c.config.id === id ? { ...c, status, errorMessage: error } : c)),
    }));
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
          console.warn(
            `[recordings:events:${cameraId}] failed for ${date}:`,
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
      set({ playbackMode: 'live', playbackTime: null });
      return;
    }

    console.info('[cameras:seekTo] clip found:', {
      clickedTime: new Date(time).toISOString(),
      clipStart: new Date(clip.startTime).toISOString(),
      clipEnd: new Date(clip.endTime).toISOString(),
      clipStartMs: clip.startTime,
      clipEndMs: clip.endTime,
    });

    set({ playbackMode: 'playback', playbackTime: time });

    const requestedStartTime = Math.max(clip.startTime, time - PLAYBACK_PREROLL_MS);
    const requestedEndTime = Math.min(
      clip.endTime,
      Math.max(requestedStartTime + 15_000, requestedStartTime + PLAYBACK_WINDOW_MS),
    );

    // Clear live source immediately while recording clip is being prepared.
    // Do not stop the live process here because it can race with an in-flight
    // stream:start and surface SIGKILL as a start failure.
    set((s) => ({
      cameras: s.cameras.map((c) =>
        c.config.id === selectedId
          ? { ...c, hlsUrl: undefined, status: 'connecting', errorMessage: undefined }
          : c,
      ),
    }));

    try {
      const playbackUrl = await window.vigilatus.recordings.play(
        selectedId,
        requestedStartTime,
        requestedEndTime,
        time,
        clip.startTime,
      );
      set((s) => ({
        cameras: s.cameras.map((c) =>
          c.config.id === selectedId ? { ...c, hlsUrl: playbackUrl, status: 'live' } : c,
        ),
      }));
    } catch (e) {
      const msg = (e as Error).message;
      get().setStatus(selectedId, 'error', msg || 'Failed to start recording playback');
      set({ playbackMode: 'live', playbackTime: null });
    }
  },

  goLive() {
    const { selectedId, playbackMode } = get();
    set({ playbackMode: 'live', playbackTime: null });
    if (selectedId) {
      if (playbackMode === 'live') {
        get().stopStream(selectedId);
      }
      void get().startStream(selectedId);
    }
  },
}));
