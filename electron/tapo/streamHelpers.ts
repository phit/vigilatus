/**
 * Stateless helpers for the stream manager: RTSP URL building, ffmpeg command
 * construction, HLS readiness polling, and ffmpeg output parsing. None of these
 * touch the stream registry — they operate purely on their arguments.
 */

import ffmpeg from 'fluent-ffmpeg';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CameraConfig } from '../types';
import {
  LIVE_AUDIO_FILTER,
  RTSP_PROBE_TIMEOUT_MS,
  STDERR_HISTORY_LIMIT,
  STREAM_READY_POLL_MS,
} from './streamConstants';
import {
  hlsMuxArgs,
  liveHwDecodeInputArgs,
  liveSegmentNames,
  liveVideoArgs,
  type LiveVideoMode,
} from './ffmpegFragments';

export function buildRtspUrl(cfg: CameraConfig, stream: 'main' | 'sub'): string {
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

export function withRtspAuth(url: string, username?: string, password?: string): string {
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

/**
 * The exact `.outputOptions([...])` vector for the live RTSP → HLS pipeline.
 * Pure so it can be snapshot-tested; `createHlsCommand` spreads it.
 */
export function buildRtspHlsOutputOptions(
  segDir: string,
  sessionToken?: string,
  mode: LiveVideoMode = 'transcode',
): string[] {
  const segmentNames = liveSegmentNames(mode, sessionToken ?? 'live');
  return [
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    ...liveVideoArgs(mode),
    // NOTE: this AAC block lists `-c:a` before `-af`, the reverse of the HTTP
    // pipeline's order, so it is intentionally NOT shared via a fragment.
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
    ...hlsMuxArgs(path.join(segDir, segmentNames.segment), segmentNames.init),
  ];
}

export function createHlsCommand(
  rtspUrl: string,
  segDir: string,
  m3u8Path: string,
  sessionToken?: string,
  mode: LiveVideoMode = 'transcode',
): ffmpeg.FfmpegCommand {
  // cwd = segDir: ffmpeg writes the fMP4 init file relative to its working
  // directory, and it must sit next to the playlist for the relative EXT-X-MAP.
  const command = ffmpeg(rtspUrl, { cwd: segDir }).inputOptions([
    ...liveHwDecodeInputArgs(mode),
    '-rtsp_transport',
    'tcp',
    '-fflags',
    'nobuffer',
    '-flags',
    'low_delay',
  ]);

  return command.outputOptions(buildRtspHlsOutputOptions(segDir, sessionToken, mode)).save(m3u8Path);
}

export interface ProbedVideoStream {
  codec: string;
  width?: number;
  height?: number;
}

/**
 * Extract the first video stream's codec (and resolution, when printed) from
 * ffmpeg's input banner, e.g.
 * `Stream #0:0: Video: h264 (Main), yuvj420p(pc, bt709, progressive), 2560x1440, 15 fps`.
 */
export function parseFfmpegVideoStream(stderr: string): ProbedVideoStream | null {
  for (const line of stderr.split(/\r?\n/)) {
    const match = /Stream #\d+:\d+.*?: Video: (\w+)/.exec(line);
    if (!match) continue;
    const size = /, (\d{2,5})x(\d{2,5})\b/.exec(line);
    return size ? { codec: match[1], width: Number(size[1]), height: Number(size[2]) } : { codec: match[1] };
  }
  return null;
}

/**
 * Open the RTSP feed just long enough for ffmpeg to print its stream info,
 * then report the video codec. Resolves `null` on timeout or if no video
 * stream is found; never rejects.
 */
export function probeRtspVideoStream(ffmpegPath: string, rtspUrl: string): Promise<ProbedVideoStream | null> {
  return new Promise((resolve) => {
    let stderr = '';
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(ffmpegPath, ['-hide_banner', '-rtsp_transport', 'tcp', '-i', rtspUrl], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, RTSP_PROBE_TIMEOUT_MS);
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on('close', () => {
      clearTimeout(timer);
      resolve(parseFfmpegVideoStream(stderr));
    });
  });
}

export function createHlsSessionToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Attach an 'error' listener to an ffmpeg command (typed; fluent-ffmpeg's types omit it). */
export function onFfmpegError(
  proc: ffmpeg.FfmpegCommand,
  listener: (err: Error, stdout: string, stderr: string) => void,
): void {
  (
    proc as ffmpeg.FfmpegCommand & {
      on(
        event: 'error',
        listener: (err: Error, stdout: string, stderr: string) => void,
      ): ffmpeg.FfmpegCommand;
    }
  ).on('error', listener);
}

export function attachFfmpegStderr(proc: ffmpeg.FfmpegCommand, stderrLines: string[]): void {
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

export function waitForHlsReady(filePath: string, timeoutMs: number, stderrLines: string[]): Promise<void> {
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

export function getFirstHlsSegmentPath(playlistPath: string, content: string): string | null {
  const segmentLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));

  if (!segmentLine) return null;
  return path.resolve(path.dirname(playlistPath), segmentLine);
}

export function summarizeFfmpegDetails(details: string): string {
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
