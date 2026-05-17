/**
 * StreamManager — manages ffmpeg RTSP→HLS transcoding and snapshot capture.
 *
 * One ffmpeg process per camera.  An embedded HTTP server on a random
 * loopback port serves the HLS segments to the renderer.
 */

import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { CameraConfig } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HLS_DIR = path.join(os.tmpdir(), 'tapostudio-hls');
const SNAP_DIR = path.join(os.tmpdir(), 'tapostudio-snaps');
const PLAYBACK_DIR = path.join(os.tmpdir(), 'tapostudio-playback');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface StreamEntry {
  proc: ffmpeg.FfmpegCommand;
  hlsUrl: string;
}

const streams = new Map<string, StreamEntry>();
/** Per-camera in-progress snapshot promise (prevents parallel captures) */
const snapshotLocks = new Map<string, Promise<string | null>>();
let server: http.Server | null = null;
let hlsPort = 0;

const STREAM_READY_TIMEOUT_MS = 15_000;
const STREAM_READY_POLL_MS = 250;
const STDERR_HISTORY_LIMIT = 24;

// ---------------------------------------------------------------------------
// Init / teardown
// ---------------------------------------------------------------------------

export async function init(): Promise<void> {
  if (!ffmpegStatic) throw new Error('ffmpeg-static not available on this platform');
  ffmpeg.setFfmpegPath(ffmpegStatic);

  fs.mkdirSync(HLS_DIR, { recursive: true });
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.mkdirSync(PLAYBACK_DIR, { recursive: true });

  hlsPort = await startServer();
}

export function cleanup(): void {
  for (const id of streams.keys()) stopStream(id);
  server?.close();
}

// ---------------------------------------------------------------------------
// Live stream
// ---------------------------------------------------------------------------

export function startStream(cameraId: string, cfg: CameraConfig): Promise<string> {
  const existing = streams.get(cameraId);
  if (existing) return Promise.resolve(existing.hlsUrl);

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

    (proc as ffmpeg.FfmpegCommand & {
      on(event: 'error', listener: (err: Error, stdout: string, stderr: string) => void): ffmpeg.FfmpegCommand;
    }).on('error', (err: Error, _stdout: string, stderr: string) => {
      const details = summarizeFfmpegDetails(stderr?.trim() || stderrLines.join('\n').trim());
      const message = details ? `${err.message}: ${details}` : err.message;
      console.error(`[stream:${cameraId}] error:`, message);
      streams.delete(cameraId);
      if (!settled) {
        settled = true;
        reject(new Error(message));
      }
    });

    proc.on('end', () => streams.delete(cameraId));

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

  streams.set(cameraId, { proc, hlsUrl });
  return streamReady;
}

export function stopStream(cameraId: string): void {
  const entry = streams.get(cameraId);
  if (!entry) return;
  try {
    entry.proc.kill('SIGKILL');
  } catch {
    /* ignore */
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

export function getPlaybackUrl(cameraId: string, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase() || '.mp4';
  const destDir = path.join(PLAYBACK_DIR, cameraId);
  fs.mkdirSync(destDir, { recursive: true });

  const baseName = path.basename(filePath, path.extname(filePath));
  const safeBase = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const destFile = path.join(destDir, `${safeBase}${ext}`);

  if (!fs.existsSync(destFile)) {
    fs.copyFileSync(filePath, destFile);
  }

  return `http://127.0.0.1:${hlsPort}/playback/${cameraId}/${path.basename(destFile)}`;
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

    (proc as ffmpeg.FfmpegCommand & {
      on(event: 'error', listener: (err: Error, stdout: string, stderr: string) => void): ffmpeg.FfmpegCommand;
    }).on('error', (err: Error, _stdout: string, stderr: string) => {
      const details = summarizeFfmpegDetails(stderr?.trim() || stderrLines.join('\n').trim());
      const message = details ? `${err.message}: ${details}` : err.message;
      console.error(`[playback:${cameraId}] error:`, message);
      streams.delete(cameraId);
      if (!settled) {
        settled = true;
        reject(new Error(message));
      }
    });

    proc.on('end', () => streams.delete(cameraId));

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

  streams.set(cameraId, { proc, hlsUrl });
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

async function captureSnapshot(cameraId: string, cfg: CameraConfig): Promise<string | null> {
  const outFile = path.join(SNAP_DIR, `${cameraId}.jpg`);
  const rtsp = buildRtspUrl(cfg, 'sub');

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
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
          try { fs.unlinkSync(outFile); } catch { /* ignore */ }
          resolve(`data:image/jpeg;base64,${buf.toString('base64')}`);
        } catch {
          resolve(null);
        }
      });

    proc.save(outFile);
  });
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

  return command.outputOptions([
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '50',
    '-sc_threshold',
    '0',
    '-c:a',
    'aac',
    '-ac',
    '1',
    '-ar',
    '44100',
    '-b:a',
    '128k',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_list_size',
    '5',
    '-hls_flags',
    'delete_segments+append_list+independent_segments',
    '-hls_segment_filename',
    path.join(segDir, 'segment-%03d.ts'),
    '-start_number',
    '0',
  ]).save(m3u8Path);
}

function attachFfmpegStderr(proc: ffmpeg.FfmpegCommand, stderrLines: string[]): void {
  (proc as ffmpeg.FfmpegCommand & {
    on(event: 'stderr', listener: (line: string) => void): ffmpeg.FfmpegCommand;
  }).on('stderr', (line: string) => {
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
        reject(new Error(details ? `Timed out waiting for HLS playlist: ${details}` : 'Timed out waiting for HLS playlist'));
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

// ---------------------------------------------------------------------------
// HLS HTTP server
// ---------------------------------------------------------------------------

function startServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const reqPath = decodeURIComponent((req.url ?? '/').replace(/\?.*$/, ''));
      const relativePath = reqPath.replace(/^\/+/, '');
      const baseDir = relativePath.startsWith('playback/') ? PLAYBACK_DIR : HLS_DIR;
      const safe = path.resolve(baseDir, relativePath);
      if (!safe.startsWith(baseDir)) {
        res.writeHead(403).end('Forbidden');
        return;
      }

      fs.readFile(safe, (err, data) => {
        if (err) {
          res.writeHead(404).end('Not found');
          return;
        }
        const ext = path.extname(safe);
        let mime = 'application/octet-stream';
        if (ext === '.m3u8') mime = 'application/vnd.apple.mpegurl';
        else if (ext === '.ts') mime = 'video/MP2T';
        else if (ext === '.mp4') mime = 'video/mp4';
        res.writeHead(200, {
          'Content-Type': mime,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        });
        res.end(data);
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      hlsPort = (server!.address() as AddressInfo).port;
      resolve(hlsPort);
    });
  });
}
