/**
 * StreamManager — lifecycle orchestration plus live RTSP→HLS transcoding.
 *
 * Companion modules: ./streamConstants (shared constants), ./streamHelpers
 * (stateless helpers), ./streamRegistry (stream state + stall watchdog),
 * ./mediaServer (loopback HTTP server), ./httpStream (HTTP media-session
 * live streaming), and ./snapshots (snapshot capture).
 */

import ffmpeg from 'fluent-ffmpeg';
import fs from 'node:fs';
import path from 'node:path';
import type { CameraConfig } from '../types';
import { ffmpegBinaryPath } from './ffmpegPath';
import { createLogger } from '../log';
import {
  HLS_DIR,
  PLAYBACK_DIR,
  RECORDING_MAX_AGE_MS,
  RECORDINGS_DIR,
  SNAP_DIR,
  STREAM_READY_TIMEOUT_MS,
} from './streamConstants';
import {
  attachFfmpegStderr,
  buildRtspUrl,
  createHlsCommand,
  createHlsSessionToken,
  onFfmpegError,
  summarizeFfmpegDetails,
  waitForHlsReady,
} from './streamHelpers';
import { closeMediaServer, getHlsPort, startMediaServer } from './mediaServer';
import { startHttpStream } from './httpStream';
import {
  expectedStops,
  isExpectedStopError,
  markStreamReady,
  notifyStreamDied,
  setOnStreamDied,
  startStreamWatchdog,
  stopAllStreams,
  stopStream,
  stopStreamWatchdog,
  streams,
} from './streamRegistry';

export {
  getPlaybackAssetUrl,
  registerActivePlaybackAsset,
  unregisterActivePlaybackAsset,
} from './mediaServer';
export { setOnStreamDied, stopAllStreams, stopStream };
export { getSnapshot } from './snapshots';

// ---------------------------------------------------------------------------
// Init / teardown
// ---------------------------------------------------------------------------

/** Remove leftover temp dirs from a previous session and recreate them fresh. */
function cleanStaleTempDirs(): void {
  for (const dir of [HLS_DIR, SNAP_DIR, PLAYBACK_DIR]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Delete recording cache files older than RECORDING_MAX_AGE_MS. */
function purgeOldRecordings(): void {
  if (!fs.existsSync(RECORDINGS_DIR)) return;
  const now = Date.now();
  try {
    for (const hostDir of fs.readdirSync(RECORDINGS_DIR)) {
      const hostPath = path.join(RECORDINGS_DIR, hostDir);
      const stat = fs.statSync(hostPath);
      if (!stat.isDirectory()) continue;
      for (const file of fs.readdirSync(hostPath)) {
        const filePath = path.join(hostPath, file);
        try {
          const fstat = fs.statSync(filePath);
          if (now - fstat.mtimeMs > RECORDING_MAX_AGE_MS) {
            fs.unlinkSync(filePath);
          }
        } catch {
          /* skip inaccessible files */
        }
      }
      // Remove the host dir if empty
      try {
        const remaining = fs.readdirSync(hostPath);
        if (remaining.length === 0) fs.rmdirSync(hostPath);
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    createLogger('streamManager').error('Failed to purge old recordings:', err);
  }
}

export async function init(): Promise<void> {
  try {
    ffmpeg.setFfmpegPath(ffmpegBinaryPath);
  } catch (err) {
    createLogger('streamManager:init').error('Failed to resolve ffmpeg path:', err);
    throw err;
  }

  cleanStaleTempDirs();
  purgeOldRecordings();

  fs.mkdirSync(HLS_DIR, { recursive: true });
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.mkdirSync(PLAYBACK_DIR, { recursive: true });

  await startMediaServer();
  startStreamWatchdog();
}

export function cleanup(): void {
  for (const id of streams.keys()) stopStream(id);
  stopStreamWatchdog();
  closeMediaServer();
  // Remove ephemeral temp dirs (recordings cache is intentionally kept)
  for (const dir of [HLS_DIR, SNAP_DIR, PLAYBACK_DIR]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Live stream
// ---------------------------------------------------------------------------

export function startStream(cameraId: string, cfg: CameraConfig): Promise<string> {
  const existing = streams.get(cameraId);
  if (existing) return existing.ready;

  if (cfg.streamProtocol === 'http') {
    return startHttpStream(cameraId, cfg);
  }

  return startRtspStream(cameraId, cfg);
}

function startRtspStream(cameraId: string, cfg: CameraConfig): Promise<string> {
  const segDir = path.join(HLS_DIR, cameraId);
  fs.mkdirSync(segDir, { recursive: true });
  const sessionToken = createHlsSessionToken();
  const m3u8 = path.join(segDir, `stream-${sessionToken}.m3u8`);
  const hlsUrl = `http://127.0.0.1:${getHlsPort()}/${cameraId}/stream-${sessionToken}.m3u8`;
  const rtsp = buildRtspUrl(cfg, 'main');
  const stderrLines: string[] = [];
  const proc = createHlsCommand(rtsp, segDir, m3u8, sessionToken);

  const ready = waitForHlsReady(m3u8, STREAM_READY_TIMEOUT_MS, stderrLines);
  let diedNotified = false;

  const notifyDiedOnce = () => {
    if (diedNotified) return;
    diedNotified = true;
    notifyStreamDied(cameraId);
  };

  const streamReady = new Promise<string>((resolve, reject) => {
    let settled = false;

    attachFfmpegStderr(proc, stderrLines);

    onFfmpegError(proc, (err: Error, _stdout: string, stderr: string) => {
      if (isExpectedStopError(cameraId, err)) {
        expectedStops.delete(cameraId);
        streams.delete(cameraId);
        if (!settled) {
          settled = true;
          reject(new Error('Stream start cancelled'));
        }
        return;
      }

      const details = summarizeFfmpegDetails(stderr?.trim() || stderrLines.join('\n').trim());
      const message = details ? `${err.message}: ${details}` : err.message;
      createLogger(`stream:${cameraId}`).error(`error:`, message);
      streams.delete(cameraId);
      if (!settled) {
        settled = true;
        reject(new Error(message));
      }
      notifyDiedOnce();
    });

    proc.on('end', () => {
      const wasExpected = expectedStops.has(cameraId);
      expectedStops.delete(cameraId);
      streams.delete(cameraId);
      if (!wasExpected && settled) {
        notifyDiedOnce();
      }
    });

    void ready
      .then(() => {
        markStreamReady(cameraId, m3u8);
        if (!settled) {
          settled = true;
          resolve(hlsUrl);
        }
      })
      .catch((err: Error) => {
        streams.delete(cameraId);
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        if (!settled) {
          settled = true;
          reject(err);
          notifyDiedOnce();
        }
      });
  });

  streams.set(cameraId, {
    proc,
    hlsUrl,
    playlistPath: m3u8,
    kind: 'live',
    readyResolved: false,
    lastHlsActivityAt: Date.now(),
    ready: streamReady,
  });
  return streamReady;
}
