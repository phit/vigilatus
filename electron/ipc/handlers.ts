import { ipcMain } from 'electron';
import path from 'node:path';
import os from 'node:os';
import * as configStore from '../config/store';
import * as streamManager from '../tapo/streamManager';
import { TapoClient } from '../tapo/client';
import type { CameraConfig } from '../types';

type ActiveRecordingPlaybackJob = {
  assetPath?: string;
  cancel: () => void;
  completed: Promise<string>;
};

const recordingsCredentialCache = new Map<string, Pick<CameraConfig, 'host' | 'username' | 'password'>>();
const recordingsClientCache = new Map<string, TapoClient>();
const recordingsUserIdCache = new Map<string, number>();
const activeRecordingPlaybackJobs = new Map<string, ActiveRecordingPlaybackJob>();
const MIN_PLAYBACK_WINDOW_MS = 15_000;
const MAX_PLAYBACK_WINDOW_MS = 120_000;

function formatDateYYYYMMDD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function previousDateYYYYMMDD(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const d = new Date(year, month - 1, day);
  d.setDate(d.getDate() - 1);
  return formatDateYYYYMMDD(d);
}

function dateFromEpochMs(epochMs: number): string {
  return formatDateYYYYMMDD(new Date(epochMs));
}

function primaryCredential(cam: CameraConfig): Pick<CameraConfig, 'host' | 'username' | 'password'> {
  return { host: cam.host, username: cam.username || 'admin', password: cam.password };
}

function stopRecordingPlayback(cameraId: string): void {
  const job = activeRecordingPlaybackJobs.get(cameraId);
  if (!job) return;
  activeRecordingPlaybackJobs.delete(cameraId);
  if (job.assetPath) {
    streamManager.unregisterActivePlaybackAsset(job.assetPath);
  }
  job.cancel();
  void job.completed.catch(() => {
    /* ignore cancellation errors */
  });
}

function normalizePlaybackWindow(startTime: number, endTime: number, requestedTime: number): { startTime: number; endTime: number } {
  const boundedRequestedTime = Math.max(startTime, Math.min(endTime, requestedTime));
  let normalizedStartTime = Math.max(startTime, Math.min(boundedRequestedTime, endTime - MIN_PLAYBACK_WINDOW_MS));
  let normalizedEndTime = Math.min(endTime, normalizedStartTime + MAX_PLAYBACK_WINDOW_MS);

  if (normalizedEndTime - normalizedStartTime < MIN_PLAYBACK_WINDOW_MS) {
    normalizedStartTime = Math.max(startTime, endTime - MIN_PLAYBACK_WINDOW_MS);
    normalizedEndTime = endTime;
  }

  return { startTime: normalizedStartTime, endTime: normalizedEndTime };
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
    stopRecordingPlayback(id);
    recordingsCredentialCache.delete(id);
    recordingsClientCache.delete(id);
    recordingsUserIdCache.delete(id);
    configStore.updateCamera(id, updates);
  });

  ipcMain.handle('cameras:remove', (_e, id: string) => {
    streamManager.stopStream(id);
    stopRecordingPlayback(id);
    recordingsCredentialCache.delete(id);
    recordingsClientCache.delete(id);
    recordingsUserIdCache.delete(id);
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

  ipcMain.handle('stream:start', async (_e, cameraId: string) => {
    stopRecordingPlayback(cameraId);
    const cam = configStore.getCameras().find((c) => c.id === cameraId);
    if (!cam) throw new Error(`Camera ${cameraId} not found`);

    try {
      return await streamManager.startStream(cameraId, cam);
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      if (message.includes('Stream start cancelled')) {
        console.info(`[stream:start:${cameraId}] cancelled before ready`);
        return null;
      }
      throw error;
    }
  });

  ipcMain.handle('stream:stop', (_e, cameraId: string) => {
    stopRecordingPlayback(cameraId);
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

    const credential = recordingsCredentialCache.get(cameraId) ?? primaryCredential(cam);
    const client = recordingsClientCache.get(cameraId) ?? new TapoClient(credential);
    console.info(`[recordings:list:${cameraId}] fetching date=${date} user=${credential.username}`);

    let recordings = await client.getRecordingsForDate(date);

    if (date === formatDateYYYYMMDD(new Date())) {
      const previousDate = previousDateYYYYMMDD(date);
      try {
        const previousDayRecordings = await client.getRecordingsForDate(previousDate);
        if (previousDayRecordings.length > 0) {
          const dedup = new Map<string, (typeof recordings)[number]>();
          for (const rec of [...previousDayRecordings, ...recordings]) {
            dedup.set(`${rec.startTime}:${rec.endTime}`, rec);
          }
          recordings = Array.from(dedup.values()).sort((a, b) => a.startTime - b.startTime);
        }
      } catch {
        // Keep today's recordings even if previous day lookup fails.
      }
    }

    recordingsCredentialCache.set(cameraId, credential);
    recordingsClientCache.set(cameraId, client);
    const resolvedUserId = client.getCachedUserId();
    if (typeof resolvedUserId === 'number') {
      recordingsUserIdCache.set(cameraId, resolvedUserId);
    }
    console.info(`[recordings:list:${cameraId}] fetched ${recordings.length} segments`);
    return recordings;
  });

  ipcMain.handle('recordings:play', async (_e, cameraId: string, startTime: number, endTime: number, requestedTime?: number) => {
    const cam = configStore.getCameras().find((c) => c.id === cameraId);
    if (!cam) throw new Error(`Camera ${cameraId} not found`);

    const playbackWindow = normalizePlaybackWindow(startTime, endTime, requestedTime ?? startTime);
    startTime = playbackWindow.startTime;
    endTime = playbackWindow.endTime;

    let lastError: unknown = null;
    const cachedUserId = recordingsUserIdCache.get(cameraId);

    const tryDownloadWithFallbackWindow = async (
      client: TapoClient,
      userIdHint?: number,
      baseStart: number = startTime,
      baseEnd: number = endTime,
    ): Promise<ActiveRecordingPlaybackJob & { ready: Promise<string> }> => {
      const attempts = [
        { start: baseStart, end: baseEnd, label: 'exact' },
        { start: Math.max(0, baseStart - 5_000), end: baseEnd + 60_000, label: 'wide-60s' },
        { start: Math.max(0, baseStart - 10_000), end: baseEnd + 180_000, label: 'wide-180s' },
      ];

      let attemptError: unknown = null;
      for (const attempt of attempts) {
        const clipKey = `${Math.floor(attempt.start / 1000)}-${Math.floor(attempt.end / 1000)}`;
        const outputDir = path.join(os.tmpdir(), 'tapostudio-playback', cameraId, clipKey);
        try {
          const job = await client.startRecordingPlayback(attempt.start, attempt.end, outputDir, userIdHint);
          await job.ready;
          return job;
        } catch (e) {
          attemptError = e;
          const msg = String((e as Error)?.message ?? e ?? '');
          const shouldRetryWithWiderWindow = msg.includes('Camera closed the recording stream unexpectedly');
          if (!shouldRetryWithWiderWindow) {
            throw e;
          }
          console.info(`[recordings:play:${cameraId}] retrying with ${attempt.label} window failed: ${msg}`);
        }
      }

      throw (attemptError instanceof Error
        ? attemptError
        : new Error('Unable to download recording stream'));
    };

    const tryDownloadNearbySegments = async (
      client: TapoClient,
      userIdHint?: number,
    ): Promise<ActiveRecordingPlaybackJob & { ready: Promise<string> }> => {
      const targetDate = dateFromEpochMs(startTime);
      const targetMid = Math.floor((startTime + endTime) / 2);
      const all = await client.getRecordingsForDate(targetDate);
      const candidates = all
        .filter((r) => r.endTime - r.startTime >= 30_000)
        .filter((r) => !(r.startTime === startTime && r.endTime === endTime))
        .map((r) => ({
          ...r,
          distance: Math.abs(Math.floor((r.startTime + r.endTime) / 2) - targetMid),
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 3);

      let lastNearbyError: unknown = null;
      for (const candidate of candidates) {
        try {
          return await tryDownloadWithFallbackWindow(client, userIdHint, candidate.startTime, candidate.endTime);
        } catch (e) {
          lastNearbyError = e;
          const msg = String((e as Error)?.message ?? e ?? '');
          if (!msg.includes('Camera closed the recording stream unexpectedly')) {
            throw e;
          }
        }
      }

      throw (lastNearbyError instanceof Error
        ? lastNearbyError
        : new Error('Unable to download nearby recording segment'));
    };

    let playbackJob: (ActiveRecordingPlaybackJob & { ready: Promise<string>; assetPath?: string }) | null = null;

    stopRecordingPlayback(cameraId);

    console.info(
      `[recordings:play:${cameraId}] starting foreground download window=${new Date(startTime).toISOString()}..${new Date(endTime).toISOString()} requested=${new Date(requestedTime ?? startTime).toISOString()}`,
    );

    const cachedClient = recordingsClientCache.get(cameraId);
    if (cachedClient) {
      try {
        playbackJob = await tryDownloadWithFallbackWindow(cachedClient, cachedUserId);
        console.info(`[recordings:play:${cameraId}] playback stream started (cached client)`);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e ?? '');
        if (msg.includes('Camera closed the recording stream unexpectedly')) {
          try {
            playbackJob = await tryDownloadNearbySegments(cachedClient, cachedUserId);
            console.info(`[recordings:play:${cameraId}] playback stream started (nearby segments)`);
          } catch (nearbyError) {
            lastError = nearbyError;
          }
        } else {
          lastError = e;
        }
      }
    }

    if (!playbackJob) {
      const credential = recordingsCredentialCache.get(cameraId) ?? primaryCredential(cam);
      const client = new TapoClient(credential);
      try {
        playbackJob = await tryDownloadWithFallbackWindow(client, cachedUserId);
        recordingsCredentialCache.set(cameraId, credential);
        recordingsClientCache.set(cameraId, client);
        const resolvedUserId = client.getCachedUserId();
        if (typeof resolvedUserId === 'number') {
          recordingsUserIdCache.set(cameraId, resolvedUserId);
        }
        console.info(`[recordings:play:${cameraId}] playback stream started`);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e ?? '');
        if (msg.includes('Camera closed the recording stream unexpectedly')) {
          try {
            playbackJob = await tryDownloadNearbySegments(client, cachedUserId);
            console.info(`[recordings:play:${cameraId}] playback stream started (nearby segments)`);
          } catch (nearbyError) {
            lastError = nearbyError;
          }
        } else {
          lastError = e;
        }
      }
    }

    if (!playbackJob) {
      throw (lastError instanceof Error
        ? lastError
        : new Error('Failed to download recording clip'));
    }

    // Ensure live ffmpeg process is not holding this slot while playing back a local clip.
    streamManager.stopStream(cameraId);

    activeRecordingPlaybackJobs.set(cameraId, playbackJob);
    if (playbackJob.assetPath) {
      streamManager.registerActivePlaybackAsset(playbackJob.assetPath, playbackJob.completed);
    }
    void playbackJob.completed.catch(() => undefined).finally(() => {
      if (activeRecordingPlaybackJobs.get(cameraId) === playbackJob) {
        activeRecordingPlaybackJobs.delete(cameraId);
      }
      if (playbackJob.assetPath) {
        streamManager.unregisterActivePlaybackAsset(playbackJob.assetPath);
      }
    });

    const relativeAssetPath = path.relative(path.join(os.tmpdir(), 'tapostudio-playback'), playbackJob.assetPath ?? '');
    const url = streamManager.getPlaybackAssetUrl(relativeAssetPath);
    console.info(`[recordings:play:${cameraId}] returning URL=${url}`);
    return url;
  });
}
