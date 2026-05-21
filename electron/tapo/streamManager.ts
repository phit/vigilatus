/**
 * StreamManager — manages ffmpeg RTSP→HLS transcoding and snapshot capture.
 *
 * One ffmpeg process per camera.  An embedded HTTP server on a random
 * loopback port serves the HLS segments to the renderer.
 */

import ffmpeg from 'fluent-ffmpeg';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { CameraConfig } from '../types';
import { ffmpegBinaryPath } from './ffmpegPath';
import { MediaSession, hashMediaPassword, writeAlignedTsPackets } from './recordingDownloader';
import * as configStore from '../config/store';

type HashMethod = 'md5' | 'sha256';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HLS_DIR = path.join(os.tmpdir(), 'vigilatus-hls');
const SNAP_DIR = path.join(os.tmpdir(), 'vigilatus-snaps');
const PLAYBACK_DIR = path.join(os.tmpdir(), 'vigilatus-playback');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface StreamEntry {
  proc: ffmpeg.FfmpegCommand | null;
  hlsUrl: string;
  ready: Promise<string>;
  /** HTTP Media Session resources (non-RTSP streams) */
  httpSession?: MediaSession;
  httpFfmpeg?: ChildProcess;
}

const streams = new Map<string, StreamEntry>();
const expectedStops = new Set<string>();
/** Per-camera in-progress snapshot promise (prevents parallel captures) */
const snapshotLocks = new Map<string, Promise<string | null>>();
const activePlaybackAssets = new Map<string, Promise<unknown>>();
let server: http.Server | null = null;
let hlsPort = 0;

const STREAM_READY_TIMEOUT_MS = 15_000;
const HTTP_STREAM_READY_TIMEOUT_MS = 30_000;
const STREAM_READY_POLL_MS = 250;
const STDERR_HISTORY_LIMIT = 24;
const MIN_PLAYBACK_FILE_BYTES = 512_000;
const RECORDINGS_DIR = path.join(os.tmpdir(), 'vigilatus-recordings');
const RECORDING_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const LIVE_HLS_SEGMENT_SECONDS = 1;
const LIVE_HLS_PLAYLIST_SIZE = 3;
const LIVE_AUDIO_FILTER = 'aresample=async=1:first_pts=0';

function isExpectedStopError(cameraId: string, err: Error): boolean {
  const message = String(err?.message ?? '');
  return expectedStops.has(cameraId) && message.includes('killed with signal SIGKILL');
}

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
    console.error('[streamManager] Failed to purge old recordings:', err);
  }
}

export async function init(): Promise<void> {
  try {
    ffmpeg.setFfmpegPath(ffmpegBinaryPath);
  } catch (err) {
    console.error('[streamManager:init] Failed to resolve ffmpeg path:', err);
    throw err;
  }

  cleanStaleTempDirs();
  purgeOldRecordings();

  fs.mkdirSync(HLS_DIR, { recursive: true });
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.mkdirSync(PLAYBACK_DIR, { recursive: true });

  hlsPort = await startServer();
}

export function cleanup(): void {
  for (const id of streams.keys()) stopStream(id);
  server?.close();
  server?.closeAllConnections();
  // Remove ephemeral temp dirs (recordings cache is intentionally kept)
  for (const dir of [HLS_DIR, SNAP_DIR, PLAYBACK_DIR]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

export function stopAllStreams(): void {
  for (const id of streams.keys()) stopStream(id);
}

export function registerActivePlaybackAsset(filePath: string, completed: Promise<unknown>): void {
  const resolvedPath = path.resolve(filePath);
  const tracked = completed.finally(() => {
    if (activePlaybackAssets.get(resolvedPath) === tracked) {
      activePlaybackAssets.delete(resolvedPath);
    }
  });
  activePlaybackAssets.set(resolvedPath, tracked);
}

export function unregisterActivePlaybackAsset(filePath: string): void {
  activePlaybackAssets.delete(path.resolve(filePath));
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
  const m3u8 = path.join(segDir, 'stream.m3u8');
  const hlsUrl = `http://127.0.0.1:${hlsPort}/${cameraId}/stream.m3u8`;
  const rtsp = buildRtspUrl(cfg, 'main');
  const stderrLines: string[] = [];
  const proc = createHlsCommand(rtsp, segDir, m3u8);

  const ready = waitForHlsReady(m3u8, STREAM_READY_TIMEOUT_MS, stderrLines);

  const streamReady = new Promise<string>((resolve, reject) => {
    let settled = false;

    attachFfmpegStderr(proc, stderrLines);

    (
      proc as ffmpeg.FfmpegCommand & {
        on(
          event: 'error',
          listener: (err: Error, stdout: string, stderr: string) => void,
        ): ffmpeg.FfmpegCommand;
      }
    ).on('error', (err: Error, _stdout: string, stderr: string) => {
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
      console.error(`[stream:${cameraId}] error:`, message);
      streams.delete(cameraId);
      if (!settled) {
        settled = true;
        reject(new Error(message));
      }
    });

    proc.on('end', () => {
      expectedStops.delete(cameraId);
      streams.delete(cameraId);
    });

    void ready
      .then(() => {
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
        }
      });
  });

  streams.set(cameraId, { proc, hlsUrl, ready: streamReady });
  return streamReady;
}

function startHttpStream(cameraId: string, cfg: CameraConfig): Promise<string> {
  const segDir = path.join(HLS_DIR, cameraId);
  fs.mkdirSync(segDir, { recursive: true });
  const m3u8 = path.join(segDir, 'stream.m3u8');
  const hlsUrl = `http://127.0.0.1:${hlsPort}/${cameraId}/stream.m3u8`;

  const streamReady = (async () => {
    // Use previously discovered hash method first, then try both
    const cachedMethod = cfg.httpHashMethod;
    const hashMethods: HashMethod[] = cachedMethod ? [cachedMethod] : ['md5', 'sha256'];
    let lastError: Error | null = null;

    for (const method of hashMethods) {
      const hashedPassword = hashMediaPassword(cfg.password, method);
      console.info(`[stream:${cameraId}] trying HTTP media session with ${method} password hash...`);

      try {
        const url = await attemptHttpStream(cameraId, cfg, hashedPassword, segDir, m3u8, hlsUrl);
        // Persist the working hash method so we skip the wrong one next time
        if (cfg.httpHashMethod !== method) {
          configStore.updateCamera(cameraId, { httpHashMethod: method });
        }
        return url;
      } catch (err) {
        lastError = err as Error;
        console.warn(`[stream:${cameraId}] HTTP stream with ${method} failed: ${(err as Error).message}`);
        // Clean up before retry
        stopStream(cameraId);
        fs.mkdirSync(segDir, { recursive: true });
      }
    }

    // If cached method failed, retry with the other one
    if (cachedMethod) {
      const fallback: HashMethod = cachedMethod === 'md5' ? 'sha256' : 'md5';
      const hashedPassword = hashMediaPassword(cfg.password, fallback);
      console.info(`[stream:${cameraId}] retrying HTTP media session with ${fallback} password hash...`);

      try {
        const url = await attemptHttpStream(cameraId, cfg, hashedPassword, segDir, m3u8, hlsUrl);
        configStore.updateCamera(cameraId, { httpHashMethod: fallback });
        return url;
      } catch (err) {
        lastError = err as Error;
        console.warn(
          `[stream:${cameraId}] HTTP stream with ${fallback} also failed: ${(err as Error).message}`,
        );
        stopStream(cameraId);
      }
    }

    throw lastError ?? new Error('HTTP media session stream failed');
  })();

  streams.set(cameraId, { proc: null, hlsUrl, ready: streamReady });
  return streamReady;
}

async function attemptHttpStream(
  cameraId: string,
  cfg: CameraConfig,
  hashedPassword: string,
  segDir: string,
  m3u8: string,
  hlsUrl: string,
): Promise<string> {
  let session: MediaSession | null = null;
  let ffmpegProc: ChildProcess | null = null;

  const cleanup = () => {
    if (ffmpegProc && !ffmpegProc.killed) {
      try {
        ffmpegProc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    if (session) {
      void session.close().catch(() => {
        /* ignore */
      });
      session = null;
    }
    streams.delete(cameraId);
  };

  try {
    session = new MediaSession(cfg.host, cfg.username || 'admin', hashedPassword, 200);
    await session.start();
    console.info(`[stream:${cameraId}] HTTP media session connected`);

    // --- Phase 1: buffer initial chunks to detect audio codec ---------------
    interface BufferedPart {
      plaintext: Buffer;
      audioPayload?: Buffer;
    }
    const buffered: BufferedPart[] = [];
    let detectedAudioCodec: 'pcma' | 'pcmu' | undefined;
    const DETECT_LIMIT = 30; // examine up to 30 chunks

    let resolveDetection: () => void;
    const detectionDone = new Promise<void>((r) => {
      resolveDetection = r;
    });

    let firstDataReceived = false;
    const noDataTimeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        if (!firstDataReceived) {
          reject(new Error('No video data received within 5s — likely wrong hash method'));
        }
      }, 5000);
    });

    // Start streaming and buffer initial chunks
    let streamingCallback:
      | ((part: {
          mimetype: string;
          plaintext: Buffer;
          audioPayload?: Buffer;
          audioPayloadType?: 'pcma' | 'pcmu';
        }) => Promise<void>)
      | null = null;

    const streamPromise = session
      .streamPreview(async (part) => {
        if (streamingCallback) {
          await streamingCallback(part);
          return;
        }

        // Detection phase
        if (!firstDataReceived) {
          firstDataReceived = true;
          console.info(`[stream:${cameraId}] first video data received (${part.plaintext.length} bytes)`);
        }

        buffered.push({ plaintext: part.plaintext, audioPayload: part.audioPayload });

        if (!detectedAudioCodec && part.audioPayloadType) {
          detectedAudioCodec = part.audioPayloadType;
          console.info(`[stream:${cameraId}] detected audio codec: ${detectedAudioCodec}`);
          resolveDetection!();
        }

        if (buffered.length >= DETECT_LIMIT && !detectedAudioCodec) {
          console.info(
            `[stream:${cameraId}] no audio detected after ${DETECT_LIMIT} chunks, proceeding video-only`,
          );
          resolveDetection!();
        }
      })
      .catch((err) => {
        if (!expectedStops.has(cameraId)) {
          console.error(`[stream:${cameraId}] http media session error:`, (err as Error).message);
          cleanup();
        }
      });

    // Wait for audio detection or timeout
    await Promise.race([detectionDone, noDataTimeout]);

    // --- Phase 2: spawn ffmpeg with correct args ----------------------------
    const audioCodec = detectedAudioCodec;
    const audioRate = audioCodec === 'pcmu' ? 16000 : 8000;

    const ffmpegArgs = [
      '-loglevel',
      'warning',
      '-fflags',
      '+genpts+discardcorrupt',
      '-err_detect',
      'ignore_err',
      '-analyzeduration',
      '2000000',
      '-probesize',
      '1000000',
      '-f',
      'mpegts',
      '-i',
      'pipe:0',
    ];

    if (audioCodec) {
      ffmpegArgs.push(
        '-analyzeduration',
        '0',
        '-probesize',
        '32',
        '-f',
        audioCodec === 'pcmu' ? 'mulaw' : 'alaw',
        '-ar',
        String(audioRate),
        '-ac',
        '1',
        '-i',
        'pipe:3',
      );
    }

    ffmpegArgs.push(
      '-map',
      '0:v:0?',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-pix_fmt',
      'yuv420p',
      '-force_key_frames',
      `expr:gte(t,n_forced*${LIVE_HLS_SEGMENT_SECONDS})`,
      '-sc_threshold',
      '0',
    );

    if (audioCodec) {
      ffmpegArgs.push(
        '-map',
        '1:a:0',
        '-af',
        LIVE_AUDIO_FILTER,
        '-c:a',
        'aac',
        '-ac',
        '1',
        '-ar',
        '44100',
        '-b:a',
        '128k',
      );
    }

    ffmpegArgs.push(
      '-max_interleave_delta',
      '0',
      '-muxpreload',
      '0',
      '-muxdelay',
      '0',
      '-f',
      'hls',
      '-hls_time',
      String(LIVE_HLS_SEGMENT_SECONDS),
      '-hls_list_size',
      String(LIVE_HLS_PLAYLIST_SIZE),
      '-hls_flags',
      'delete_segments+append_list+independent_segments',
      '-hls_segment_filename',
      path.join(segDir, 'segment-%03d.ts'),
      '-start_number',
      '0',
      m3u8,
    );

    ffmpegProc = spawn(ffmpegBinaryPath, ffmpegArgs, {
      stdio: audioCodec ? ['pipe', 'ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'],
    });

    const ffmpegStdin = ffmpegProc.stdin!;
    const audioInput = audioCodec ? (ffmpegProc.stdio[3] as Writable | undefined) : undefined;

    // Absorb EPIPE errors on both pipes
    ffmpegStdin.on('error', () => {});
    audioInput?.on('error', () => {});

    let totalChunks = buffered.length;
    let tsBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    const entry: StreamEntry = {
      proc: null,
      hlsUrl,
      ready: Promise.resolve(hlsUrl),
      httpSession: session,
      httpFfmpeg: ffmpegProc,
    };
    streams.set(cameraId, entry);

    // Flush buffered chunks to ffmpeg
    for (const buf of buffered) {
      if (ffmpegStdin.destroyed) break;
      tsBuffer = await writeAlignedTsPackets(tsBuffer, buf.plaintext, ffmpegStdin);
      if (audioInput && !audioInput.destroyed && buf.audioPayload) {
        audioInput.write(buf.audioPayload);
      }
    }
    buffered.length = 0;

    // Switch the streaming callback to feed ffmpeg directly
    streamingCallback = async (part) => {
      if (ffmpegStdin.destroyed) return;
      totalChunks++;
      tsBuffer = await writeAlignedTsPackets(tsBuffer, part.plaintext, ffmpegStdin);
      if (audioInput && !audioInput.destroyed && part.audioPayload) {
        audioInput.write(part.audioPayload);
      }
    };

    // Handle stream end
    void streamPromise.finally(() => {
      if (ffmpegStdin && !ffmpegStdin.destroyed) ffmpegStdin.end();
      if (audioInput && !audioInput.destroyed) audioInput.end();
    });

    // Wait for HLS to become ready
    const stderrLines: string[] = [];
    ffmpegProc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) {
        // console.error(`[stream:${cameraId}] ffmpeg: ${line}`);
        stderrLines.push(line);
      }
      if (stderrLines.length > STDERR_HISTORY_LIMIT) stderrLines.shift();
    });

    ffmpegProc.on('exit', (code) => {
      if (!expectedStops.has(cameraId)) {
        console.error(`[stream:${cameraId}] http ffmpeg exited with code ${code}`);
      }
    });

    await Promise.race([waitForHlsReady(m3u8, HTTP_STREAM_READY_TIMEOUT_MS, stderrLines), noDataTimeout]);
    console.info(`[stream:${cameraId}] HTTP stream ready, received ${totalChunks} chunks so far`);
    return hlsUrl;
  } catch (err) {
    cleanup();
    throw err;
  }
}

export function stopStream(cameraId: string): void {
  const entry = streams.get(cameraId);
  if (!entry) return;
  expectedStops.add(cameraId);

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

export function getPlaybackUrl(cameraId: string, filePath: string, hostDir?: string): string {
  const ext = path.extname(filePath).toLowerCase() || '.mp4';
  const baseName = path.basename(filePath, path.extname(filePath));
  const safeBase = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');

  // If file exists, copy it to playback directory for immediate availability
  if (fs.existsSync(filePath)) {
    console.info(`[getPlaybackUrl:${cameraId}] file exists, copying to playback dir: ${filePath}`);
    const destDir = path.join(PLAYBACK_DIR, cameraId);
    fs.mkdirSync(destDir, { recursive: true });
    const destFile = path.join(destDir, `${safeBase}${ext}`);
    if (!fs.existsSync(destFile)) {
      fs.copyFileSync(filePath, destFile);
    }
    const url = `http://127.0.0.1:${hlsPort}/playback/${cameraId}/${path.basename(destFile)}`;
    console.info(`[getPlaybackUrl:${cameraId}] serving from playback dir: ${url}`);
    return url;
  }

  // File doesn't exist yet (background download in progress).
  // Serve directly from recordings directory as it's being written.
  // Use hostDir in the URL path to match where the file is actually stored.
  const urlPath = hostDir ? `${hostDir}/${safeBase}${ext}` : `${cameraId}/${safeBase}${ext}`;
  const url = `http://127.0.0.1:${hlsPort}/recording/${urlPath}`;
  console.info(`[getPlaybackUrl:${cameraId}] file not yet exists, serving from recordings dir: ${url}`);
  return url;
}

export function getPlaybackAssetUrl(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return `http://127.0.0.1:${hlsPort}/playback/${normalized}`;
}

/** Restart the stream with a time offset for recording playback.  Returns the HLS URL. */
export function startPlayback(cameraId: string, cfg: CameraConfig, seekSeconds: number): Promise<string> {
  stopStream(cameraId);

  const segDir = path.join(HLS_DIR, cameraId);
  fs.mkdirSync(segDir, { recursive: true });
  const m3u8 = path.join(segDir, 'stream.m3u8');
  const hlsUrl = `http://127.0.0.1:${hlsPort}/${cameraId}/stream.m3u8`;
  const rtsp = buildRtspUrl(cfg, 'main');
  const stderrLines: string[] = [];
  const proc = createHlsCommand(rtsp, segDir, m3u8, seekSeconds);

  const ready = waitForHlsReady(m3u8, STREAM_READY_TIMEOUT_MS, stderrLines);

  const streamReady = new Promise<string>((resolve, reject) => {
    let settled = false;

    attachFfmpegStderr(proc, stderrLines);

    (
      proc as ffmpeg.FfmpegCommand & {
        on(
          event: 'error',
          listener: (err: Error, stdout: string, stderr: string) => void,
        ): ffmpeg.FfmpegCommand;
      }
    ).on('error', (err: Error, _stdout: string, stderr: string) => {
      if (isExpectedStopError(cameraId, err)) {
        expectedStops.delete(cameraId);
        streams.delete(cameraId);
        if (!settled) {
          settled = true;
          reject(new Error('Playback start cancelled'));
        }
        return;
      }

      const details = summarizeFfmpegDetails(stderr?.trim() || stderrLines.join('\n').trim());
      const message = details ? `${err.message}: ${details}` : err.message;
      console.error(`[playback:${cameraId}] error:`, message);
      streams.delete(cameraId);
      if (!settled) {
        settled = true;
        reject(new Error(message));
      }
    });

    proc.on('end', () => {
      expectedStops.delete(cameraId);
      streams.delete(cameraId);
    });

    void ready
      .then(() => {
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
        }
      });
  });

  streams.set(cameraId, { proc, hlsUrl, ready: streamReady });
  return streamReady;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export async function getSnapshot(cameraId: string, cfg: CameraConfig): Promise<string | null> {
  // Prevent concurrent snapshot requests for the same camera
  const pending = snapshotLocks.get(cameraId);
  if (pending) return pending;

  const promise = captureSnapshot(cameraId, cfg).finally(() => snapshotLocks.delete(cameraId));
  snapshotLocks.set(cameraId, promise);
  return promise;
}

/**
 * If a live HLS stream is running for the camera, grab a frame from
 * the latest segment instead of opening a new connection.
 */
async function snapshotFromHls(cameraId: string): Promise<string | null> {
  const entry = streams.get(cameraId);
  if (!entry) return null;

  const segDir = path.join(HLS_DIR, cameraId);
  const m3u8 = path.join(segDir, 'stream.m3u8');
  if (!fs.existsSync(m3u8)) return null;

  const outFile = path.join(SNAP_DIR, `${cameraId}.jpg`);
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve(null);
    }, 5000);

    const proc = spawn(
      ffmpegBinaryPath,
      ['-loglevel', 'error', '-sseof', '-1', '-i', m3u8, '-frames:v', '1', '-q:v', '5', '-y', outFile],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );

    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const buf = fs.readFileSync(outFile);
        try {
          fs.unlinkSync(outFile);
        } catch {
          /* ignore */
        }
        resolve(`data:image/jpeg;base64,${buf.toString('base64')}`);
      } catch {
        resolve(null);
      }
    });
  });
}

async function captureSnapshot(cameraId: string, cfg: CameraConfig): Promise<string | null> {
  // If a live stream is active, grab a frame from HLS — avoids opening a
  // second media session (which solar cameras may not support).
  const fromHls = await snapshotFromHls(cameraId);
  if (fromHls) return fromHls;

  if (cfg.streamProtocol === 'http') {
    return captureHttpSnapshot(cameraId, cfg);
  }

  const outFile = path.join(SNAP_DIR, `${cameraId}.jpg`);
  const rtsp = buildRtspUrl(cfg, 'sub');

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve(null);
    }, 8000);

    const proc = ffmpeg(rtsp)
      .inputOptions(['-rtsp_transport', 'tcp'])
      .frames(1)
      .outputOptions(['-q:v 5'])
      .on('error', () => {
        clearTimeout(timer);
        resolve(null);
      })
      .on('end', () => {
        clearTimeout(timer);
        try {
          const buf = fs.readFileSync(outFile);
          try {
            fs.unlinkSync(outFile);
          } catch {
            /* ignore */
          }
          resolve(`data:image/jpeg;base64,${buf.toString('base64')}`);
        } catch {
          resolve(null);
        }
      });

    proc.save(outFile);
  });
}

async function captureHttpSnapshot(cameraId: string, cfg: CameraConfig): Promise<string | null> {
  const outFile = path.join(SNAP_DIR, `${cameraId}.jpg`);
  // Use cached method first, then try both
  const cachedMethod = cfg.httpHashMethod;
  const hashMethods: HashMethod[] = cachedMethod
    ? [cachedMethod, cachedMethod === 'md5' ? 'sha256' : 'md5']
    : ['md5', 'sha256'];

  for (const method of hashMethods) {
    const hashedPassword = hashMediaPassword(cfg.password, method);
    let session: MediaSession | null = null;

    try {
      session = new MediaSession(cfg.host, cfg.username || 'admin', hashedPassword, 50);
      await session.start();

      const ffmpegProc = spawn(
        ffmpegBinaryPath,
        [
          '-loglevel',
          'warning',
          '-fflags',
          '+genpts+discardcorrupt',
          '-err_detect',
          'ignore_err',
          '-analyzeduration',
          '1000000',
          '-probesize',
          '500000',
          '-f',
          'mpegts',
          '-i',
          'pipe:0',
          '-map',
          '0:v:0?',
          '-frames:v',
          '1',
          '-q:v',
          '5',
          '-y',
          outFile,
        ],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );

      const ffmpegStdin = ffmpegProc.stdin!;
      ffmpegStdin.on('error', () => {}); // suppress EPIPE after ffmpeg exits

      const ffmpegExited = new Promise<void>((res) => {
        ffmpegProc.on('close', () => res());
      });

      const timer = setTimeout(() => {
        if (session) void session.close().catch(() => {});
        if (!ffmpegProc.killed) ffmpegProc.kill('SIGKILL');
      }, 15000);

      // Pipe data to ffmpeg; it exits after capturing 1 frame
      session
        .streamPreview(async (part) => {
          if (ffmpegStdin.destroyed) return;
          const ok = ffmpegStdin.write(part.plaintext);
          if (!ok) {
            await new Promise<void>((res) => ffmpegStdin.once('drain', res));
          }
        })
        .catch(() => {
          // Expected: session closed after ffmpeg got its frame
        });

      await ffmpegExited;
      clearTimeout(timer);

      // ffmpeg done — close the session to stop streaming
      void session.close().catch(() => {});
      session = null;

      try {
        const buf = fs.readFileSync(outFile);
        try {
          fs.unlinkSync(outFile);
        } catch {
          /* ignore */
        }
        if (cfg.httpHashMethod !== method) {
          configStore.updateCamera(cameraId, { httpHashMethod: method });
        }
        return `data:image/jpeg;base64,${buf.toString('base64')}`;
      } catch {
        return null;
      }
    } catch (err) {
      console.warn(`[snapshot:${cameraId}] http snapshot with ${method} failed:`, (err as Error).message);
    } finally {
      if (session) void session.close().catch(() => {});
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRtspUrl(cfg: CameraConfig, stream: 'main' | 'sub'): string {
  if (cfg.rtspUrl) {
    const username = cfg.rtspUsername || cfg.streamUser || cfg.username;
    const password = cfg.rtspPassword || cfg.streamPassword || cfg.password;
    return withRtspAuth(cfg.rtspUrl, username, password);
  }

  const user = encodeURIComponent(cfg.streamUser || cfg.username);
  const pass = encodeURIComponent(cfg.streamPassword || cfg.password);
  const path = stream === 'main' ? 'stream1' : 'stream2';
  return `rtsp://${user}:${pass}@${cfg.host}:554/${path}`;
}

function withRtspAuth(url: string, username?: string, password?: string): string {
  try {
    const parsed = new URL(url);
    if (username) {
      parsed.username = username;
      parsed.password = password ?? '';
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function createHlsCommand(
  rtspUrl: string,
  segDir: string,
  m3u8Path: string,
  seekSeconds?: number,
): ffmpeg.FfmpegCommand {
  const command = ffmpeg(rtspUrl).inputOptions([
    '-rtsp_transport',
    'tcp',
    '-fflags',
    'nobuffer',
    '-flags',
    'low_delay',
  ]);

  if (typeof seekSeconds === 'number' && seekSeconds > 0) {
    command.inputOptions(['-ss', String(seekSeconds)]);
  }

  return command
    .outputOptions([
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-pix_fmt',
      'yuv420p',
      '-force_key_frames',
      `expr:gte(t,n_forced*${LIVE_HLS_SEGMENT_SECONDS})`,
      '-sc_threshold',
      '0',
      '-c:a',
      'aac',
      '-af',
      LIVE_AUDIO_FILTER,
      '-ac',
      '1',
      '-ar',
      '44100',
      '-b:a',
      '128k',
      '-max_interleave_delta',
      '0',
      '-muxpreload',
      '0',
      '-muxdelay',
      '0',
      '-f',
      'hls',
      '-hls_time',
      String(LIVE_HLS_SEGMENT_SECONDS),
      '-hls_list_size',
      String(LIVE_HLS_PLAYLIST_SIZE),
      '-hls_flags',
      'delete_segments+append_list+independent_segments',
      '-hls_segment_filename',
      path.join(segDir, 'segment-%03d.ts'),
      '-start_number',
      '0',
    ])
    .save(m3u8Path);
}

function attachFfmpegStderr(proc: ffmpeg.FfmpegCommand, stderrLines: string[]): void {
  (
    proc as ffmpeg.FfmpegCommand & {
      on(event: 'stderr', listener: (line: string) => void): ffmpeg.FfmpegCommand;
    }
  ).on('stderr', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    stderrLines.push(trimmed);
    if (stderrLines.length > STDERR_HISTORY_LIMIT) {
      stderrLines.shift();
    }
  });
}

function waitForHlsReady(filePath: string, timeoutMs: number, stderrLines: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const check = () => {
      try {
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf8');
          const firstSegment = getFirstHlsSegmentPath(filePath, content);
          if (
            content.includes('#EXTM3U') &&
            firstSegment &&
            fs.existsSync(firstSegment) &&
            fs.statSync(firstSegment).size > 0
          ) {
            resolve();
            return;
          }
        }
      } catch {
        /* keep polling */
      }

      if (Date.now() - start >= timeoutMs) {
        const details = summarizeFfmpegDetails(stderrLines.join('\n').trim());
        reject(
          new Error(
            details ? `Timed out waiting for HLS playlist: ${details}` : 'Timed out waiting for HLS playlist',
          ),
        );
        return;
      }

      setTimeout(check, STREAM_READY_POLL_MS);
    };

    check();
  });
}

function getFirstHlsSegmentPath(playlistPath: string, content: string): string | null {
  const segmentLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));

  if (!segmentLine) return null;
  return path.resolve(path.dirname(playlistPath), segmentLine);
}

function summarizeFfmpegDetails(details: string): string {
  if (!details) return '';

  const relevant = details
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const lower = line.toLowerCase();
      return !(
        lower.startsWith('ffmpeg version') ||
        lower.startsWith('built with') ||
        lower.startsWith('configuration:') ||
        lower.startsWith('libav') ||
        lower.startsWith('libsw') ||
        lower.startsWith('libpostproc')
      );
    });

  return relevant.join('\n');
}

async function streamGrowingMp4(
  filePath: string,
  res: http.ServerResponse,
  completed: Promise<unknown>,
): Promise<void> {
  let position = 0;
  const waitForCompletion = completed.then(
    () => true,
    () => true,
  );

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
    'Transfer-Encoding': 'chunked',
  });

  while (!res.writableEnded) {
    let stats: fs.Stats | null = null;
    try {
      stats = fs.statSync(filePath);
    } catch {
      stats = null;
    }

    if (stats && stats.size > position) {
      const stream = fs.createReadStream(filePath, { start: position, end: stats.size - 1 });
      stream.pipe(res, { end: false });
      await once(stream, 'end');
      position = stats.size;
      continue;
    }

    const completedNow = await Promise.race([
      waitForCompletion,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150)),
    ]);

    if (completedNow) {
      try {
        const finalStats = fs.statSync(filePath);
        if (finalStats.size > position) {
          const stream = fs.createReadStream(filePath, { start: position, end: finalStats.size - 1 });
          stream.pipe(res, { end: false });
          await once(stream, 'end');
        }
      } catch {
        /* ignore */
      }
      res.end();
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// HLS HTTP server
// ---------------------------------------------------------------------------

function startServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const reqPath = decodeURIComponent((req.url ?? '/').replace(/\?.*$/, ''));
      const relativePath = reqPath.replace(/^\/+/, '');
      let baseDir: string;
      let filePath: string;

      if (relativePath.startsWith('playback/')) {
        baseDir = PLAYBACK_DIR;
        filePath = relativePath.replace(/^playback\//, '');
      } else if (relativePath.startsWith('recording/')) {
        // Serve from recordings directory (for in-progress downloads)
        // The path includes the host directory, e.g., /recording/192.168.100.141/timestamp.mp4
        baseDir = RECORDINGS_DIR;
        filePath = relativePath.replace(/^recording\//, '');
      } else {
        baseDir = HLS_DIR;
        filePath = relativePath;
      }

      const safe = path.resolve(baseDir, filePath);
      if (!safe.startsWith(baseDir)) {
        console.error(`[http:server] 403 Forbidden for ${reqPath}`);
        res.writeHead(403).end('Forbidden');
        return;
      }

      // console.info(`[http:server] serving ${reqPath} from ${safe}`);

      // Retry logic: wait for background-created playback assets and recordings to appear.
      const isRecording = reqPath.includes('/recording/');
      const isPlayback = reqPath.includes('/playback/');
      const isDeferredAsset = isRecording || isPlayback;
      const maxRetries = isDeferredAsset ? 300 : 2;
      const retryDelayMs = 200;
      let retryCount = 0;

      const tryRead = () => {
        fs.stat(safe, (statErr, stats) => {
          if (statErr) {
            if (retryCount < maxRetries && isDeferredAsset) {
              retryCount++;
              if (retryCount % 5 === 0) {
                // console.info(`[http:server] file not found, retrying (${retryCount}/${maxRetries})...`);
              }
              setTimeout(tryRead, retryDelayMs);
              return;
            }

            console.error(`[http:server] 404 Not found after ${retryCount} retries: ${safe}`);
            res.writeHead(404).end('Not found');
            return;
          }

          if (isDeferredAsset && stats.size <= 0) {
            if (retryCount < maxRetries) {
              retryCount++;
              if (retryCount % 5 === 0) {
                // console.info(`[http:server] file empty, retrying (${retryCount}/${maxRetries})...`);
              }
              setTimeout(tryRead, retryDelayMs);
              return;
            }

            console.error(`[http:server] 404 Empty file after ${retryCount} retries: ${safe}`);
            res.writeHead(404).end('Not found');
            return;
          }

          if (
            isPlayback &&
            path.extname(safe).toLowerCase() === '.mp4' &&
            stats.size < MIN_PLAYBACK_FILE_BYTES
          ) {
            if (retryCount < maxRetries) {
              retryCount++;
              if (retryCount % 5 === 0) {
                // console.info(`[http:server] playback file too small, retrying (${retryCount}/${maxRetries})...`);
              }
              setTimeout(tryRead, retryDelayMs);
              return;
            }

            console.error(`[http:server] 404 Playback file too small after ${retryCount} retries: ${safe}`);
            res.writeHead(404).end('Not found');
            return;
          }

          const ext = path.extname(safe);
          let mime = 'application/octet-stream';
          if (ext === '.m3u8') mime = 'application/vnd.apple.mpegurl';
          else if (ext === '.ts') mime = 'video/MP2T';
          else if (ext === '.mp4') mime = 'video/mp4';

          const fileSize = stats.size;
          const rangeHeader = req.headers.range;
          const activePlayback = isPlayback ? activePlaybackAssets.get(safe) : undefined;

          if (activePlayback && ext === '.mp4') {
            void streamGrowingMp4(safe, res, activePlayback).catch((error) => {
              console.error(
                `[http:server] failed growing playback stream ${safe}:`,
                (error as Error)?.message ?? error,
              );
              if (!res.headersSent) {
                res.writeHead(500).end('Streaming failed');
              } else if (!res.writableEnded) {
                res.end();
              }
            });
            return;
          }

          // Handle Range requests for streaming (206 Partial Content)
          if (rangeHeader && ext === '.mp4') {
            const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
            if (rangeMatch) {
              const start = Number(rangeMatch[1]);
              const end = rangeMatch[2] ? Number(rangeMatch[2]) : fileSize - 1;

              // For empty/growing files, allow reading 0 bytes and let player retry
              if (start >= fileSize && fileSize > 0) {
                console.error(
                  `[http:server] 416 Range Not Satisfiable: start=${start} >= fileSize=${fileSize}`,
                );
                res
                  .writeHead(416, {
                    'Content-Range': `bytes */${fileSize}`,
                  })
                  .end();
                return;
              }

              const rangeEnd = Math.min(end, Math.max(0, fileSize - 1));
              const length = Math.max(0, rangeEnd - start + 1);

              // console.info(`[http:server] 206 Partial ${safe} (bytes ${start}-${rangeEnd}/${fileSize})`);
              res.writeHead(206, {
                'Content-Type': mime,
                'Content-Length': length,
                'Content-Range': `bytes ${start}-${rangeEnd}/${fileSize}`,
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Accept-Ranges': 'bytes',
              });

              if (length > 0) {
                const stream = fs.createReadStream(safe, { start, end: rangeEnd });
                stream.pipe(res);
              } else {
                res.end();
              }
              return;
            }
          }

          // Standard full file read
          fs.readFile(safe, (readErr, data) => {
            if (readErr) {
              console.error(`[http:server] 404 Not found: ${safe} - ${readErr.message}`);
              res.writeHead(404).end('Not found');
              return;
            }
            // console.info(`[http:server] 200 OK ${safe} (${data.length} bytes)`);
            res.writeHead(200, {
              'Content-Type': mime,
              'Content-Length': data.length,
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-cache',
              'Accept-Ranges': 'bytes',
            });
            res.end(data);
          });
        });
      };

      tryRead();
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server!.unref();
      hlsPort = (server!.address() as AddressInfo).port;
      resolve(hlsPort);
    });
  });
}
