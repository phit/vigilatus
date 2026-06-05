import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { ffmpegBinaryPath } from './ffmpegPath';
import { createLogger } from '../log';
import type { RecordingAudioOptions } from './recordingAudio';
import { writeAlignedTsPackets } from './tsDemux';
import { buildDownloadFfmpegArgs, buildPlaybackFfmpegArgs } from './ffmpegRecordingArgs';
import { MediaSession, type EncryptionMethod } from './mediaSession';

interface DownloadRecordingOptions {
  host: string;
  username: string;
  hashedPassword: string;
  encryptionMethod: EncryptionMethod;
  userId: number;
  startTime: number;
  endTime: number;
  outputPath: string;
  audio?: RecordingAudioOptions;
  windowSize?: number;
}

interface RecordingPlaybackStreamOptions extends Omit<DownloadRecordingOptions, 'outputPath'> {
  outputDir: string;
  /** Seconds to skip at the start of the TS stream (workaround for cameras that ignore start_time on current-day recordings). */
  seekOffsetSec?: number;
}

export interface RecordingPlaybackJob {
  assetPath: string;
  ready: Promise<string>;
  completed: Promise<string>;
  cancel(): void;
}

const PLAYBACK_READY_TIMEOUT_MS = 60_000;
const MIN_PLAYBACK_READY_BYTES = 256_000;
const MIN_PLAYBACK_GROWTH_BYTES = 50_000;
const FALLBACK_WINDOW_SIZE = 50;

export async function downloadRecordingToMp4(options: DownloadRecordingOptions): Promise<string> {
  const log = createLogger(`recording:dl:${options.host}:${options.startTime}-${options.endTime}`);
  const retryWindowSizes = buildRetryWindowSizes(options.windowSize);
  log.info(`starting download, windowSizes=${retryWindowSizes.join(',')}`);

  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  const partialOutputPath = `${options.outputPath}.part`;
  if (fs.existsSync(options.outputPath)) {
    const existingSize = fs.statSync(options.outputPath).size;
    if (existingSize > 0) {
      log.info(`file already exists, returning cached`);
      return options.outputPath;
    }

    fs.rmSync(options.outputPath, { force: true });
    log.warn(`removed zero-byte cached file before retrying download`);
  }

  if (fs.existsSync(partialOutputPath)) {
    fs.rmSync(partialOutputPath, { force: true });
    log.warn(`removed stale partial download before retrying`);
  }

  let lastError: unknown = null;

  for (let attemptIndex = 0; attemptIndex < retryWindowSizes.length; attemptIndex += 1) {
    const windowSize = retryWindowSizes[attemptIndex];
    const session = new MediaSession(
      options.host,
      options.username || 'admin',
      options.hashedPassword,
      windowSize,
    );
    log.info(
      `connecting to media session (attempt ${attemptIndex + 1}/${retryWindowSizes.length}, windowSize=${windowSize})...`,
    );
    await session.start();
    log.info(`media session connected, starting stream...`);

    const ffmpegProc = spawn(ffmpegBinaryPath, buildDownloadFfmpegArgs(partialOutputPath, options.audio), {
      stdio: options.audio ? ['pipe', 'ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'],
    });
    const ffmpegStdin = ffmpegProc.stdin!;
    const audioInput = options.audio ? (ffmpegProc.stdio[3] as Writable | undefined) : undefined;
    const ffmpegStderr = ffmpegProc.stderr!;
    if (!ffmpegStdin) {
      throw new Error('ffmpeg stdin is not available for recording download');
    }

    // Absorb EPIPE errors (ffmpeg may exit while we still write)
    ffmpegStdin.on('error', () => {});
    audioInput?.on('error', () => {});

    const stderrChunks: Buffer[] = [];
    ffmpegStderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    let tsBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let totalDataChunks = 0;
    let totalBytes = 0;

    try {
      log.info(`starting media stream for userId=${options.userId}`);
      await session.streamRecording(options.userId, options.startTime, options.endTime, async (part) => {
        totalDataChunks++;
        totalBytes += part.plaintext.length;
        if (totalDataChunks % 50 === 0) {
          log.info(`received ${totalDataChunks} chunks, ${totalBytes} bytes`);
        }
        tsBuffer = await writeAlignedTsPackets(tsBuffer, part.plaintext, ffmpegStdin);
        if (audioInput && !audioInput.destroyed && part.audioPayload) {
          audioInput.write(part.audioPayload);
        }
      });

      log.info(`media stream ended, received ${totalDataChunks} chunks (${totalBytes} bytes)`);
      if (audioInput && !audioInput.destroyed) {
        audioInput.end();
      }
      ffmpegStdin.end();
      log.info(`waiting for ffmpeg to finish...`);
      const [exitCode] = (await once(ffmpegProc, 'close')) as [number | null];
      if (exitCode !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        throw new Error(stderr || `ffmpeg exited with code ${exitCode}`);
      }

      const partialStats = fs.statSync(partialOutputPath);
      if (partialStats.size <= 0) {
        throw new Error('ffmpeg created an empty recording file');
      }

      fs.renameSync(partialOutputPath, options.outputPath);

      log.info(`successfully saved to ${options.outputPath}`);
      return options.outputPath;
    } catch (error) {
      lastError = error;
      const msg = (error as Error)?.message ?? String(error);
      log.error(`failed: ${msg}, received ${totalDataChunks} chunks before error`);
      try {
        ffmpegProc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(options.outputPath, { force: true });
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(partialOutputPath, { force: true });
      } catch {
        /* ignore */
      }
      if (!isRetryableRecordingStreamError(msg) || attemptIndex >= retryWindowSizes.length - 1) {
        throw error;
      }
      log.warn(`retrying download with smaller window after retryable stream failure`);
    } finally {
      await session.close();
      log.info(`media session closed`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Unable to download recording stream');
}

export async function startRecordingDownloadToHls(
  options: RecordingPlaybackStreamOptions,
): Promise<RecordingPlaybackJob> {
  const log = createLogger(`recording:hls:${options.host}:${options.startTime}-${options.endTime}`);
  const assetPath = path.join(options.outputDir, 'stream.mp4');

  fs.rmSync(options.outputDir, { recursive: true, force: true });
  fs.mkdirSync(options.outputDir, { recursive: true });

  let cancelled = false;
  let activeFfmpegProc: ReturnType<typeof spawn> | null = null;
  let activeSession: MediaSession | null = null;

  const closeActiveSession = async () => {
    const sessionToClose = activeSession;
    activeSession = null;
    if (!sessionToClose) {
      return;
    }
    try {
      await sessionToClose.close();
    } catch {
      /* ignore */
    }
  };

  const stopActiveFfmpeg = () => {
    const ffmpegToKill = activeFfmpegProc;
    activeFfmpegProc = null;
    if (!ffmpegToKill) {
      return;
    }
    try {
      if (!ffmpegToKill.killed) {
        ffmpegToKill.kill('SIGKILL');
      }
    } catch {
      /* ignore */
    }
  };

  const retryWindowSizes = buildRetryWindowSizes(options.windowSize);

  const runAttempt = async (withAudio: boolean, windowSize: number): Promise<void> => {
    const session = new MediaSession(
      options.host,
      options.username || 'admin',
      options.hashedPassword,
      windowSize,
    );
    activeSession = session;
    await session.start();

    const ffmpegArgs = buildPlaybackFfmpegArgs(
      assetPath,
      withAudio ? options.audio : undefined,
      options.seekOffsetSec,
    );

    const ffmpegProc = spawn(ffmpegBinaryPath, ffmpegArgs, {
      stdio: withAudio && options.audio ? ['pipe', 'ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'],
    });

    activeFfmpegProc = ffmpegProc;
    const ffmpegStdin = ffmpegProc.stdin!;
    const audioInput = withAudio && options.audio ? (ffmpegProc.stdio[3] as Writable | undefined) : undefined;
    const ffmpegStderr = ffmpegProc.stderr!;
    if (!ffmpegStdin) {
      throw new Error('ffmpeg stdin is not available for recording playback');
    }

    // Absorb EPIPE errors (ffmpeg may exit while we still write)
    ffmpegStdin.on('error', () => {});
    audioInput?.on('error', () => {});

    const stderrChunks: Buffer[] = [];
    ffmpegStderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    let tsBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let receivedAudioData = false;

    try {
      await session.streamRecording(options.userId, options.startTime, options.endTime, async (part) => {
        if (ffmpegProc.exitCode !== null || ffmpegStdin.destroyed) {
          throw new Error('ffmpeg exited early during progressive playback');
        }

        tsBuffer = await writeAlignedTsPackets(tsBuffer, part.plaintext, ffmpegStdin);
        if (audioInput && !audioInput.destroyed && part.audioPayload) {
          receivedAudioData = true;
          audioInput.write(part.audioPayload);
        }
      });

      if (tsBuffer.length >= 188 && !ffmpegStdin.destroyed) {
        tsBuffer = await writeAlignedTsPackets(tsBuffer, Buffer.alloc(0), ffmpegStdin);
      }

      if (audioInput && !audioInput.destroyed) {
        if (!receivedAudioData && withAudio) {
          log.warn(`no audio data received, closing audio pipe`);
        }
        audioInput.end();
      }
      if (!ffmpegStdin.destroyed) {
        ffmpegStdin.end();
      }

      const [exitCode] = (await once(ffmpegProc, 'close')) as [number | null];
      if (cancelled) {
        throw new Error('Recording playback cancelled');
      }
      if (exitCode !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        throw new Error(stderr || `ffmpeg exited with code ${exitCode}`);
      }

      if (!fs.existsSync(assetPath)) {
        log.error(`output file NOT created: ${assetPath}`);
      }
    } finally {
      stopActiveFfmpeg();
      await closeActiveSession();
    }
  };

  const runAttemptWithRetry = async (withAudio: boolean): Promise<void> => {
    let lastError: unknown = null;

    for (let attemptIndex = 0; attemptIndex < retryWindowSizes.length; attemptIndex += 1) {
      const windowSize = retryWindowSizes[attemptIndex];
      try {
        await runAttempt(withAudio, windowSize);
        return;
      } catch (error) {
        lastError = error;
        const message = (error as Error)?.message ?? String(error);
        try {
          fs.rmSync(assetPath, { force: true });
        } catch {
          /* ignore */
        }
        if (!isRetryableRecordingStreamError(message) || attemptIndex >= retryWindowSizes.length - 1) {
          throw error;
        }
        log.warn(`retrying progressive playback with smaller window after retryable stream failure`);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Unable to start recording playback stream');
  };

  const ready = waitForPlaybackFileReady(assetPath, PLAYBACK_READY_TIMEOUT_MS, log);

  const completed = (async () => {
    try {
      try {
        await runAttemptWithRetry(true);
      } catch (error) {
        if (cancelled) {
          throw error;
        }

        const message = (error as Error)?.message ?? String(error);
        log.warn(`audio+video playback failed: ${message}, falling back to video-only`);
        try {
          fs.rmSync(assetPath, { force: true });
        } catch {
          /* ignore */
        }

        try {
          await runAttemptWithRetry(false);
        } catch {
          log.warn(`video-only playback also failed, using audio+video error`);
          throw error;
        }
      }

      return assetPath;
    } catch (error) {
      const msg = (error as Error)?.message ?? String(error);
      log.error(`failed: ${msg}`);
      throw error;
    } finally {
      stopActiveFfmpeg();
      await closeActiveSession();
    }
  })();

  completed.catch(() => {
    if (!cancelled) {
      try {
        fs.rmSync(options.outputDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  return {
    assetPath,
    ready,
    completed,
    cancel() {
      cancelled = true;
      try {
        const stdin = activeFfmpegProc?.stdin;
        if (stdin && !stdin.destroyed) {
          stdin.destroy();
        }
      } catch {
        /* ignore */
      }
      stopActiveFfmpeg();
      void closeActiveSession();
    },
  };
}

function waitForPlaybackFileReady(
  filePath: string,
  timeoutMs: number,
  log: ReturnType<typeof createLogger>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let lastSize = 0;
    let lastCheckTime = start;
    let checkCount = 0;

    const check = () => {
      checkCount++;
      try {
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          const currentSize = stats.size;
          const currentTime = Date.now();
          const isGrowing = currentSize > lastSize;

          // Resolve if we hit the main threshold
          if (currentSize >= MIN_PLAYBACK_READY_BYTES) {
            log.info(`playback file is ready (${currentSize} bytes)`);
            resolve(filePath);
            return;
          }

          // Or if file exists, has some data, and is actively growing
          if (currentSize >= MIN_PLAYBACK_GROWTH_BYTES && isGrowing && currentTime - lastCheckTime >= 400) {
            log.info(`playback file is growing (${currentSize} bytes), starting playback`);
            resolve(filePath);
            return;
          }

          lastSize = currentSize;
          if (isGrowing) {
            lastCheckTime = currentTime;
          }
        }
      } catch (e) {
        log.error(`file check error: ${(e as Error)?.message}`);
      }

      if (Date.now() - start >= timeoutMs) {
        log.error(`file check timed out after ${checkCount} checks, ${Date.now() - start}ms`);
        reject(new Error('Timed out waiting for recording playback to become ready'));
        return;
      }

      setTimeout(check, 200);
    };

    check();
  });
}

export function buildRetryWindowSizes(windowSize?: number): number[] {
  const values = new Set<number>();
  values.add(
    typeof windowSize === 'number' && Number.isFinite(windowSize) && windowSize > 0 ? windowSize : 200,
  );
  values.add(FALLBACK_WINDOW_SIZE);
  return Array.from(values);
}

function isRetryableRecordingStreamError(message: string): boolean {
  return (
    message.includes('Camera closed the recording stream unexpectedly') ||
    message.includes('Timed out waiting for recording data from camera') ||
    message.includes('ffmpeg created an empty recording file')
  );
}
