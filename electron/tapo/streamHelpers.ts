/**
 * Stateless helpers for the stream manager: RTSP URL building, ffmpeg command
 * construction, HLS readiness polling, and ffmpeg output parsing. None of these
 * touch the stream registry — they operate purely on their arguments.
 */

import ffmpeg from 'fluent-ffmpeg';
import fs from 'node:fs';
import path from 'node:path';
import type { CameraConfig } from '../types';
import {
  LIVE_AUDIO_FILTER,
  LIVE_HLS_PLAYLIST_SIZE,
  LIVE_HLS_SEGMENT_SECONDS,
  STDERR_HISTORY_LIMIT,
  STREAM_READY_POLL_MS,
} from './streamConstants';

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

export function createHlsCommand(
  rtspUrl: string,
  segDir: string,
  m3u8Path: string,
  sessionToken?: string,
): ffmpeg.FfmpegCommand {
  const command = ffmpeg(rtspUrl).inputOptions([
    '-rtsp_transport',
    'tcp',
    '-fflags',
    'nobuffer',
    '-flags',
    'low_delay',
  ]);

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
      'delete_segments+independent_segments',
      '-hls_segment_filename',
      path.join(segDir, `segment-${sessionToken ?? 'live'}-%03d.ts`),
    ])
    .save(m3u8Path);
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
