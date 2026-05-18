/**
 * StreamManager — manages ffmpeg RTSP→HLS transcoding and snapshot capture.
 *
 * One ffmpeg process per camera.  An embedded HTTP server on a random
 * loopback port serves the HLS segments to the renderer.
 */

import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { CameraConfig } from '../types';
import { resolveFfmpegBinaryPath } from './ffmpegPath';

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
  ready: Promise<string>;
}

const streams = new Map<string, StreamEntry>();
const expectedStops = new Set<string>();
/** Per-camera in-progress snapshot promise (prevents parallel captures) */
const snapshotLocks = new Map<string, Promise<string | null>>();
const activePlaybackAssets = new Map<string, Promise<unknown>>();
let server: http.Server | null = null;
let hlsPort = 0;

const STREAM_READY_TIMEOUT_MS = 15_000;
const STREAM_READY_POLL_MS = 250;
const STDERR_HISTORY_LIMIT = 24;
const MIN_PLAYBACK_FILE_BYTES = 512_000;

function isExpectedStopError(cameraId: string, err: Error): boolean {
  const message = String(err?.message ?? '');
  return expectedStops.has(cameraId) && message.includes('killed with signal SIGKILL');
}

// ---------------------------------------------------------------------------
// Init / teardown
// ---------------------------------------------------------------------------

export async function init(): Promise<void> {
  console.log('[streamManager.init] ffmpegStatic value:', ffmpegStatic);
  try {
    const ffmpegBinary = resolveFfmpegBinaryPath(ffmpegStatic);
    console.log('[streamManager.init] Resolved ffmpeg path:', ffmpegBinary);
    ffmpeg.setFfmpegPath(ffmpegBinary);
    console.log('[streamManager.init] ffmpeg path set successfully');
  } catch (err) {
    console.error('[streamManager.init] Failed to resolve ffmpeg path:', err);
    throw err;
  }

  fs.mkdirSync(HLS_DIR, { recursive: true });
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.mkdirSync(PLAYBACK_DIR, { recursive: true });

  hlsPort = await startServer();
}

export function cleanup(): void {
  for (const id of streams.keys()) stopStream(id);
  server?.close();
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

export function stopStream(cameraId: string): void {
  const entry = streams.get(cameraId);
  if (!entry) return;
  expectedStops.add(cameraId);
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

    (proc as ffmpeg.FfmpegCommand & {
      on(event: 'error', listener: (err: Error, stdout: string, stderr: string) => void): ffmpeg.FfmpegCommand;
    }).on('error', (err: Error, _stdout: string, stderr: string) => {
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

async function streamGrowingMp4(filePath: string, res: http.ServerResponse, completed: Promise<unknown>): Promise<void> {
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
        baseDir = path.join(os.tmpdir(), 'tapostudio-recordings');
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

      console.info(`[http:server] serving ${reqPath} from ${safe}`);
      
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
                console.info(`[http:server] file not found, retrying (${retryCount}/${maxRetries})...`);
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
                console.info(`[http:server] file empty, retrying (${retryCount}/${maxRetries})...`);
              }
              setTimeout(tryRead, retryDelayMs);
              return;
            }

            console.error(`[http:server] 404 Empty file after ${retryCount} retries: ${safe}`);
            res.writeHead(404).end('Not found');
            return;
          }

          if (isPlayback && path.extname(safe).toLowerCase() === '.mp4' && stats.size < MIN_PLAYBACK_FILE_BYTES) {
            if (retryCount < maxRetries) {
              retryCount++;
              if (retryCount % 5 === 0) {
                console.info(`[http:server] playback file too small, retrying (${retryCount}/${maxRetries})...`);
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
              console.error(`[http:server] failed growing playback stream ${safe}:`, (error as Error)?.message ?? error);
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
                console.error(`[http:server] 416 Range Not Satisfiable: start=${start} >= fileSize=${fileSize}`);
                res.writeHead(416, {
                  'Content-Range': `bytes */${fileSize}`,
                }).end();
                return;
              }
              
              const rangeEnd = Math.min(end, Math.max(0, fileSize - 1));
              const length = Math.max(0, rangeEnd - start + 1);

              console.info(`[http:server] 206 Partial ${safe} (bytes ${start}-${rangeEnd}/${fileSize})`);
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
            console.info(`[http:server] 200 OK ${safe} (${data.length} bytes)`);
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
      hlsPort = (server!.address() as AddressInfo).port;
      resolve(hlsPort);
    });
  });
}
