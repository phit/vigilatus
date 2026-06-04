/**
 * StreamManager — manages ffmpeg RTSP→HLS transcoding and snapshot capture.
 *
 * One ffmpeg process per camera. Stateless helpers live in ./streamHelpers,
 * shared constants in ./streamConstants, and the loopback HTTP server that
 * serves HLS/playback assets to the renderer in ./mediaServer.
 */

import ffmpeg from 'fluent-ffmpeg';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { CameraConfig } from '../types';
import { ffmpegBinaryPath } from './ffmpegPath';
import { MediaSession, hashMediaPassword, writeAlignedTsPackets } from './recordingDownloader';
import * as configStore from '../config/store';
import { createLogger } from '../log';
import {
  HLS_DIR,
  HTTP_STREAM_READY_TIMEOUT_MS,
  LIVE_AUDIO_FILTER,
  LIVE_HLS_PLAYLIST_SIZE,
  LIVE_HLS_SEGMENT_SECONDS,
  PLAYBACK_DIR,
  RECORDING_MAX_AGE_MS,
  RECORDINGS_DIR,
  SNAP_DIR,
  STDERR_HISTORY_LIMIT,
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

export {
  getPlaybackAssetUrl,
  registerActivePlaybackAsset,
  unregisterActivePlaybackAsset,
} from './mediaServer';
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
  type StreamEntry,
} from './streamRegistry';

export { setOnStreamDied, stopAllStreams, stopStream };

type HashMethod = 'md5' | 'sha256';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Per-camera in-progress snapshot promise (prevents parallel captures) */
const snapshotLocks = new Map<string, Promise<string | null>>();

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
      notifyStreamDied(cameraId);
    });

    proc.on('end', () => {
      const wasExpected = expectedStops.has(cameraId);
      expectedStops.delete(cameraId);
      streams.delete(cameraId);
      if (!wasExpected && settled) {
        notifyStreamDied(cameraId);
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
          notifyStreamDied(cameraId);
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

function startHttpStream(cameraId: string, cfg: CameraConfig): Promise<string> {
  const log = createLogger(`stream:${cameraId}`);
  const segDir = path.join(HLS_DIR, cameraId);
  fs.mkdirSync(segDir, { recursive: true });
  const sessionToken = createHlsSessionToken();
  const m3u8 = path.join(segDir, `stream-${sessionToken}.m3u8`);
  const hlsUrl = `http://127.0.0.1:${getHlsPort()}/${cameraId}/stream-${sessionToken}.m3u8`;

  const streamReady = (async () => {
    // Use previously discovered hash method first, then try both
    const cachedMethod = cfg.httpHashMethod;
    const hashMethods: HashMethod[] = cachedMethod ? [cachedMethod] : ['md5', 'sha256'];
    let lastError: Error | null = null;

    for (const method of hashMethods) {
      const hashedPassword = hashMediaPassword(cfg.password, method);
      log.info(`trying HTTP media session with ${method} password hash...`);

      try {
        const url = await attemptHttpStream(
          cameraId,
          cfg,
          hashedPassword,
          segDir,
          m3u8,
          hlsUrl,
          sessionToken,
        );
        // Persist the working hash method so we skip the wrong one next time
        if (cfg.httpHashMethod !== method) {
          configStore.updateCamera(cameraId, { httpHashMethod: method });
        }
        return url;
      } catch (err) {
        lastError = err as Error;
        log.warn(`HTTP stream with ${method} failed: ${(err as Error).message}`);
        // Clean up before retry
        stopStream(cameraId);
        fs.mkdirSync(segDir, { recursive: true });
      }
    }

    // If cached method failed, retry with the other one
    if (cachedMethod) {
      const fallback: HashMethod = cachedMethod === 'md5' ? 'sha256' : 'md5';
      const hashedPassword = hashMediaPassword(cfg.password, fallback);
      log.info(`retrying HTTP media session with ${fallback} password hash...`);

      try {
        const url = await attemptHttpStream(
          cameraId,
          cfg,
          hashedPassword,
          segDir,
          m3u8,
          hlsUrl,
          sessionToken,
        );
        configStore.updateCamera(cameraId, { httpHashMethod: fallback });
        return url;
      } catch (err) {
        lastError = err as Error;
        log.warn(`HTTP stream with ${fallback} also failed: ${(err as Error).message}`);
        stopStream(cameraId);
      }
    }

    throw lastError ?? new Error('HTTP media session stream failed');
  })();

  streams.set(cameraId, {
    proc: null,
    hlsUrl,
    playlistPath: m3u8,
    kind: 'live',
    readyResolved: false,
    lastHlsActivityAt: Date.now(),
    ready: streamReady,
  });
  return streamReady;
}

async function attemptHttpStream(
  cameraId: string,
  cfg: CameraConfig,
  hashedPassword: string,
  segDir: string,
  m3u8: string,
  hlsUrl: string,
  sessionToken: string,
): Promise<string> {
  const log = createLogger(`stream:${cameraId}`);
  let session: MediaSession | null = null;
  let ffmpegProc: ChildProcess | null = null;

  const cleanup = () => {
    expectedStops.add(cameraId);
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
    log.info(`HTTP media session connected`);

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
          log.info(`first video data received (${part.plaintext.length} bytes)`);
        }

        buffered.push({ plaintext: part.plaintext, audioPayload: part.audioPayload });

        if (!detectedAudioCodec && part.audioPayloadType) {
          detectedAudioCodec = part.audioPayloadType;
          log.info(`detected audio codec: ${detectedAudioCodec}`);
          resolveDetection!();
        }

        if (buffered.length >= DETECT_LIMIT && !detectedAudioCodec) {
          log.info(`no audio detected after ${DETECT_LIMIT} chunks, proceeding video-only`);
          resolveDetection!();
        }
      })
      .catch((err) => {
        if (!expectedStops.has(cameraId)) {
          log.error(`http media session error:`, (err as Error).message);
          cleanup();
          notifyStreamDied(cameraId);
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
      'delete_segments+independent_segments',
      '-hls_segment_filename',
      path.join(segDir, `segment-${sessionToken}-%03d.ts`),
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
      playlistPath: m3u8,
      kind: 'live',
      readyResolved: false,
      lastHlsActivityAt: Date.now(),
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
        stderrLines.push(line);
      }
      if (stderrLines.length > STDERR_HISTORY_LIMIT) stderrLines.shift();
    });

    ffmpegProc.on('exit', (code) => {
      if (!expectedStops.has(cameraId)) {
        log.error(`http ffmpeg exited with code ${code}`);
        streams.delete(cameraId);
        notifyStreamDied(cameraId);
      }
    });

    await Promise.race([waitForHlsReady(m3u8, HTTP_STREAM_READY_TIMEOUT_MS, stderrLines), noDataTimeout]);
    markStreamReady(cameraId, m3u8);
    log.info(`HTTP stream ready, received ${totalChunks} chunks so far`);
    return hlsUrl;
  } catch (err) {
    cleanup();
    throw err;
  }
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

  const m3u8 = entry.playlistPath;
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
      createLogger(`snapshot:${cameraId}`).warn(
        `http snapshot with ${method} failed:`,
        (err as Error).message,
      );
    } finally {
      if (session) void session.close().catch(() => {});
    }
  }

  return null;
}
