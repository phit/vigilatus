import { ipcMain } from 'electron';
import * as configStore from '../config/store';
import * as streamManager from '../tapo/streamManager';
import { TapoClient } from '../tapo/client';
import type { CameraConfig } from '../types';

function buildCredentialCandidates(cam: CameraConfig): Array<Pick<CameraConfig, 'host' | 'username' | 'password'>> {
  const candidates: Array<Pick<CameraConfig, 'host' | 'username' | 'password'>> = [
    { host: cam.host, username: cam.username, password: cam.password },
  ];

  if (cam.streamUser && cam.streamPassword) {
    const sameAsPrimary = cam.streamUser === cam.username && cam.streamPassword === cam.password;
    if (!sameAsPrimary) {
      candidates.push({ host: cam.host, username: cam.streamUser, password: cam.streamPassword });
    }
  }

  if (cam.password && cam.username !== 'admin') {
    candidates.push({ host: cam.host, username: 'admin', password: cam.password });
  }

  return candidates;
}

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

    const candidates = buildCredentialCandidates(cam);
    let lastError: unknown = null;

    for (const candidate of candidates) {
      try {
        const client = new TapoClient(candidate);
        const recordings = await client.getRecordingsForDate(date);
        return recordings;
      } catch (e) {
        lastError = e;
      }
    }

    console.warn(`[recordings:list:${cameraId}] failed for ${date}:`, (lastError as Error)?.message ?? lastError);
    return [];
  });

  ipcMain.handle('recordings:play', async (_e, cameraId: string, startTime: number, endTime: number) => {
    const cam = configStore.getCameras().find((c) => c.id === cameraId);
    if (!cam) throw new Error(`Camera ${cameraId} not found`);

    const candidates = buildCredentialCandidates(cam);
    let lastError: unknown = null;
    let localFile = '';

    for (const candidate of candidates) {
      try {
        const client = new TapoClient(candidate);
        localFile = await client.downloadRecording(startTime, endTime);
        break;
      } catch (e) {
        lastError = e;
      }
    }

    if (!localFile) {
      throw (lastError instanceof Error
        ? lastError
        : new Error('Unable to authenticate for recording playback'));
    }

    // Ensure live ffmpeg process is not holding this slot while playing back a local clip.
    streamManager.stopStream(cameraId);
    return streamManager.getPlaybackUrl(cameraId, localFile);
  });
}
