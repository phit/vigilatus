import { ipcMain } from 'electron';
import * as configStore from '../config/store';
import * as streamManager from '../tapo/streamManager';
import { TapoClient } from '../tapo/client';
import type { CameraConfig } from '../types';

export function registerHandlers(): void {
  // ------------------------------------------------------------------
  // Camera config
  // ------------------------------------------------------------------

  ipcMain.handle('cameras:getAll', () => configStore.getCameras());

  ipcMain.handle('cameras:add', (_e, cam: CameraConfig) => {
    configStore.addCamera(cam);
  });

  ipcMain.handle('cameras:update', (_e, id: string, updates: Partial<CameraConfig>) => {
    configStore.updateCamera(id, updates);
  });

  ipcMain.handle('cameras:remove', (_e, id: string) => {
    streamManager.stopStream(id);
    configStore.removeCamera(id);
  });

  ipcMain.handle(
    'cameras:test',
    (_e, cfg: Pick<CameraConfig, 'host' | 'username' | 'password'>) => {
      const client = new TapoClient(cfg);
      return client.testConnection();
    },
  );

  // ------------------------------------------------------------------
  // Streaming
  // ------------------------------------------------------------------

  ipcMain.handle('stream:start', (_e, cameraId: string) => {
    const cam = configStore.getCameras().find((c) => c.id === cameraId);
    if (!cam) throw new Error(`Camera ${cameraId} not found`);
    return streamManager.startStream(cameraId, cam);
  });

  ipcMain.handle('stream:stop', (_e, cameraId: string) => {
    streamManager.stopStream(cameraId);
  });

  ipcMain.handle('stream:playback', (_e, cameraId: string, seekSeconds: number) => {
    const cam = configStore.getCameras().find((c) => c.id === cameraId);
    if (!cam) throw new Error(`Camera ${cameraId} not found`);
    return streamManager.startPlayback(cameraId, cam, seekSeconds);
  });

  // ------------------------------------------------------------------
  // Snapshots
  // ------------------------------------------------------------------

  ipcMain.handle('snapshot:get', (_e, cameraId: string) => {
    const cam = configStore.getCameras().find((c) => c.id === cameraId);
    if (!cam) return null;
    return streamManager.getSnapshot(cameraId, cam);
  });

  // ------------------------------------------------------------------
  // Recordings
  // ------------------------------------------------------------------

  ipcMain.handle('recordings:list', async (_e, cameraId: string, date: string) => {
    const cam = configStore.getCameras().find((c) => c.id === cameraId);
    if (!cam) return [];
    const client = new TapoClient({ host: cam.host, username: cam.username, password: cam.password });
    return client.getRecordingsForDate(date);
  });
}
