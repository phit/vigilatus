import { create } from 'zustand';
import type { CameraConfig, CameraState, Recording, PlaybackMode } from '../types';

interface CamerasStore {
  cameras: CameraState[];
  selectedId: string | null;
  showPreviews: boolean;
  playbackMode: PlaybackMode;
  playbackTime: number | null;
  recordings: Recording[];

  loadCameras(): Promise<void>;
  addCamera(cfg: CameraConfig): Promise<void>;
  updateCamera(id: string, updates: Partial<CameraConfig>): Promise<void>;
  removeCamera(id: string): Promise<void>;

  selectCamera(id: string): void;
  startStream(id: string): Promise<void>;
  stopStream(id: string): void;
  updateSnapshot(id: string, dataUrl: string): void;
  setStatus(id: string, status: CameraState['status'], error?: string): void;

  togglePreviews(): void;
  loadRecordings(cameraId: string, date: string): Promise<void>;
  seekTo(time: number): Promise<void>;
  goLive(): void;
}

export const useCameraStore = create<CamerasStore>((set, get) => ({
  cameras: [],
  selectedId: null,
  showPreviews: true,
  playbackMode: 'live',
  playbackTime: null,
  recordings: [],

  // ------------------------------------------------------------------
  // Config operations
  // ------------------------------------------------------------------

  async loadCameras() {
    const configs = await window.tapoStudio.cameras.getAll();
    set({
      cameras: configs.map((config) => ({ config, status: 'idle' })),
    });
  },

  async addCamera(cfg) {
    await window.tapoStudio.cameras.add(cfg);
    await get().loadCameras();
  },

  async updateCamera(id, updates) {
    await window.tapoStudio.cameras.update(id, updates);
    await get().loadCameras();
  },

  async removeCamera(id) {
    await window.tapoStudio.cameras.remove(id);
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
    set({ selectedId: id, playbackMode: 'live', playbackTime: null, recordings: [] });
    void get().startStream(id);
  },

  async startStream(id) {
    get().setStatus(id, 'connecting');
    try {
      const hlsUrl = await window.tapoStudio.stream.start(id);
      set((s) => ({
        cameras: s.cameras.map((c) =>
          c.config.id === id ? { ...c, status: 'live', hlsUrl, errorMessage: undefined } : c,
        ),
      }));
    } catch (e) {
      get().setStatus(id, 'error', (e as Error).message);
    }
  },

  stopStream(id) {
    void window.tapoStudio.stream.stop(id);
    set((s) => ({
      cameras: s.cameras.map((c) =>
        c.config.id === id ? { ...c, status: 'idle', hlsUrl: undefined } : c,
      ),
    }));
  },

  updateSnapshot(id, dataUrl) {
    set((s) => ({
      cameras: s.cameras.map((c) =>
        c.config.id === id ? { ...c, snapshotDataUrl: dataUrl } : c,
      ),
    }));
  },

  setStatus(id, status, error) {
    set((s) => ({
      cameras: s.cameras.map((c) =>
        c.config.id === id ? { ...c, status, errorMessage: error } : c,
      ),
    }));
  },

  // ------------------------------------------------------------------
  // Preview strip
  // ------------------------------------------------------------------

  togglePreviews() {
    set((s) => ({ showPreviews: !s.showPreviews }));
  },

  // ------------------------------------------------------------------
  // Recordings + timeline
  // ------------------------------------------------------------------

  async loadRecordings(cameraId, date) {
    try {
      const recs = await window.tapoStudio.recordings.list(cameraId, date);
      set({ recordings: recs });
    } catch {
      set({ recordings: [] });
    }
  },

  async seekTo(time) {
    const { selectedId } = get();
    if (!selectedId) return;

    set({ playbackMode: 'playback', playbackTime: time });
    const now = Date.now();
    const seekSeconds = Math.max(0, Math.floor((now - time) / 1000));

    try {
      const hlsUrl = await window.tapoStudio.stream.startPlayback(selectedId, seekSeconds);
      set((s) => ({
        cameras: s.cameras.map((c) =>
          c.config.id === selectedId ? { ...c, hlsUrl, status: 'live' } : c,
        ),
      }));
    } catch {
      // Playback not supported for this camera — no-op, show live instead
      set({ playbackMode: 'live', playbackTime: null });
    }
  },

  goLive() {
    const { selectedId } = get();
    set({ playbackMode: 'live', playbackTime: null, recordings: [] });
    if (selectedId) void get().startStream(selectedId);
  },
}));
