/** Types shared between electron main-process modules */

export interface CameraConfig {
  id: string;
  name: string;
  host: string;
  /** API auth username (default: admin) */
  username: string;
  /** API auth password (TP-Link / device password) */
  password: string;
  /** RTSP stream username — set via Camera Account in Tapo app */
  streamUser: string;
  /** RTSP stream password — set via Camera Account in Tapo app */
  streamPassword: string;
  /** Optional external RTSP source, e.g. an RTSP proxy that fans out the camera stream */
  rtspUrl?: string;
  /** Optional basic auth username for the external RTSP source */
  rtspUsername?: string;
  /** Optional basic auth password for the external RTSP source */
  rtspPassword?: string;
  model?: string;
  /** Stream protocol: 'rtsp' (default) or 'http' (Tapo HTTP Media Session on port 8800) */
  streamProtocol?: 'rtsp' | 'http';
  /** Auto-detected password hash method for HTTP media session (md5 or sha256) */
  httpHashMethod?: 'md5' | 'sha256';
  /** Viewer playback volume for this camera, 0..1 (0 / unset = muted) */
  volume?: number;
}

export interface Recording {
  /** Unix ms */
  startTime: number;
  /** Unix ms */
  endTime: number;
}

export interface RecordingEvent {
  /** Unix ms */
  startTime: number;
  /** Unix ms */
  endTime: number;
  alarmType?: number;
}

export type PreviewPosition = 'left' | 'right' | 'top' | 'bottom';

/** One free-floating camera tile in the main area. Rect is normalised 0..1
 *  against the main-area box so it survives window/area resize. */
export interface LayoutTile {
  /** stable tile id (not the camera id — a camera may appear once) */
  id: string;
  cameraId: string;
  /** normalised rect, each field in [0,1] */
  x: number;
  y: number;
  w: number;
  h: number;
  /** z-order; higher renders on top */
  z: number;
  /** locked tiles cannot be moved/resized by drag */
  locked: boolean;
}

export interface MainLayout {
  tiles: LayoutTile[];
  /** focused tile id — timeline/header target; survives restart */
  focusedTileId: string | null;
}

export interface RuntimeInfo {
  userData: string;
  logPath: string | null;
  isDevelopment: boolean;
  isPackaged: boolean;
}

/**
 * Shape of the `window.vigilatus` bridge exposed by `electron/preload.ts`.
 *
 * `preload.ts` is the source of truth; this interface mirrors it so drift is
 * compiler-caught (preload annotates its exposed object as `VigilatusApi`) and
 * the renderer (`src/vite-env.d.ts`) consumes the same definition.
 */
export interface VigilatusApi {
  /**
   * Return value of `preloadBindings(ipcRenderer, process)` from
   * `i18next-electron-fs-backend`. The renderer never calls it directly, so it
   * is typed as `unknown` to avoid importing that package into this
   * dependency-free types module.
   */
  i18nextElectronBackend: unknown;
  cameras: {
    getAll: () => Promise<CameraConfig[]>;
    add: (cfg: CameraConfig) => Promise<void>;
    update: (id: string, updates: Partial<CameraConfig>) => Promise<void>;
    remove: (id: string) => Promise<void>;
    move: (id: string, direction: 'up' | 'down') => Promise<void>;
    test: (
      cfg: Pick<CameraConfig, 'host' | 'username' | 'password'>,
    ) => Promise<{ success: boolean; error?: string }>;
    /** Fire-and-forget volume persistence — unlike `update`, it must not
     *  interrupt recording playback or clear recording caches. */
    saveVolume: (id: string, volume: number) => void;
  };
  stream: {
    start: (cameraId: string) => Promise<string | null>;
    stop: (cameraId: string) => Promise<void>;
  };
  snapshot: {
    get: (cameraId: string) => Promise<string | null>;
  };
  recordings: {
    list: (cameraId: string, date: string) => Promise<Recording[]>;
    events: (cameraId: string, date: string) => Promise<RecordingEvent[]>;
    play: (
      cameraId: string,
      startTime: number,
      endTime: number,
      requestedTime: number,
      clipStartTime?: number,
    ) => Promise<string>;
  };
  diagnostics: {
    getRuntimeInfo: () => Promise<RuntimeInfo>;
  };
  layout: {
    get: () => Promise<MainLayout>;
    save: (layout: MainLayout) => Promise<void>;
  };
  contextMenu: {
    showCameraMenu: (isFirst: boolean, isLast: boolean) => Promise<string | null>;
    showTileContextMenu: (locked: boolean) => Promise<string | null>;
    showLayoutContextMenu: () => Promise<string | null>;
  };
  ui: {
    onOpenAddCamera: (callback: () => void) => () => void;
    onSetPreviewsVisible: (callback: (visible: boolean) => void) => () => void;
    onSetTimelineVisible: (callback: (visible: boolean) => void) => () => void;
    onSetHeaderVisible: (callback: (visible: boolean) => void) => () => void;
    onSetDebugOverlayVisible: (callback: (visible: boolean) => void) => () => void;
    onSetPreviewPosition: (callback: (position: PreviewPosition) => void) => () => void;
    onStreamsInvalidated: (callback: () => void) => () => void;
    onStreamDied: (callback: (cameraId: string) => void) => () => void;
    onSetLanguage: (callback: (language: string) => void) => () => void;
  };
}
