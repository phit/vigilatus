import { contextBridge, ipcRenderer } from 'electron';
import type { CameraConfig, Recording } from './types';

contextBridge.exposeInMainWorld('tapoStudio', {
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
    start: (cameraId: string): Promise<string> => ipcRenderer.invoke('stream:start', cameraId),
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
  },
});
