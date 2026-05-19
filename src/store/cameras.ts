import { create } from 'zustand';
import type { CameraConfig, CameraState, Recording, PlaybackMode, PreviewPosition } from '../types';

const PLAYBACK_PREROLL_MS = 5_000;
const PLAYBACK_WINDOW_MS = 120_000;

interface CamerasStore {
  cameras: CameraState[];
  selectedId: string | null;
  showPreviews: boolean;
  showTimeline: boolean;
  showHeader: boolean;
  previewPosition: PreviewPosition;
  playbackMode: PlaybackMode;
  playbackTime: number | null;
  recordings: Recording[];
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
  setPreviewPosition(position: PreviewPosition): void;
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
  previewPosition: 'right',
  playbackMode: 'live',
  playbackTime: null,
  recordings: [],
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
    await get().loadCameras();
  },

  async removeCamera(id) {
    await window.vigilatus.cameras.remove(id);
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
    set({
      selectedId: id,
      playbackMode: 'live',
      playbackTime: null,
      recordings: [],
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

  setPreviewPosition(position) {
    set({ previewPosition: position });
  },

  // ------------------------------------------------------------------
  // Recordings + timeline
  // ------------------------------------------------------------------

  async loadRecordings(cameraId, date) {
    set({ recordingsLoading: true, recordingsError: null });
    try {
      const recs = await window.vigilatus.recordings.list(cameraId, date);
      set({ recordings: recs, recordingsLoading: false, recordingsError: null });
    } catch (e) {
      set({
        recordings: [],
        recordingsLoading: false,
        recordingsError: (e as Error)?.message ?? 'Failed to load recordings',
      });
    }
  },

  async seekTo(time) {
    const { selectedId, recordings } = get();
    if (!selectedId) return;

    const clip = recordings.find((r) => time >= r.startTime && time <= r.endTime);
    if (!clip) {
      console.info(
        '[cameras:seekTo] no clip found for time',
        new Date(time).toISOString(),
        'recordings:',
        recordings.length,
      );
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
    const { selectedId } = get();
    set({ playbackMode: 'live', playbackTime: null });
    if (selectedId) void get().startStream(selectedId);
  },
}));
