import { create } from 'zustand';
import type {
  CameraConfig,
  CameraState,
  LayoutTile,
  MainLayout,
  Recording,
  RecordingEvent,
  PlaybackMode,
  PreviewPosition,
} from '../types';
import { cascadeRect, clampRect } from '../components/layoutGeometry';
import { createLogger } from '../log';

const log = createLogger('cameras');

const PLAYBACK_PREROLL_MS = 5_000;
const PLAYBACK_WINDOW_MS = 120_000;
const RECORDINGS_CACHE_TTL_MS = 2 * 60_000;
const HTTP_STREAM_LINGER_MS = 60_000;
const SAVE_LAYOUT_DEBOUNCE_MS = 300;
const MAX_CONCURRENT_TILES = 4;

const DEFAULT_LAYOUT: MainLayout = { tiles: [], focusedTileId: null };

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
/** Per-camera exponential backoff state for auto-restart after stream death. */
const streamRestartBackoff = new Map<
  string,
  { attempt: number; delay: number; timer: ReturnType<typeof setTimeout> }
>();
const RESTART_INITIAL_DELAY_MS = 2_000;
const RESTART_MAX_DELAY_MS = 2 * 60 * 1000;

/** Debounce timer for saving the layout. */
let saveLayoutTimer: ReturnType<typeof setTimeout> | null = null;

interface CamerasStore {
  cameras: CameraState[];
  selectedId: string | null;
  layout: MainLayout;
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

  // Layout actions
  loadLayout(): Promise<void>;
  addTile(cameraId: string, rect?: { x: number; y: number; w: number; h: number }): void;
  removeTile(tileId: string): void;
  moveTile(tileId: string, rect: { x: number; y: number; w: number; h: number }): void;
  resizeTile(tileId: string, rect: { x: number; y: number; w: number; h: number }): void;
  setTileLocked(tileId: string, locked: boolean): void;
  lockAllTiles(): void;
  unlockAllTiles(): void;
  clearTiles(): void;
  focusTile(tileId: string): void;
  swapTileCamera(tileId: string, cameraId: string): void;
  bringToFront(tileId: string): void;
  clearFocus(): void;

  // Legacy — kept for compat; internally delegates to tile actions
  selectCamera(id: string): void;
  startStream(id: string): Promise<void>;
  stopStream(id: string): void;
  restartActiveStreams(): void;
  updateSnapshot(id: string, dataUrl: string): void;
  setStatus(id: string, status: CameraState['status'], error?: string): void;
  setRetryAt(id: string, retryAt?: number): void;
  scheduleStreamRestart(id: string): void;

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

  /** Schedule a debounced save of the current layout. */
  function scheduleSaveLayout() {
    if (saveLayoutTimer) clearTimeout(saveLayoutTimer);
    saveLayoutTimer = setTimeout(() => {
      void window.vigilatus.layout.save(get().layout);
      saveLayoutTimer = null;
    }, SAVE_LAYOUT_DEBOUNCE_MS);
  }

  /** Stop a camera's stream, respecting the HTTP grace period. */
  function stopCameraStream(cameraId: string) {
    const cam = get().cameras.find((c) => c.config.id === cameraId);
    if (!cam) return;
    if (cam.config.streamProtocol === 'http' && (cam.status === 'live' || cam.status === 'connecting')) {
      const timer = setTimeout(() => {
        httpStopTimers.delete(cameraId);
        if (!get().layout.tiles.some((t) => t.cameraId === cameraId)) {
          get().stopStream(cameraId);
        }
      }, HTTP_STREAM_LINGER_MS);
      httpStopTimers.set(cameraId, timer);
    } else {
      get().stopStream(cameraId);
    }
  }

  /** Cancel any pending stop timer for a camera (because it was re-added). */
  function cancelStopTimer(cameraId: string) {
    const pending = httpStopTimers.get(cameraId);
    if (pending) {
      clearTimeout(pending);
      httpStopTimers.delete(cameraId);
    }
  }

  return {
    cameras: [],
    selectedId: null,
    layout: DEFAULT_LAYOUT,
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

        // Remove tiles for this camera and update layout
        const newTiles = s.layout.tiles.filter((t) => t.cameraId !== id);
        let focusedTileId = s.layout.focusedTileId;
        if (focusedTileId && !newTiles.some((t) => t.id === focusedTileId)) {
          focusedTileId = newTiles[0]?.id ?? null;
        }

        const focusedCamId = newTiles.find((t) => t.id === focusedTileId)?.cameraId ?? null;
        const selectedId =
          s.selectedId === id ? (focusedCamId ?? cameras[0]?.config.id ?? null) : s.selectedId;

        return { cameras, layout: { tiles: newTiles, focusedTileId }, selectedId };
      });
    },

    async moveCamera(id, direction) {
      await window.vigilatus.cameras.move(id, direction);
      await get().loadCameras();
    },

    // ------------------------------------------------------------------
    // Layout operations
    // ------------------------------------------------------------------

    async loadLayout() {
      const persisted = await window.vigilatus.layout.get();
      const { cameras } = get();

      const validCameraIds = new Set(cameras.map((c) => c.config.id));
      const tiles = persisted.tiles.filter((t) => validCameraIds.has(t.cameraId));

      let focusedTileId = persisted.focusedTileId;
      if (focusedTileId && !tiles.some((t) => t.id === focusedTileId)) {
        focusedTileId = tiles[0]?.id ?? null;
      }

      const layout: MainLayout = { tiles, focusedTileId };
      const focusedCameraId = tiles.find((t) => t.id === focusedTileId)?.cameraId ?? null;

      set({ layout, selectedId: focusedCameraId });

      for (const tile of tiles) {
        void get().startStream(tile.cameraId);
      }
    },

    addTile(cameraId, rect) {
      const { layout, cameras } = get();

      // If already in layout, just focus it
      const existing = layout.tiles.find((t) => t.cameraId === cameraId);
      if (existing) {
        get().focusTile(existing.id);
        return;
      }

      if (layout.tiles.length >= MAX_CONCURRENT_TILES) {
        log.warn('tile cap reached, cannot add more tiles');
        return;
      }

      const tileRect = rect ? clampRect(rect) : cascadeRect(layout.tiles.length);
      const maxZ = layout.tiles.reduce((z, t) => Math.max(z, t.z), -1);
      const tile: LayoutTile = {
        id: crypto.randomUUID(),
        cameraId,
        ...tileRect,
        z: maxZ + 1,
        locked: false,
      };

      const cached = getFreshRecordingsCache(cameraId, getCurrentDateString());
      const newLayout: MainLayout = {
        tiles: [...layout.tiles, tile],
        focusedTileId: tile.id,
      };

      set({
        layout: newLayout,
        selectedId: cameraId,
        playbackMode: 'live',
        playbackTime: null,
        playbackStartTime: null,
        recordings: cached?.recordings ?? [],
        recordingEvents: cached?.recordingEvents ?? [],
        recordingsLoading: false,
        recordingsError: null,
      });
      scheduleSaveLayout();

      cancelStopTimer(cameraId);

      const cam = cameras.find((c) => c.config.id === cameraId);
      if (cam && !cam.hlsUrl) {
        void get().startStream(cameraId);
      }
    },

    removeTile(tileId) {
      const { layout } = get();
      const tile = layout.tiles.find((t) => t.id === tileId);
      if (!tile) return;

      const newTiles = layout.tiles.filter((t) => t.id !== tileId);
      const stillUsed = newTiles.some((t) => t.cameraId === tile.cameraId);

      let focusedTileId = layout.focusedTileId;
      if (focusedTileId === tileId) {
        focusedTileId = newTiles[newTiles.length - 1]?.id ?? null;
      }

      const focusedCamId = newTiles.find((t) => t.id === focusedTileId)?.cameraId ?? null;

      set({
        layout: { tiles: newTiles, focusedTileId },
        selectedId: focusedCamId,
      });
      scheduleSaveLayout();

      if (!stillUsed) {
        stopCameraStream(tile.cameraId);
      }
    },

    moveTile(tileId, rect) {
      set((s) => ({
        layout: {
          ...s.layout,
          tiles: s.layout.tiles.map((t) => (t.id === tileId && !t.locked ? { ...t, ...clampRect(rect) } : t)),
        },
      }));
      scheduleSaveLayout();
    },

    resizeTile(tileId, rect) {
      set((s) => ({
        layout: {
          ...s.layout,
          tiles: s.layout.tiles.map((t) => (t.id === tileId && !t.locked ? { ...t, ...clampRect(rect) } : t)),
        },
      }));
      scheduleSaveLayout();
    },

    setTileLocked(tileId, locked) {
      set((s) => ({
        layout: {
          ...s.layout,
          tiles: s.layout.tiles.map((t) => (t.id === tileId ? { ...t, locked } : t)),
        },
      }));
      scheduleSaveLayout();
    },

    lockAllTiles() {
      set((s) => ({ layout: { ...s.layout, tiles: s.layout.tiles.map((t) => ({ ...t, locked: true })) } }));
      scheduleSaveLayout();
    },

    unlockAllTiles() {
      set((s) => ({ layout: { ...s.layout, tiles: s.layout.tiles.map((t) => ({ ...t, locked: false })) } }));
      scheduleSaveLayout();
    },

    clearTiles() {
      const cameraIds = [...new Set(get().layout.tiles.map((t) => t.cameraId))];
      set({ layout: { tiles: [], focusedTileId: null }, selectedId: null });
      scheduleSaveLayout();
      for (const cameraId of cameraIds) {
        stopCameraStream(cameraId);
      }
    },

    focusTile(tileId) {
      const tile = get().layout.tiles.find((t) => t.id === tileId);
      if (!tile) return;
      const cached = getFreshRecordingsCache(tile.cameraId, getCurrentDateString());
      set((s) => ({
        layout: { ...s.layout, focusedTileId: tileId },
        selectedId: tile.cameraId,
        playbackMode: 'live',
        playbackTime: null,
        playbackStartTime: null,
        recordings: cached?.recordings ?? [],
        recordingEvents: cached?.recordingEvents ?? [],
        recordingsLoading: false,
        recordingsError: null,
      }));
      scheduleSaveLayout();
    },

    swapTileCamera(tileId, cameraId) {
      const { layout, cameras } = get();
      const tile = layout.tiles.find((t) => t.id === tileId);
      if (!tile || tile.cameraId === cameraId) return;

      const oldCameraId = tile.cameraId;
      const isFocused = layout.focusedTileId === tileId;

      // If the target camera already occupies another tile, swap the two tiles.
      const conflictTile = layout.tiles.find((t) => t.id !== tileId && t.cameraId === cameraId);
      if (conflictTile) {
        const newTiles = layout.tiles.map((t) => {
          if (t.id === tileId) return { ...t, cameraId };
          if (t.id === conflictTile.id) return { ...t, cameraId: oldCameraId };
          return t;
        });
        set({
          layout: { ...layout, tiles: newTiles },
          ...(isFocused ? { selectedId: cameraId } : {}),
        });
        scheduleSaveLayout();
        return;
      }

      const newTiles = layout.tiles.map((t) => (t.id === tileId ? { ...t, cameraId } : t));
      const cached = isFocused ? getFreshRecordingsCache(cameraId, getCurrentDateString()) : null;

      set({
        layout: { ...layout, tiles: newTiles },
        ...(isFocused
          ? {
              selectedId: cameraId,
              playbackMode: 'live',
              playbackTime: null,
              playbackStartTime: null,
              recordings: cached?.recordings ?? [],
              recordingEvents: cached?.recordingEvents ?? [],
              recordingsLoading: false,
              recordingsError: null,
            }
          : {}),
      });
      scheduleSaveLayout();

      cancelStopTimer(cameraId);
      const newCam = cameras.find((c) => c.config.id === cameraId);
      if (newCam && !newCam.hlsUrl) {
        void get().startStream(cameraId);
      }

      const stillUsed = newTiles.some((t) => t.cameraId === oldCameraId);
      if (!stillUsed) {
        stopCameraStream(oldCameraId);
      }
    },

    bringToFront(tileId) {
      set((s) => {
        const maxZ = s.layout.tiles.reduce((z, t) => Math.max(z, t.z), 0);
        return {
          layout: {
            ...s.layout,
            tiles: s.layout.tiles.map((t) => (t.id === tileId ? { ...t, z: maxZ + 1 } : t)),
          },
        };
      });
    },

    clearFocus() {
      if (get().playbackMode === 'playback') {
        get().goLive();
      }
      set((s) => ({ layout: { ...s.layout, focusedTileId: null }, selectedId: null }));
    },

    // ------------------------------------------------------------------
    // Selection + streaming (selectCamera delegates to tile actions)
    // ------------------------------------------------------------------

    selectCamera(id) {
      const { layout } = get();
      const existing = layout.tiles.find((t) => t.cameraId === id);
      if (existing) {
        get().focusTile(existing.id);
      } else {
        get().addTile(id);
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
      const backoff = streamRestartBackoff.get(id);
      if (backoff) {
        clearTimeout(backoff.timer);
        streamRestartBackoff.delete(id);
      }
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

    scheduleStreamRestart(id) {
      const inView = (cid: string) => get().layout.tiles.some((t) => t.cameraId === cid);
      const isPlaybackFocus = (cid: string) => get().playbackMode === 'playback' && get().selectedId === cid;

      if (!inView(id) || isPlaybackFocus(id)) {
        streamRestartBackoff.delete(id);
        return;
      }

      const existing = streamRestartBackoff.get(id);
      const delay = existing
        ? Math.min(existing.delay * 1.2, RESTART_MAX_DELAY_MS)
        : RESTART_INITIAL_DELAY_MS;
      const attempt = (existing?.attempt ?? 0) + 1;
      if (existing) clearTimeout(existing.timer);

      patchCamera(id, { retryAt: Date.now() + delay });

      log.warn(`stream restart scheduled for ${id}: attempt ${attempt} in ${(delay / 1000).toFixed(0)}s`);
      const timer = setTimeout(async () => {
        const cam = get().cameras.find((c) => c.config.id === id);
        if (!cam || !inView(id) || cam.status === 'idle' || isPlaybackFocus(id)) {
          streamRestartBackoff.delete(id);
          log.info(`stream restart stopped for ${id}: camera is out of view, idle, or in playback`);
          return;
        }

        log.info(`stream restart attempt ${attempt} starting for ${id}`);
        try {
          await get().startStream(id);
        } catch (error) {
          log.warn(`stream restart attempt ${attempt} threw for ${id}:`, (error as Error).message);
        }

        const after = get().cameras.find((c) => c.config.id === id);
        if (after?.status === 'live') {
          streamRestartBackoff.delete(id);
          log.info(`stream restart recovered ${id} on attempt ${attempt}`);
        } else if (!after || !inView(id) || after.status === 'idle' || isPlaybackFocus(id)) {
          streamRestartBackoff.delete(id);
          log.info(`stream restart stopped for ${id}: camera is out of view, idle, or in playback`);
        } else {
          get().scheduleStreamRestart(id);
        }
      }, delay);
      streamRestartBackoff.set(id, { attempt, delay, timer });
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
      patchCamera(selectedId, { hlsUrl: undefined, status: 'connecting', errorMessage: undefined });

      try {
        const playbackUrl = await window.vigilatus.recordings.play(
          selectedId,
          requestedStartTime,
          requestedEndTime,
          time,
          clip.startTime,
        );
        // Discard result if the user navigated away while this long-running download was in flight.
        const s = get();
        if (s.playbackMode !== 'playback' || s.playbackStartTime !== requestedStartTime) return;
        patchCamera(selectedId, { hlsUrl: playbackUrl, status: 'live' });
      } catch (e) {
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
