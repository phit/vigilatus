/**
 * Live streaming over the Tapo HTTP Media Session protocol (battery/solar
 * cameras that don't expose RTSP). Detects the audio codec from the first
 * chunks, then pipes the demuxed TS into ffmpeg to produce HLS.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { CameraConfig, LiveStreamOptions } from '../types';
import { ffmpegBinaryPath } from './ffmpegPath';
import { MediaSession, hashMediaPassword } from './mediaSession';
import { detectTsVideoCodec, writeAlignedTsPackets } from './tsDemux';
import * as configStore from '../config/store';
import { createLogger } from '../log';
import {
  HLS_DIR,
  HTTP_STREAM_READY_TIMEOUT_MS,
  LIVE_AUDIO_FILTER,
  STDERR_HISTORY_LIMIT,
} from './streamConstants';
import {
  hlsMuxArgs,
  liveHwDecodeInputArgs,
  liveSegmentNames,
  liveVideoArgs,
  pcmAudioInputArgs,
  type LiveVideoMode,
} from './ffmpegFragments';
import { createHlsSessionToken, waitForHlsReady } from './streamHelpers';
import { getHlsPort } from './mediaServer';
import {
  chooseLiveVideoMode,
  copyFailedCameras,
  CopyStartFailedError,
  expectedStops,
  markStreamReady,
  notifyStreamDied,
  releaseStreamEntry,
  stopStream,
  streams,
  type StreamEntry,
} from './streamRegistry';

type HashMethod = 'md5' | 'sha256';

/**
 * Build the exact ffmpeg argument vector for the live HTTP-media-session → HLS
 * pipeline. Pure so it can be snapshot-tested; `attemptHttpStream` spawns it.
 */
export function buildHttpLiveFfmpegArgs(opts: {
  audioCodec: 'pcma' | 'pcmu' | undefined;
  audioRate: number;
  segDir: string;
  sessionToken: string;
  m3u8: string;
  videoMode?: LiveVideoMode;
}): string[] {
  const { audioCodec, audioRate, segDir, sessionToken, m3u8, videoMode = 'transcode' } = opts;

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
    ...liveHwDecodeInputArgs(videoMode),
    '-f',
    'mpegts',
    '-i',
    'pipe:0',
  ];

  if (audioCodec) {
    ffmpegArgs.push(...pcmAudioInputArgs(audioCodec, audioRate));
  }

  ffmpegArgs.push('-map', '0:v:0?', ...liveVideoArgs(videoMode));

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

  const names = liveSegmentNames(videoMode, sessionToken);
  ffmpegArgs.push(...hlsMuxArgs(path.join(segDir, names.segment), names.init), m3u8);

  return ffmpegArgs;
}

export function startHttpStream(
  cameraId: string,
  cfg: CameraConfig,
  options: LiveStreamOptions = {},
): Promise<string> {
  const log = createLogger(`stream:${cameraId}`);
  const segDir = path.join(HLS_DIR, cameraId);
  fs.mkdirSync(segDir, { recursive: true });
  const sessionToken = createHlsSessionToken();
  const m3u8 = path.join(segDir, `stream-${sessionToken}.m3u8`);
  const hlsUrl = `http://127.0.0.1:${getHlsPort()}/${cameraId}/stream-${sessionToken}.m3u8`;

  // One media-session attempt; if H.264 passthrough fails to start, retry the
  // same hash method once with transcoding (the camera is then transcoded for
  // the rest of the session).
  const attempt = async (hashedPassword: string): Promise<string> => {
    try {
      return await attemptHttpStream(
        cameraId,
        cfg,
        hashedPassword,
        segDir,
        m3u8,
        hlsUrl,
        sessionToken,
        options.hevc,
      );
    } catch (err) {
      if (!(err instanceof CopyStartFailedError)) throw err;
      copyFailedCameras.add(cameraId);
      log.warn(`Passthrough failed, falling back to transcoding: ${err.message}`);
      stopStream(cameraId);
      fs.mkdirSync(segDir, { recursive: true });
      return attemptHttpStream(
        cameraId,
        cfg,
        hashedPassword,
        segDir,
        m3u8,
        hlsUrl,
        sessionToken,
        options.hevc,
      );
    }
  };

  const streamReady = (async () => {
    // Use previously discovered hash method first, then try both
    const cachedMethod = cfg.httpHashMethod;
    const hashMethods: HashMethod[] = cachedMethod ? [cachedMethod] : ['md5', 'sha256'];
    let lastError: Error | null = null;

    for (const method of hashMethods) {
      const hashedPassword = hashMediaPassword(cfg.password, method);
      log.info(`trying HTTP media session with ${method} password hash...`);

      try {
        const url = await attempt(hashedPassword);
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
        const url = await attempt(hashedPassword);
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
  hevcPlayback = false,
): Promise<string> {
  const log = createLogger(`stream:${cameraId}`);
  let diedNotified = false;

  const notifyDiedOnce = () => {
    if (diedNotified) return;
    diedNotified = true;
    notifyStreamDied(cameraId);
  };

  let session: MediaSession | null = null;
  let ffmpegProc: ChildProcess | null = null;
  let videoMode: LiveVideoMode | undefined;

  /**
   * Tear down this attempt's resources. Returns whether the registry entry
   * still belonged to this attempt's session — a stale cleanup (a newer session
   * has re-registered the camera) must leave the new entry alone and must not
   * report the camera as died.
   */
  const cleanup = (): boolean => {
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
    return releaseStreamEntry(cameraId, m3u8);
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
          if (cleanup()) {
            notifyDiedOnce();
          }
        }
      });

    // Wait for audio detection or timeout
    await Promise.race([detectionDone, noDataTimeout]);

    // --- Phase 2: spawn ffmpeg with correct args ----------------------------
    const audioCodec = detectedAudioCodec;
    const audioRate = audioCodec === 'pcmu' ? 16000 : 8000;

    const videoCodec = detectTsVideoCodec(Buffer.concat(buffered.map((b) => b.plaintext))) ?? undefined;
    videoMode = chooseLiveVideoMode(cameraId, videoCodec, hevcPlayback);
    log.info(`live video ${videoCodec ?? 'unknown'} → ${videoMode}`);

    const ffmpegArgs = buildHttpLiveFfmpegArgs({
      audioCodec,
      audioRate,
      segDir,
      sessionToken,
      m3u8,
      videoMode,
    });

    ffmpegProc = spawn(ffmpegBinaryPath, ffmpegArgs, {
      cwd: segDir, // fMP4 init file is written relative to cwd (see createHlsCommand)
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

    let exitedBeforeReady: (err: Error) => void = () => {};
    const exitBeforeReady = new Promise<never>((_, reject) => {
      exitedBeforeReady = reject;
    });
    ffmpegProc.on('exit', (code) => {
      // Copy-mode start failures are reported via the thrown error and retried
      // with transcoding, not surfaced as a died stream.
      if (videoMode !== 'transcode' && !entry.readyResolved) {
        exitedBeforeReady(new Error(`ffmpeg exited with code ${code}`));
        return;
      }
      if (!expectedStops.has(cameraId) && releaseStreamEntry(cameraId, m3u8)) {
        log.error(`http ffmpeg exited with code ${code}`);
        notifyDiedOnce();
      }
    });

    await Promise.race([
      waitForHlsReady(m3u8, HTTP_STREAM_READY_TIMEOUT_MS, stderrLines),
      noDataTimeout,
      exitBeforeReady,
    ]);
    markStreamReady(cameraId, m3u8);
    log.info(`HTTP stream ready, received ${totalChunks} chunks so far`);
    return hlsUrl;
  } catch (err) {
    // stopStream() (or a newer session) has replaced our registry entry.
    const cancelled = streams.get(cameraId)?.playlistPath !== m3u8;
    cleanup();
    if (videoMode !== undefined && videoMode !== 'transcode' && !cancelled) {
      throw new CopyStartFailedError((err as Error).message);
    }
    throw err;
  }
}
