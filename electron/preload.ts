import { contextBridge, ipcRenderer } from 'electron';
import { preloadBindings } from 'i18next-electron-fs-backend';
import { IPC } from './ipc/channels';
import type {
  CameraConfig,
  MainLayout,
  PreviewPosition,
  Recording,
  RecordingEvent,
  RuntimeInfo,
  VigilatusApi,
} from './types';

const api: VigilatusApi = {
  i18nextElectronBackend: preloadBindings(ipcRenderer, process),
  cameras: {
    getAll: (): Promise<CameraConfig[]> => ipcRenderer.invoke(IPC.cameras.getAll),
    add: (cfg: CameraConfig): Promise<void> => ipcRenderer.invoke(IPC.cameras.add, cfg),
    update: (id: string, updates: Partial<CameraConfig>): Promise<void> =>
      ipcRenderer.invoke(IPC.cameras.update, id, updates),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.cameras.remove, id),
    move: (id: string, direction: 'up' | 'down'): Promise<void> =>
      ipcRenderer.invoke(IPC.cameras.move, id, direction),
    test: (
      cfg: Pick<CameraConfig, 'host' | 'username' | 'password'>,
    ): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke(IPC.cameras.test, cfg),
    saveVolume: (id: string, volume: number): void => {
      ipcRenderer.send(IPC.cameras.saveVolume, id, volume);
    },
  },
  stream: {
    start: (cameraId: string): Promise<string | null> => ipcRenderer.invoke(IPC.stream.start, cameraId),
    stop: (cameraId: string): Promise<void> => ipcRenderer.invoke(IPC.stream.stop, cameraId),
  },
  snapshot: {
    get: (cameraId: string): Promise<string | null> => ipcRenderer.invoke(IPC.snapshot.get, cameraId),
  },
  recordings: {
    list: (cameraId: string, date: string): Promise<Recording[]> =>
      ipcRenderer.invoke(IPC.recordings.list, cameraId, date),
    events: (cameraId: string, date: string): Promise<RecordingEvent[]> =>
      ipcRenderer.invoke(IPC.recordings.events, cameraId, date),
    play: (
      cameraId: string,
      startTime: number,
      endTime: number,
      requestedTime: number,
      clipStartTime?: number,
    ): Promise<string> =>
      ipcRenderer.invoke(IPC.recordings.play, cameraId, startTime, endTime, requestedTime, clipStartTime),
  },
  diagnostics: {
    getRuntimeInfo: (): Promise<RuntimeInfo> => ipcRenderer.invoke(IPC.diagnostics.getRuntimeInfo),
  },
  layout: {
    get: (): Promise<MainLayout> => ipcRenderer.invoke(IPC.layout.get),
    save: (layout: MainLayout): Promise<void> => ipcRenderer.invoke(IPC.layout.save, layout),
  },
  contextMenu: {
    showCameraMenu: (isFirst: boolean, isLast: boolean): Promise<string | null> =>
      ipcRenderer.invoke(IPC.ui.showCameraContextMenu, isFirst, isLast),
    showTileContextMenu: (locked: boolean): Promise<string | null> =>
      ipcRenderer.invoke(IPC.ui.showTileContextMenu, locked),
    showLayoutContextMenu: (): Promise<string | null> => ipcRenderer.invoke(IPC.ui.showLayoutContextMenu),
  },
  ui: {
    onOpenAddCamera: (callback: () => void): (() => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC.ui.openAddCamera, handler);
      return () => ipcRenderer.removeListener(IPC.ui.openAddCamera, handler);
    },
    onSetPreviewsVisible: (callback: (visible: boolean) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, visible: boolean) => callback(visible);
      ipcRenderer.on(IPC.ui.setPreviewsVisible, handler);
      return () => ipcRenderer.removeListener(IPC.ui.setPreviewsVisible, handler);
    },
    onSetTimelineVisible: (callback: (visible: boolean) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, visible: boolean) => callback(visible);
      ipcRenderer.on(IPC.ui.setTimelineVisible, handler);
      return () => ipcRenderer.removeListener(IPC.ui.setTimelineVisible, handler);
    },
    onSetHeaderVisible: (callback: (visible: boolean) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, visible: boolean) => callback(visible);
      ipcRenderer.on(IPC.ui.setHeaderVisible, handler);
      return () => ipcRenderer.removeListener(IPC.ui.setHeaderVisible, handler);
    },
    onSetDebugOverlayVisible: (callback: (visible: boolean) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, visible: boolean) => callback(visible);
      ipcRenderer.on(IPC.ui.setDebugOverlayVisible, handler);
      return () => ipcRenderer.removeListener(IPC.ui.setDebugOverlayVisible, handler);
    },
    onSetPreviewPosition: (callback: (position: PreviewPosition) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, position: PreviewPosition) => callback(position);
      ipcRenderer.on(IPC.ui.setPreviewPosition, handler);
      return () => ipcRenderer.removeListener(IPC.ui.setPreviewPosition, handler);
    },
    onStreamsInvalidated: (callback: () => void): (() => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC.streams.invalidated, handler);
      return () => ipcRenderer.removeListener(IPC.streams.invalidated, handler);
    },
    onStreamDied: (callback: (cameraId: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, cameraId: string) => callback(cameraId);
      ipcRenderer.on(IPC.stream.died, handler);
      return () => ipcRenderer.removeListener(IPC.stream.died, handler);
    },
    onSetLanguage: (callback: (language: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, language: string) => callback(language);
      ipcRenderer.on(IPC.ui.setLanguage, handler);
      return () => ipcRenderer.removeListener(IPC.ui.setLanguage, handler);
    },
  },
};

contextBridge.exposeInMainWorld('vigilatus', api);
