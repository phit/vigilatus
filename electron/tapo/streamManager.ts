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
import type { CameraConfig, LiveStreamOptions } from '../types';
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
  probeRtspVideoStream,
  summarizeFfmpegDetails,
  waitForHlsReady,
} from './streamHelpers';
import type { LiveVideoMode } from './ffmpegFragments';
import { closeMediaServer, getHlsPort, startMediaServer } from './mediaServer';
import { startHttpStream } from './httpStream';
import {
  chooseLiveVideoMode,
  copyFailedCameras,
  CopyStartFailedError,
  expectedStops,
  isExpectedStopError,
  markStreamReady,
  notifyStreamDied,
  releaseStreamEntry,
  setOnStreamDied,
  startStreamWatchdog,
  stopAllStreams,
  stopStream,
  stopStreamWatchdog,
  streams,
  type StreamEntry,
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

export function startStream(
  cameraId: string,
  cfg: CameraConfig,
  options: LiveStreamOptions = {},
): Promise<string> {
  const existing = streams.get(cameraId);
  if (existing) return existing.ready;

  if (cfg.streamProtocol === 'http') {
    return startHttpStream(cameraId, cfg, options);
  }

  return startRtspStream(cameraId, cfg, options);
}

/** Codec probe cache keyed by RTSP URL (main and sub streams differ). */
const probedCodecs = new Map<string, string>();

async function resolveRtspVideoCodec(cameraId: string, rtsp: string): Promise<string | undefined> {
  const cached = probedCodecs.get(rtsp);
  if (cached) return cached;
  // Copy already failed for this camera, so the codec can't change the outcome.
  if (copyFailedCameras.has(cameraId)) return undefined;

  const probed = await probeRtspVideoStream(ffmpegBinaryPath, rtsp);
  if (!probed) return undefined;
  const size = probed.width && probed.height ? ` ${probed.width}x${probed.height}` : '';
  createLogger(`stream:${cameraId}`).info(`probed video: ${probed.codec}${size}`);
  probedCodecs.set(rtsp, probed.codec);
  return probed.codec;
}

function startRtspStream(cameraId: string, cfg: CameraConfig, options: LiveStreamOptions): Promise<string> {
  const log = createLogger(`stream:${cameraId}`);
  const segDir = path.join(HLS_DIR, cameraId);
  fs.mkdirSync(segDir, { recursive: true });
  const sessionToken = createHlsSessionToken();
  const m3u8 = path.join(segDir, `stream-${sessionToken}.m3u8`);
  const hlsUrl = `http://127.0.0.1:${getHlsPort()}/${cameraId}/stream-${sessionToken}.m3u8`;
  const quality = options.quality ?? 'main';
  const rtsp = buildRtspUrl(cfg, quality);

  // Registered before the (async) codec probe so a concurrent startStream()
  // dedupes onto it and stopStream() can cancel it.
  const entry: StreamEntry = {
    proc: null,
    hlsUrl,
    playlistPath: m3u8,
    kind: 'live',
    readyResolved: false,
    lastHlsActivityAt: Date.now(),
    ready: Promise.resolve(hlsUrl),
  };
  const isCurrent = () => streams.get(cameraId) === entry;

  entry.ready = (async () => {
    const codec = await resolveRtspVideoCodec(cameraId, rtsp);
    if (!isCurrent()) throw new Error('Stream start cancelled');
    const mode = chooseLiveVideoMode(cameraId, codec, options.hevc);
    log.info(`live ${quality} video ${codec ?? 'unknown'} → ${mode}`);

    if (mode !== 'transcode') {
      try {
        return await runRtspHls(cameraId, entry, rtsp, segDir, m3u8, hlsUrl, sessionToken, mode);
      } catch (err) {
        if (!(err instanceof CopyStartFailedError)) throw err;
        copyFailedCameras.add(cameraId);
        log.warn(`${mode} passthrough failed, falling back to transcoding: ${err.message}`);
        if (!isCurrent()) throw new Error('Stream start cancelled', { cause: err });
        fs.rmSync(m3u8, { force: true });
        entry.lastHlsActivityAt = Date.now();
      }
    }

    return runRtspHls(cameraId, entry, rtsp, segDir, m3u8, hlsUrl, sessionToken, 'transcode');
  })();

  streams.set(cameraId, entry);
  return entry.ready;
}

function runRtspHls(
  cameraId: string,
  entry: StreamEntry,
  rtsp: string,
  segDir: string,
  m3u8: string,
  hlsUrl: string,
  sessionToken: string,
  mode: LiveVideoMode,
): Promise<string> {
  const stderrLines: string[] = [];
  const proc = createHlsCommand(rtsp, segDir, m3u8, sessionToken, mode);
  entry.proc = proc;

  const ready = waitForHlsReady(m3u8, STREAM_READY_TIMEOUT_MS, stderrLines);
  let diedNotified = false;
  // Set once a failed copy attempt is handed back for a transcode retry; its
  // late events must then be ignored, as the retry reuses the same playlist
  // path and therefore the same registry entry.
  let abandoned = false;

  const notifyDiedOnce = () => {
    if (diedNotified) return;
    diedNotified = true;
    notifyStreamDied(cameraId);
  };

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const abandonForFallback = (message: string): boolean => {
      if (mode === 'transcode' || settled) return false;
      settled = true;
      abandoned = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new CopyStartFailedError(message));
      return true;
    };

    attachFfmpegStderr(proc, stderrLines);

    // All cleanup below is session-scoped via releaseStreamEntry(cameraId, m3u8):
    // these handlers can fire after stopStream() and a restart have replaced the
    // registry entry with a newer session's, which must be left untouched and
    // must not be reported as died.
    onFfmpegError(proc, (err: Error, _stdout: string, stderr: string) => {
      if (abandoned) return;
      if (isExpectedStopError(cameraId, err)) {
        expectedStops.delete(cameraId);
        releaseStreamEntry(cameraId, m3u8);
        if (!settled) {
          settled = true;
          reject(new Error('Stream start cancelled'));
        }
        return;
      }

      const details = summarizeFfmpegDetails(stderr?.trim() || stderrLines.join('\n').trim());
      const message = details ? `${err.message}: ${details}` : err.message;
      if (abandonForFallback(message)) return;
      createLogger(`stream:${cameraId}`).error(`error:`, message);
      const wasCurrent = releaseStreamEntry(cameraId, m3u8);
      if (!settled) {
        settled = true;
        reject(new Error(message));
      }
      if (wasCurrent) {
        notifyDiedOnce();
      }
    });

    proc.on('end', () => {
      if (abandoned) return;
      if (abandonForFallback('ffmpeg exited before the stream was ready')) return;
      const wasExpected = expectedStops.has(cameraId);
      expectedStops.delete(cameraId);
      const wasCurrent = releaseStreamEntry(cameraId, m3u8);
      if (!wasExpected && settled && wasCurrent) {
        notifyDiedOnce();
      }
    });

    void ready
      .then(() => {
        if (abandoned) return;
        markStreamReady(cameraId, m3u8);
        if (!settled) {
          settled = true;
          resolve(hlsUrl);
        }
      })
      .catch((err: Error) => {
        if (abandoned) return;
        if (abandonForFallback(err.message)) return;
        const wasCurrent = releaseStreamEntry(cameraId, m3u8);
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        if (!settled) {
          settled = true;
          reject(err);
          if (wasCurrent) {
            notifyDiedOnce();
          }
        }
      });
  });
}
