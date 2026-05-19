import { vi } from 'vitest';
import type { CameraConfig, PreviewPosition, Recording, RuntimeInfo } from '../../src/types';

type Unsubscribe = () => void;

export type TapoStudioMock = {
  cameras: {
    getAll: ReturnType<typeof vi.fn<[], Promise<CameraConfig[]>>>;
    add: ReturnType<typeof vi.fn<[CameraConfig], Promise<void>>>;
    update: ReturnType<typeof vi.fn<[string, Partial<CameraConfig>], Promise<void>>>;
    remove: ReturnType<typeof vi.fn<[string], Promise<void>>>;
    test: ReturnType<typeof vi.fn<[Pick<CameraConfig, 'host' | 'username' | 'password'>], Promise<{ success: boolean; error?: string }>>>;
  };
  stream: {
    start: ReturnType<typeof vi.fn<[string], Promise<string | null>>>;
    stop: ReturnType<typeof vi.fn<[string], Promise<void>>>;
    startPlayback: ReturnType<typeof vi.fn<[string, number], Promise<string>>>;
  };
  snapshot: {
    get: ReturnType<typeof vi.fn<[string], Promise<string | null>>>;
  };
  recordings: {
    list: ReturnType<typeof vi.fn<[string, string], Promise<Recording[]>>>;
    play: ReturnType<typeof vi.fn<[string, number, number, number, number | undefined], Promise<string>>>;
  };
  diagnostics: {
    getRuntimeInfo: ReturnType<typeof vi.fn<[], Promise<RuntimeInfo>>>;
  };
  contextMenu: {
    showCameraMenu: ReturnType<typeof vi.fn<[], Promise<string | null>>>;
  };
  ui: {
    onOpenAddCamera: ReturnType<typeof vi.fn<[() => void], Unsubscribe>>;
    onSetPreviewsVisible: ReturnType<typeof vi.fn<[(visible: boolean) => void], Unsubscribe>>;
    onSetTimelineVisible: ReturnType<typeof vi.fn<[(visible: boolean) => void], Unsubscribe>>;
    onSetHeaderVisible: ReturnType<typeof vi.fn<[(visible: boolean) => void], Unsubscribe>>;
    onSetPreviewPosition: ReturnType<typeof vi.fn<[(position: PreviewPosition) => void], Unsubscribe>>;
    onStreamsInvalidated: ReturnType<typeof vi.fn<[() => void], Unsubscribe>>;
    onSetLanguage: ReturnType<typeof vi.fn<[(language: string) => void], Unsubscribe>>;
  };
};

export function createTapoStudioMock(overrides: Partial<TapoStudioMock> = {}): TapoStudioMock {
  const noop = () => undefined;
  const mock: TapoStudioMock = {
    cameras: {
      getAll: vi.fn().mockResolvedValue([]),
      add: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      test: vi.fn().mockResolvedValue({ success: true }),
    },
    stream: {
      start: vi.fn().mockResolvedValue(null),
      stop: vi.fn().mockResolvedValue(undefined),
      startPlayback: vi.fn().mockResolvedValue('blob:playback'),
    },
    snapshot: {
      get: vi.fn().mockResolvedValue(null),
    },
    recordings: {
      list: vi.fn().mockResolvedValue([]),
      play: vi.fn().mockResolvedValue('blob:playback'),
    },
    diagnostics: {
      getRuntimeInfo: vi.fn().mockResolvedValue({
        userData: 'C:/tmp/tapostudio',
        logPath: null,
        isDevelopment: true,
        isPackaged: false,
      }),
    },
    contextMenu: {
      showCameraMenu: vi.fn().mockResolvedValue(null),
    },
    ui: {
      onOpenAddCamera: vi.fn().mockImplementation(() => noop),
      onSetPreviewsVisible: vi.fn().mockImplementation(() => noop),
      onSetTimelineVisible: vi.fn().mockImplementation(() => noop),
      onSetHeaderVisible: vi.fn().mockImplementation(() => noop),
      onSetPreviewPosition: vi.fn().mockImplementation(() => noop),
      onStreamsInvalidated: vi.fn().mockImplementation(() => noop),
      onSetLanguage: vi.fn().mockImplementation(() => noop),
    },
  };

  return Object.assign(mock, overrides);
}

export function installTapoStudioMock(mock: TapoStudioMock): void {
  Object.defineProperty(window, 'tapoStudio', {
    value: mock,
    configurable: true,
    writable: true,
  });
}