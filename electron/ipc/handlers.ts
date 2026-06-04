import { ipcMain } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { format, startOfDay } from 'date-fns';
import * as configStore from '../config/store';
import * as streamManager from '../tapo/streamManager';
import { TapoClient } from '../tapo/client';
import type { CameraConfig, Recording, RecordingEvent } from '../types';
import type { TestFixtures } from '../testing/fixtures';
import { IPC } from './channels';
import { createLogger } from '../log';

type ActiveRecordingPlaybackJob = {
  assetPath?: string;
  cancel: () => void;
  completed: Promise<string>;
};

const recordingsCredentialCache = new Map<string, Pick<CameraConfig, 'host' | 'username' | 'password'>>();
const recordingsClientCache = new Map<string, TapoClient>();
const recordingsUserIdCache = new Map<string, number>();
const recordingEventsCooldownCache = new Map<string, { until: number; reason: string }>();
const activeRecordingPlaybackJobs = new Map<string, ActiveRecordingPlaybackJob>();
const pendingRecordingAborts = new Map<string, AbortController>();
const MIN_PLAYBACK_WINDOW_MS = 15_000;
const MAX_PLAYBACK_WINDOW_MS = 120_000;
const RECORDING_EVENTS_RETRY_COOLDOWN_MS = 5 * 60_000;

let testFixtures: TestFixtures | null = null;

function dateFromEpochMs(epochMs: number): string {
  return format(epochMs, 'yyyyMMdd');
}

function primaryCredential(cam: CameraConfig): Pick<CameraConfig, 'host' | 'username' | 'password'> {
  return { host: cam.host, username: cam.username || 'admin', password: cam.password };
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

function normalizePlaybackWindow(
  startTime: number,
  endTime: number,
  requestedTime: number,
): { startTime: number; endTime: number } {
  const boundedRequestedTime = Math.max(startTime, Math.min(endTime, requestedTime));
  let normalizedStartTime = Math.max(
    startTime,
    Math.min(boundedRequestedTime, endTime - MIN_PLAYBACK_WINDOW_MS),
  );
  let normalizedEndTime = Math.min(endTime, normalizedStartTime + MAX_PLAYBACK_WINDOW_MS);

  if (normalizedEndTime - normalizedStartTime < MIN_PLAYBACK_WINDOW_MS) {
    normalizedStartTime = Math.max(startTime, endTime - MIN_PLAYBACK_WINDOW_MS);
    normalizedEndTime = endTime;
  }

  return { startTime: normalizedStartTime, endTime: normalizedEndTime };
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
    recordingsCredentialCache.delete(id);
    recordingsClientCache.delete(id);
    recordingsUserIdCache.delete(id);
    recordingEventsCooldownCache.delete(id);
    configStore.updateCamera(id, updates);
  });

  ipcMain.handle(IPC.cameras.remove, (_e, id: string) => {
    streamManager.stopStream(id);
    stopRecordingPlayback(id);
    recordingsCredentialCache.delete(id);
    recordingsClientCache.delete(id);
    recordingsUserIdCache.delete(id);
    recordingEventsCooldownCache.delete(id);
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
    const cam = configStore.getCameras().find((c) => c.id === cameraId);
    if (!cam) throw new Error(`Camera ${cameraId} not found`);

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

  ipcMain.handle(IPC.stream.playback, (_e, cameraId: string, seekSeconds: number) => {
    const cam = configStore.getCameras().find((c) => c.id === cameraId);
    if (!cam) throw new Error(`Camera ${cameraId} not found`);
    return streamManager.startPlayback(cameraId, cam, seekSeconds);
  });

  // ------------------------------------------------------------------
  // Snapshots
  // ------------------------------------------------------------------

  ipcMain.handle(IPC.snapshot.get, (_e, cameraId: string) => {
    if (testFixtures?.snapshots) {
      return testFixtures.snapshots[cameraId] ?? null;
    }
    const cam = configStore.getCameras().find((c) => c.id === cameraId);
    if (!cam) return null;
    return streamManager.getSnapshot(cameraId, cam);
  });

  // ------------------------------------------------------------------
  // Recordings
  // ------------------------------------------------------------------

  ipcMain.handle(IPC.recordings.list, async (_e, cameraId: string, date: string) => {
    if (testFixtures) {
      return testFixtures.recordings?.[cameraId] ?? [];
    }
    const cam = configStore.getCameras().find((c) => c.id === cameraId);
    if (!cam) return [];

    const credential = recordingsCredentialCache.get(cameraId) ?? primaryCredential(cam);
    let client = recordingsClientCache.get(cameraId);
    if (!client) {
      client = new TapoClient(credential);
      recordingsCredentialCache.set(cameraId, credential);
      recordingsClientCache.set(cameraId, client);
    }

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

      const cam = configStore.getCameras().find((c) => c.id === cameraId);
      if (!cam) return [];

      const credential = recordingsCredentialCache.get(cameraId) ?? primaryCredential(cam);
      let client = recordingsClientCache.get(cameraId);
      if (!client) {
        client = new TapoClient(credential);
        recordingsCredentialCache.set(cameraId, credential);
        recordingsClientCache.set(cameraId, client);
      }

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

      const cam = configStore.getCameras().find((c) => c.id === cameraId);
      if (!cam) throw new Error(`Camera ${cameraId} not found`);

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

      let lastError: unknown = null;
      const cachedUserId = recordingsUserIdCache.get(cameraId);

      stopRecordingPlayback(cameraId);
      // Ensure the live stream process is stopped before requesting playback.
      // Some camera firmware returns incorrect clip content when live and playback
      // are requested concurrently for the same camera.
      streamManager.stopStream(cameraId);

      const abortController = new AbortController();
      pendingRecordingAborts.set(cameraId, abortController);
      const { signal } = abortController;

      const withAbort = <T>(promise: Promise<T>): Promise<T> =>
        signal.aborted
          ? Promise.reject(new Error('Recording playback cancelled'))
          : Promise.race([
              promise,
              new Promise<never>((_, reject) => {
                signal.addEventListener('abort', () => reject(new Error('Recording playback cancelled')), {
                  once: true,
                });
              }),
            ]);

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
          if (signal.aborted) throw new Error('Recording playback cancelled');
          const clipKey = `${Math.floor(attempt.start / 1000)}-${Math.floor(attempt.end / 1000)}`;
          const outputDir = path.join(os.tmpdir(), 'vigilatus-playback', cameraId, clipKey);
          let job: (ActiveRecordingPlaybackJob & { ready: Promise<string> }) | null = null;
          try {
            job = await client.startRecordingPlayback(
              attempt.start,
              attempt.end,
              outputDir,
              userIdHint,
              seekOffsetSec,
            );
            await withAbort(job.ready);
            return job;
          } catch (e) {
            job?.cancel();
            attemptError = e;
            const msg = String((e as Error)?.message ?? e ?? '');
            if (signal.aborted) throw new Error('Recording playback cancelled');
            const shouldRetryWithWiderWindow = msg.includes(
              'Camera closed the recording stream unexpectedly',
            );
            if (!shouldRetryWithWiderWindow) {
              throw e;
            }
            log.info(`retrying with ${attempt.label} window failed: ${msg}`);
          }
        }

        throw attemptError instanceof Error ? attemptError : new Error('Unable to download recording stream');
      };

      const tryDownloadNearbySegments = async (
        client: TapoClient,
        userIdHint?: number,
      ): Promise<ActiveRecordingPlaybackJob & { ready: Promise<string> }> => {
        if (signal.aborted) throw new Error('Recording playback cancelled');
        const targetDate = dateFromEpochMs(startTime);
        const targetMid = Math.floor((startTime + endTime) / 2);
        const all = await withAbort(client.getRecordingsForDate(targetDate));
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
          if (signal.aborted) throw new Error('Recording playback cancelled');
          try {
            return await tryDownloadWithFallbackWindow(
              client,
              userIdHint,
              candidate.startTime,
              candidate.endTime,
            );
          } catch (e) {
            lastNearbyError = e;
            const msg = String((e as Error)?.message ?? e ?? '');
            if (signal.aborted) throw new Error('Recording playback cancelled');
            if (!msg.includes('Camera closed the recording stream unexpectedly')) {
              throw e;
            }
          }
        }

        throw lastNearbyError instanceof Error
          ? lastNearbyError
          : new Error('Unable to download nearby recording segment');
      };

      let playbackJob: (ActiveRecordingPlaybackJob & { ready: Promise<string>; assetPath?: string }) | null =
        null;

      log.info(
        `starting foreground download` +
          ` window=${new Date(startTime).toISOString()}..${new Date(endTime).toISOString()}` +
          ` requested=${new Date(requestedTime ?? startTime).toISOString()}` +
          ` clipStart=${clipStartTime ? new Date(clipStartTime).toISOString() : 'N/A'}` +
          ` seekOffset=${seekOffsetSec ?? 'none'}`,
      );

      try {
        const cachedClient = recordingsClientCache.get(cameraId);
        if (cachedClient) {
          try {
            playbackJob = await tryDownloadWithFallbackWindow(cachedClient, cachedUserId);
            log.info('playback stream started (cached client)');
          } catch (e) {
            const msg = String((e as Error)?.message ?? e ?? '');
            if (signal.aborted) throw new Error('Recording playback cancelled');
            if (msg.includes('Camera closed the recording stream unexpectedly')) {
              try {
                playbackJob = await tryDownloadNearbySegments(cachedClient, cachedUserId);
                log.info('playback stream started (nearby segments)');
              } catch (nearbyError) {
                if (signal.aborted) throw new Error('Recording playback cancelled');
                lastError = nearbyError;
              }
            } else {
              lastError = e;
            }
          }
        }

        if (!playbackJob) {
          if (signal.aborted) throw new Error('Recording playback cancelled');
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
            log.info('playback stream started');
          } catch (e) {
            const msg = String((e as Error)?.message ?? e ?? '');
            if (signal.aborted) throw new Error('Recording playback cancelled');
            if (msg.includes('Camera closed the recording stream unexpectedly')) {
              try {
                playbackJob = await tryDownloadNearbySegments(client, cachedUserId);
                log.info('playback stream started (nearby segments)');
              } catch (nearbyError) {
                if (signal.aborted) throw new Error('Recording playback cancelled');
                lastError = nearbyError;
              }
            } else {
              lastError = e;
            }
          }
        }

        if (!playbackJob) {
          throw lastError instanceof Error ? lastError : new Error('Failed to download recording clip');
        }

        // Capture into a const so the non-null narrowing survives into the
        // deferred .finally() closure below (playbackJob is a mutable let).
        const job = playbackJob;
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
