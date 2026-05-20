import { contextBridge, ipcRenderer } from 'electron';
import { preloadBindings } from 'i18next-electron-fs-backend';
import type { CameraConfig, Recording, RuntimeInfo } from './types';

type PreviewPosition = 'left' | 'right' | 'top' | 'bottom';

contextBridge.exposeInMainWorld('vigilatus', {
  i18nextElectronBackend: preloadBindings(ipcRenderer, process),
  cameras: {
    getAll: (): Promise<CameraConfig[]> => ipcRenderer.invoke('cameras:getAll'),
    add: (cfg: CameraConfig): Promise<void> => ipcRenderer.invoke('cameras:add', cfg),
    update: (id: string, updates: Partial<CameraConfig>): Promise<void> =>
      ipcRenderer.invoke('cameras:update', id, updates),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('cameras:remove', id),
    test: (
      cfg: Pick<CameraConfig, 'host' | 'username' | 'password'>,
    ): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('cameras:test', cfg),
  },
  stream: {
    start: (cameraId: string): Promise<string | null> => ipcRenderer.invoke('stream:start', cameraId),
    stop: (cameraId: string): Promise<void> => ipcRenderer.invoke('stream:stop', cameraId),
    startPlayback: (cameraId: string, seekSeconds: number): Promise<string> =>
      ipcRenderer.invoke('stream:playback', cameraId, seekSeconds),
  },
  snapshot: {
    get: (cameraId: string): Promise<string | null> => ipcRenderer.invoke('snapshot:get', cameraId),
  },
  recordings: {
    list: (cameraId: string, date: string): Promise<Recording[]> =>
      ipcRenderer.invoke('recordings:list', cameraId, date),
    play: (
      cameraId: string,
      startTime: number,
      endTime: number,
      requestedTime: number,
      clipStartTime?: number,
    ): Promise<string> =>
      ipcRenderer.invoke('recordings:play', cameraId, startTime, endTime, requestedTime, clipStartTime),
  },
  diagnostics: {
    getRuntimeInfo: (): Promise<RuntimeInfo> => ipcRenderer.invoke('diagnostics:getRuntimeInfo'),
  },
  contextMenu: {
    showCameraMenu: (): Promise<string | null> => ipcRenderer.invoke('ui:showCameraContextMenu'),
  },
  ui: {
    onOpenAddCamera: (callback: () => void): (() => void) => {
      const handler = () => callback();
      ipcRenderer.on('ui:openAddCamera', handler);
      return () => ipcRenderer.removeListener('ui:openAddCamera', handler);
    },
    onSetPreviewsVisible: (callback: (visible: boolean) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, visible: boolean) => callback(visible);
      ipcRenderer.on('ui:setPreviewsVisible', handler);
      return () => ipcRenderer.removeListener('ui:setPreviewsVisible', handler);
    },
    onSetTimelineVisible: (callback: (visible: boolean) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, visible: boolean) => callback(visible);
      ipcRenderer.on('ui:setTimelineVisible', handler);
      return () => ipcRenderer.removeListener('ui:setTimelineVisible', handler);
    },
    onSetHeaderVisible: (callback: (visible: boolean) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, visible: boolean) => callback(visible);
      ipcRenderer.on('ui:setHeaderVisible', handler);
      return () => ipcRenderer.removeListener('ui:setHeaderVisible', handler);
    },
    onSetDebugOverlayVisible: (callback: (visible: boolean) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, visible: boolean) => callback(visible);
      ipcRenderer.on('ui:setDebugOverlayVisible', handler);
      return () => ipcRenderer.removeListener('ui:setDebugOverlayVisible', handler);
    },
    onSetPreviewPosition: (callback: (position: PreviewPosition) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, position: PreviewPosition) => callback(position);
      ipcRenderer.on('ui:setPreviewPosition', handler);
      return () => ipcRenderer.removeListener('ui:setPreviewPosition', handler);
    },
    onStreamsInvalidated: (callback: () => void): (() => void) => {
      const handler = () => callback();
      ipcRenderer.on('streams:invalidated', handler);
      return () => ipcRenderer.removeListener('streams:invalidated', handler);
    },
    onSetLanguage: (callback: (language: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, language: string) => callback(language);
      ipcRenderer.on('ui:setLanguage', handler);
      return () => ipcRenderer.removeListener('ui:setLanguage', handler);
    },
    onSetVolume: (callback: (volume: number) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, volume: number) => callback(volume);
      ipcRenderer.on('ui:setVolume', handler);
      return () => ipcRenderer.removeListener('ui:setVolume', handler);
    },
    saveVolume: (volume: number): void => {
      ipcRenderer.send('ui:saveVolume', volume);
    },
  },
});
