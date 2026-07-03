/**
 * Stream registry — owns the per-camera live-stream state, the "stream died"
 * notification, stream teardown, and the stall watchdog. Kept dependency-free of
 * the higher-level start/snapshot logic so other stream modules can share this
 * state without import cycles.
 */

import fs from 'node:fs';
import path from 'node:path';
import type ffmpeg from 'fluent-ffmpeg';
import type { ChildProcess } from 'node:child_process';
import type { MediaSession } from './mediaSession';
import { createLogger } from '../log';
import {
  EXPECTED_STOP_CLEAR_DELAY_MS,
  HLS_DIR,
  LIVE_STREAM_STALL_TIMEOUT_MS,
  STREAM_WATCHDOG_INTERVAL_MS,
} from './streamConstants';

export interface StreamEntry {
  proc: ffmpeg.FfmpegCommand | null;
  hlsUrl: string;
  playlistPath: string;
  kind: 'live' | 'playback';
  readyResolved: boolean;
  lastHlsActivityAt: number;
  ready: Promise<string>;
  /** HTTP Media Session resources (non-RTSP streams) */
  httpSession?: MediaSession;
  httpFfmpeg?: ChildProcess;
}

export const streams = new Map<string, StreamEntry>();
export const expectedStops = new Set<string>();

let streamWatchdogTimer: NodeJS.Timeout | null = null;
let onStreamDiedCallback: ((cameraId: string) => void) | null = null;

/** Register a callback invoked when a live stream dies unexpectedly. */
export function setOnStreamDied(callback: (cameraId: string) => void): void {
  onStreamDiedCallback = callback;
}

/** Notify the registered listener that a stream died unexpectedly. */
export function notifyStreamDied(cameraId: string): void {
  onStreamDiedCallback?.(cameraId);
}

/**
 * Session-scoped removal of a camera's registry entry: delete it only when it
 * still belongs to the session identified by `playlistPath`, and report whether
 * it did. Cleanup handlers of an old ffmpeg process can fire after a restart
 * has registered a new entry under the same camera id; a blind
 * `streams.delete(cameraId)` would unregister the healthy new stream — hiding
 * it from the stall watchdog and orphaning its process on the next stop. A
 * caller that gets `false` must treat itself as stale and not report the
 * camera as died.
 */
export function releaseStreamEntry(cameraId: string, playlistPath: string): boolean {
  const entry = streams.get(cameraId);
  if (!entry || entry.playlistPath !== playlistPath) return false;
  streams.delete(cameraId);
  return true;
}

export function isExpectedStopError(cameraId: string, err: Error): boolean {
  const message = String(err?.message ?? '');
  return expectedStops.has(cameraId) && message.includes('killed with signal SIGKILL');
}

export function stopStream(cameraId: string): void {
  const entry = streams.get(cameraId);
  if (!entry) return;
  expectedStops.add(cameraId);
  setTimeout(() => {
    expectedStops.delete(cameraId);
  }, EXPECTED_STOP_CLEAR_DELAY_MS);

  // Stop HTTP Media Session resources if present
  if (entry.httpFfmpeg && !entry.httpFfmpeg.killed) {
    try {
      entry.httpFfmpeg.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  if (entry.httpSession) {
    void entry.httpSession.close().catch(() => {
      /* ignore */
    });
  }

  // Stop RTSP ffmpeg process if present
  if (entry.proc) {
    try {
      entry.proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  streams.delete(cameraId);

  // Clean up segment files
  const segDir = path.join(HLS_DIR, cameraId);
  try {
    fs.rmSync(segDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function stopAllStreams(): void {
  for (const id of streams.keys()) stopStream(id);
}

// ---------------------------------------------------------------------------
// Stall watchdog
// ---------------------------------------------------------------------------

export function startStreamWatchdog(): void {
  if (streamWatchdogTimer) return;
  streamWatchdogTimer = setInterval(() => {
    checkLiveStreamsForStall();
  }, STREAM_WATCHDOG_INTERVAL_MS);
}

export function stopStreamWatchdog(): void {
  if (streamWatchdogTimer) {
    clearInterval(streamWatchdogTimer);
    streamWatchdogTimer = null;
  }
}

export function markStreamReady(cameraId: string, playlistPath: string): void {
  const entry = streams.get(cameraId);
  if (!entry || entry.playlistPath !== playlistPath) return;
  entry.readyResolved = true;
  entry.lastHlsActivityAt = getLatestHlsActivityAt(entry) ?? Date.now();
}

function checkLiveStreamsForStall(): void {
  const now = Date.now();
  for (const [cameraId, entry] of streams.entries()) {
    if (entry.kind !== 'live' || !entry.readyResolved) {
      continue;
    }

    const latestActivityAt = getLatestHlsActivityAt(entry);
    if (latestActivityAt && latestActivityAt > entry.lastHlsActivityAt) {
      entry.lastHlsActivityAt = latestActivityAt;
    }

    if (now - entry.lastHlsActivityAt < LIVE_STREAM_STALL_TIMEOUT_MS) {
      continue;
    }

    const secondsStalled = Math.round((now - entry.lastHlsActivityAt) / 1000);
    createLogger(`stream:${cameraId}`).error(
      `watchdog detected stalled live HLS output; no playlist/segment updates for ${secondsStalled}s`,
    );
    failLiveStream(cameraId, `watchdog stall after ${secondsStalled}s without HLS updates`);
  }
}

function getLatestHlsActivityAt(entry: StreamEntry): number | null {
  try {
    if (!fs.existsSync(entry.playlistPath)) {
      return null;
    }

    let latestMtimeMs = fs.statSync(entry.playlistPath).mtimeMs;
    const playlist = fs.readFileSync(entry.playlistPath, 'utf8');
    for (const line of playlist.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const segmentPath = path.resolve(path.dirname(entry.playlistPath), trimmed);
      if (!fs.existsSync(segmentPath)) continue;
      latestMtimeMs = Math.max(latestMtimeMs, fs.statSync(segmentPath).mtimeMs);
    }

    return latestMtimeMs;
  } catch {
    return null;
  }
}

function failLiveStream(cameraId: string, reason: string): void {
  if (!streams.has(cameraId)) return;
  createLogger(`stream:${cameraId}`).error(`marking live stream as dead: ${reason}`);
  stopStream(cameraId);
  notifyStreamDied(cameraId);
}
