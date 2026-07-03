import { vi, type Mock } from 'vitest';
import type {
  CameraConfig,
  MainLayout,
  PreviewPosition,
  Recording,
  RecordingEvent,
  RuntimeInfo,
} from '../../src/types';

type Unsubscribe = () => void;
type FnMock<Args extends unknown[], Result> = Mock<(...args: Args) => Result>;

export type VigilatusMock = {
  cameras: {
    getAll: FnMock<[], Promise<CameraConfig[]>>;
    add: FnMock<[CameraConfig], Promise<void>>;
    update: FnMock<[string, Partial<CameraConfig>], Promise<void>>;
    remove: FnMock<[string], Promise<void>>;
    test: FnMock<
      [Pick<CameraConfig, 'host' | 'username' | 'password'>],
      Promise<{ success: boolean; error?: string }>
    >;
    saveVolume: FnMock<[string, number], void>;
  };
  stream: {
    start: FnMock<[string], Promise<string | null>>;
    stop: FnMock<[string], Promise<void>>;
  };
  snapshot: {
    get: FnMock<[string], Promise<string | null>>;
  };
  recordings: {
    list: FnMock<[string, string], Promise<Recording[]>>;
    events: FnMock<[string, string], Promise<RecordingEvent[]>>;
    play: FnMock<[string, number, number, number, number | undefined], Promise<string>>;
  };
  diagnostics: {
    getRuntimeInfo: FnMock<[], Promise<RuntimeInfo>>;
  };
  layout: {
    get: FnMock<[], Promise<MainLayout>>;
    save: FnMock<[MainLayout], Promise<void>>;
  };
  contextMenu: {
    showCameraMenu: FnMock<[], Promise<string | null>>;
    showTileContextMenu: FnMock<[boolean], Promise<string | null>>;
    showLayoutContextMenu: FnMock<[], Promise<string | null>>;
  };
  ui: {
    onOpenAddCamera: FnMock<[() => void], Unsubscribe>;
    onSetPreviewsVisible: FnMock<[(visible: boolean) => void], Unsubscribe>;
    onSetTimelineVisible: FnMock<[(visible: boolean) => void], Unsubscribe>;
    onSetHeaderVisible: FnMock<[(visible: boolean) => void], Unsubscribe>;
    onSetDebugOverlayVisible: FnMock<[(visible: boolean) => void], Unsubscribe>;
    onSetPreviewPosition: FnMock<[(position: PreviewPosition) => void], Unsubscribe>;
    onStreamsInvalidated: FnMock<[() => void], Unsubscribe>;
    onStreamDied: FnMock<[(cameraId: string) => void], Unsubscribe>;
    onSetLanguage: FnMock<[(language: string) => void], Unsubscribe>;
  };
};

export function createVigilatusMock(overrides: Partial<VigilatusMock> = {}): VigilatusMock {
  const noop = () => undefined;
  const mock: VigilatusMock = {
    cameras: {
      getAll: vi.fn().mockResolvedValue([]),
      add: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      test: vi.fn().mockResolvedValue({ success: true }),
      saveVolume: vi.fn(),
    },
    stream: {
      start: vi.fn().mockResolvedValue(null),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    snapshot: {
      get: vi.fn().mockResolvedValue(null),
    },
    recordings: {
      list: vi.fn().mockResolvedValue([]),
      events: vi.fn().mockResolvedValue([]),
      play: vi.fn().mockResolvedValue('blob:playback'),
    },
    diagnostics: {
      getRuntimeInfo: vi.fn().mockResolvedValue({
        userData: 'C:/tmp/vigilatus',
        logPath: null,
        isDevelopment: true,
        isPackaged: false,
      }),
    },
    layout: {
      get: vi.fn().mockResolvedValue({ tiles: [], focusedTileId: null }),
      save: vi.fn().mockResolvedValue(undefined),
    },
    contextMenu: {
      showCameraMenu: vi.fn().mockResolvedValue(null),
      showTileContextMenu: vi.fn().mockResolvedValue(null),
      showLayoutContextMenu: vi.fn().mockResolvedValue(null),
    },
    ui: {
      onOpenAddCamera: vi.fn().mockImplementation(() => noop),
      onSetPreviewsVisible: vi.fn().mockImplementation(() => noop),
      onSetTimelineVisible: vi.fn().mockImplementation(() => noop),
      onSetHeaderVisible: vi.fn().mockImplementation(() => noop),
      onSetDebugOverlayVisible: vi.fn().mockImplementation(() => noop),
      onSetPreviewPosition: vi.fn().mockImplementation(() => noop),
      onStreamsInvalidated: vi.fn().mockImplementation(() => noop),
      onStreamDied: vi.fn().mockImplementation(() => noop),
      onSetLanguage: vi.fn().mockImplementation(() => noop),
    },
  };

  return Object.assign(mock, overrides);
}

export function installVigilatusMock(mock: VigilatusMock): void {
  Object.defineProperty(window, 'vigilatus', {
    value: mock,
    configurable: true,
    writable: true,
  });
}
