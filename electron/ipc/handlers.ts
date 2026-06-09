import { ipcMain } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { startOfDay } from 'date-fns';
import * as configStore from '../config/store';
import * as streamManager from '../tapo/streamManager';
import { TapoClient } from '../tapo/client';
import type { CameraConfig, RecordingEvent } from '../types';
import type { TestFixtures } from '../testing/fixtures';
import { IPC } from './channels';
import { normalizePlaybackWindow } from './playbackWindow';
import {
  recordingsUserIdCache,
  getOrCreateRecordingsClient,
  clearRecordingsClientCaches,
} from './recordingsClients';
import { acquirePlaybackJob } from './recordingsPlayback';
import { createLogger } from '../log';

type ActiveRecordingPlaybackJob = {
  assetPath?: string;
  cancel: () => void;
  completed: Promise<string>;
};

const recordingEventsCooldownCache = new Map<string, { until: number; reason: string }>();
const activeRecordingPlaybackJobs = new Map<string, ActiveRecordingPlaybackJob>();
const pendingRecordingAborts = new Map<string, AbortController>();
const RECORDING_EVENTS_RETRY_COOLDOWN_MS = 5 * 60_000;

let testFixtures: TestFixtures | null = null;

function requireCamera(cameraId: string): CameraConfig {
  const cam = configStore.getCameras().find((c) => c.id === cameraId);
  if (!cam) throw new Error(`Camera ${cameraId} not found`);
  return cam;
}

function clearRecordingCaches(cameraId: string): void {
  clearRecordingsClientCaches(cameraId);
  recordingEventsCooldownCache.delete(cameraId);
}

function classifyRecordingEventsFailure(error: unknown): string {
  const message = (error as Error)?.message ?? String(error ?? 'unknown error');
  if (message.includes('socket hang up') || message.includes('ECONNRESET')) {
    return 'connection-reset';
  }
  if (message.includes('Secure login: no stok in step-2 response')) {
    return 'login-failed';
  }
  return message;
}

function stopRecordingPlayback(cameraId: string): void {
  pendingRecordingAborts.get(cameraId)?.abort();
  pendingRecordingAborts.delete(cameraId);
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

export function registerHandlers(fixtures: TestFixtures | null = null): void {
  testFixtures = fixtures;

  // ------------------------------------------------------------------
  // Camera config
  // ------------------------------------------------------------------

  ipcMain.handle(IPC.cameras.getAll, () => configStore.getCameras());

  ipcMain.handle(IPC.cameras.add, (_e, cam: CameraConfig) => {
    configStore.addCamera(cam);
  });

  ipcMain.handle(IPC.cameras.update, (_e, id: string, updates: Partial<CameraConfig>) => {
    stopRecordingPlayback(id);
    clearRecordingCaches(id);
    configStore.updateCamera(id, updates);
  });

  ipcMain.handle(IPC.cameras.remove, (_e, id: string) => {
    streamManager.stopStream(id);
    stopRecordingPlayback(id);
    clearRecordingCaches(id);
    configStore.removeCamera(id);
  });

  ipcMain.handle(IPC.cameras.move, (_e, id: string, direction: 'up' | 'down') => {
    configStore.moveCamera(id, direction);
  });

  ipcMain.handle(IPC.cameras.test, (_e, cfg: Pick<CameraConfig, 'host' | 'username' | 'password'>) => {
    const client = new TapoClient(cfg);
    return client.testConnection();
  });

  // ------------------------------------------------------------------
  // Streaming
  // ------------------------------------------------------------------

  ipcMain.handle(IPC.stream.start, async (_e, cameraId: string) => {
    if (testFixtures?.streams) {
      return testFixtures.streams[cameraId] ?? null;
    }
    stopRecordingPlayback(cameraId);
    const cam = requireCamera(cameraId);

    try {
      return await streamManager.startStream(cameraId, cam);
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      if (message.includes('Stream start cancelled')) {
        createLogger(`stream:start:${cameraId}`).info('cancelled before ready');
        return null;
      }
      throw error;
    }
  });

  ipcMain.handle(IPC.stream.stop, (_e, cameraId: string) => {
    stopRecordingPlayback(cameraId);
    streamManager.stopStream(cameraId);
  });

  // ------------------------------------------------------------------
  // Snapshots
  // ------------------------------------------------------------------

  ipcMain.handle(IPC.snapshot.get, (_e, cameraId: string) => {
    if (testFixtures?.snapshots) {
      return testFixtures.snapshots[cameraId] ?? null;
    }
    const cam = requireCamera(cameraId);
    return streamManager.getSnapshot(cameraId, cam);
  });

  // ------------------------------------------------------------------
  // Recordings
  // ------------------------------------------------------------------

  ipcMain.handle(IPC.recordings.list, async (_e, cameraId: string, date: string) => {
    if (testFixtures) {
      return testFixtures.recordings?.[cameraId] ?? [];
    }
    const cam = requireCamera(cameraId);
    const client = getOrCreateRecordingsClient(cameraId, cam);

    const recordings = await client.getRecordingsForDate(date);

    const resolvedUserId = client.getCachedUserId();
    if (typeof resolvedUserId === 'number') {
      recordingsUserIdCache.set(cameraId, resolvedUserId);
    }
    return recordings;
  });

  ipcMain.handle(
    IPC.recordings.events,
    async (_e, cameraId: string, date: string): Promise<RecordingEvent[]> => {
      if (testFixtures) {
        return testFixtures.recordingEvents?.[cameraId] ?? [];
      }

      const cooldown = recordingEventsCooldownCache.get(cameraId);
      if (cooldown && cooldown.until > Date.now()) {
        return [];
      }

      const cam = requireCamera(cameraId);
      const client = getOrCreateRecordingsClient(cameraId, cam);

      try {
        const events = await client.getRecordingEventsForDate(date);
        recordingEventsCooldownCache.delete(cameraId);
        const resolvedUserId = client.getCachedUserId();
        if (typeof resolvedUserId === 'number') {
          recordingsUserIdCache.set(cameraId, resolvedUserId);
        }
        return events;
      } catch (error) {
        const reason = classifyRecordingEventsFailure(error);
        recordingEventsCooldownCache.set(cameraId, {
          until: Date.now() + RECORDING_EVENTS_RETRY_COOLDOWN_MS,
          reason,
        });
        return [];
      }
    },
  );

  ipcMain.handle(
    IPC.recordings.play,
    async (
      _e,
      cameraId: string,
      startTime: number,
      endTime: number,
      requestedTime?: number,
      clipStartTime?: number,
    ) => {
      if (testFixtures?.playbackUrls) {
        return testFixtures.playbackUrls[cameraId] ?? 'about:blank';
      }

      const cam = requireCamera(cameraId);

      const log = createLogger(`recordings:play:${cameraId}`);

      const playbackWindow = normalizePlaybackWindow(startTime, endTime, requestedTime ?? startTime);
      startTime = playbackWindow.startTime;
      endTime = playbackWindow.endTime;

      // Workaround: Tapo cameras ignore start_time for current-day (in-progress) recordings
      // and stream from the beginning of the daily recording file. Compute an ffmpeg -ss offset
      // so the output MP4 starts at the correct position.
      let seekOffsetSec: number | undefined;
      if (typeof clipStartTime === 'number' && clipStartTime > 0) {
        const now = new Date();
        const todayMidnight = startOfDay(now).getTime();
        if (clipStartTime >= todayMidnight) {
          seekOffsetSec = Math.max(0, Math.floor((startTime - clipStartTime) / 1000));
        }
      }

      const cachedUserId = recordingsUserIdCache.get(cameraId);

      stopRecordingPlayback(cameraId);
      // Ensure the live stream process is stopped before requesting playback.
      // Some camera firmware returns incorrect clip content when live and playback
      // are requested concurrently for the same camera.
      streamManager.stopStream(cameraId);

      const abortController = new AbortController();
      pendingRecordingAborts.set(cameraId, abortController);
      const { signal } = abortController;

      log.info(
        `starting foreground download` +
          ` window=${new Date(startTime).toISOString()}..${new Date(endTime).toISOString()}` +
          ` requested=${new Date(requestedTime ?? startTime).toISOString()}` +
          ` clipStart=${clipStartTime ? new Date(clipStartTime).toISOString() : 'N/A'}` +
          ` seekOffset=${seekOffsetSec ?? 'none'}`,
      );

      try {
        const job = await acquirePlaybackJob({
          cameraId,
          cam,
          startTime,
          endTime,
          seekOffsetSec,
          signal,
          cachedUserId,
          log,
        });

        activeRecordingPlaybackJobs.set(cameraId, job);
        if (job.assetPath) {
          streamManager.registerActivePlaybackAsset(job.assetPath, job.completed);
        }
        void job.completed
          .catch(() => undefined)
          .finally(() => {
            if (activeRecordingPlaybackJobs.get(cameraId) === job) {
              activeRecordingPlaybackJobs.delete(cameraId);
            }
            if (job.assetPath) {
              streamManager.unregisterActivePlaybackAsset(job.assetPath);
            }
          });

        const relativeAssetPath = path.relative(
          path.join(os.tmpdir(), 'vigilatus-playback'),
          job.assetPath ?? '',
        );
        const url = streamManager.getPlaybackAssetUrl(relativeAssetPath);
        log.info(`returning URL=${url}`);
        return url;
      } finally {
        if (pendingRecordingAborts.get(cameraId) === abortController) {
          pendingRecordingAborts.delete(cameraId);
        }
      }
    },
  );
}
