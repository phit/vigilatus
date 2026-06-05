import path from 'node:path';
import os from 'node:os';
import { format } from 'date-fns';
import { TapoClient } from '../tapo/client';
import type { CameraConfig } from '../types';
import type { createLogger } from '../log';
import {
  recordingsClientCache,
  recordingsCredentialCache,
  recordingsUserIdCache,
  primaryCredential,
} from './recordingsClients';

type ActiveRecordingPlaybackJob = {
  assetPath?: string;
  cancel: () => void;
  completed: Promise<string>;
};

export type AcquirePlaybackJobParams = {
  cameraId: string;
  cam: CameraConfig;
  startTime: number;
  endTime: number;
  seekOffsetSec: number | undefined;
  signal: AbortSignal;
  cachedUserId: number | undefined;
  log: ReturnType<typeof createLogger>;
};

function dateFromEpochMs(epochMs: number): string {
  return format(epochMs, 'yyyyMMdd');
}

export async function acquirePlaybackJob(
  params: AcquirePlaybackJobParams,
): Promise<ActiveRecordingPlaybackJob & { ready: Promise<string>; assetPath?: string }> {
  const { cameraId, cam, startTime, endTime, seekOffsetSec, signal, cachedUserId, log } = params;

  let lastError: unknown = null;

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
        const shouldRetryWithWiderWindow = msg.includes('Camera closed the recording stream unexpectedly');
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

  // Runs the shared fallback ladder for a single client: try the windowed
  // download first, then (only for the "Camera closed ... unexpectedly"
  // failure) the nearby-segments path. Returns the job and reports whether
  // the nearby-segments fallback was used so callers can log accurately.
  const acquireForClient = async (
    client: TapoClient,
    userIdHint?: number,
  ): Promise<{
    job: ActiveRecordingPlaybackJob & { ready: Promise<string>; assetPath?: string };
    viaNearby: boolean;
  }> => {
    try {
      return { job: await tryDownloadWithFallbackWindow(client, userIdHint), viaNearby: false };
    } catch (e) {
      if (signal.aborted) throw new Error('Recording playback cancelled');
      const msg = String((e as Error)?.message ?? e ?? '');
      if (!msg.includes('Camera closed the recording stream unexpectedly')) throw e;
      return { job: await tryDownloadNearbySegments(client, userIdHint), viaNearby: true };
    }
  };

  const cachedClient = recordingsClientCache.get(cameraId);
  const credential = recordingsCredentialCache.get(cameraId) ?? primaryCredential(cam);
  // Ordered client sources: the cached client first (when present), then a
  // freshly-built one. The fresh client is created lazily via getClient()
  // so the common cached-success path doesn't allocate an unused client.
  const sources: Array<{ getClient: () => TapoClient; persist: boolean }> = [];
  if (cachedClient) {
    sources.push({ getClient: () => cachedClient, persist: false });
  }
  sources.push({ getClient: () => new TapoClient(credential), persist: true });

  for (const source of sources) {
    if (signal.aborted) throw new Error('Recording playback cancelled');
    const client = source.getClient();
    try {
      const { job, viaNearby } = await acquireForClient(client, cachedUserId);
      playbackJob = job;
      if (source.persist) {
        recordingsCredentialCache.set(cameraId, credential);
        recordingsClientCache.set(cameraId, client);
        const resolvedUserId = client.getCachedUserId();
        if (typeof resolvedUserId === 'number') {
          recordingsUserIdCache.set(cameraId, resolvedUserId);
        }
      }
      if (viaNearby) {
        log.info('playback stream started (nearby segments)');
      } else if (source.persist) {
        log.info('playback stream started');
      } else {
        log.info('playback stream started (cached client)');
      }
      break;
    } catch (e) {
      if (signal.aborted) throw new Error('Recording playback cancelled');
      lastError = e;
    }
  }

  if (!playbackJob) {
    throw lastError instanceof Error ? lastError : new Error('Failed to download recording clip');
  }

  return playbackJob;
}
