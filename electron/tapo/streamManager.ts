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

// ---------------------------------------------------------------------------
// Init / teardown
// ---------------------------------------------------------------------------

export async function init(): Promise<void> {
  if (!ffmpegStatic) throw new Error('ffmpeg-static not available on this platform');
  ffmpeg.setFfmpegPath(ffmpegStatic);

  fs.mkdirSync(HLS_DIR, { recursive: true });
  fs.mkdirSync(SNAP_DIR, { recursive: true });

  hlsPort = await startServer();
}

export function cleanup(): void {
  for (const id of streams.keys()) stopStream(id);
  server?.close();
}

// ---------------------------------------------------------------------------
// Live stream
// ---------------------------------------------------------------------------

export function startStream(cameraId: string, cfg: CameraConfig): string {
  const existing = streams.get(cameraId);
  if (existing) return existing.hlsUrl;

  const segDir = path.join(HLS_DIR, cameraId);
  fs.mkdirSync(segDir, { recursive: true });
  const m3u8 = path.join(segDir, 'stream.m3u8');
  const hlsUrl = `http://127.0.0.1:${hlsPort}/${cameraId}/stream.m3u8`;
  const rtsp = buildRtspUrl(cfg, 'main');

  const proc = ffmpeg(rtsp)
    .inputOptions([
      '-rtsp_transport',
      'tcp',
      '-rw_timeout',
      '10000000',
      '-reconnect',
      '1',
      '-reconnect_at_eof',
      '1',
      '-reconnect_streamed',
      '1',
    ])
    .videoCodec('copy')
    .audioCodec('aac')
    .outputOptions([
      '-f hls',
      '-hls_time 2',
      '-hls_list_size 5',
      '-hls_flags delete_segments+append_list',
      '-start_number 0',
    ])
    .on('error', (err: Error) => {
      console.error(`[stream:${cameraId}] error:`, err.message);
      streams.delete(cameraId);
    })
    .on('end', () => streams.delete(cameraId));

  proc.save(m3u8);
  streams.set(cameraId, { proc, hlsUrl });
  return hlsUrl;
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

/** Restart the stream with a time offset for recording playback.  Returns the HLS URL. */
export function startPlayback(cameraId: string, cfg: CameraConfig, seekSeconds: number): string {
  stopStream(cameraId);

  const segDir = path.join(HLS_DIR, cameraId);
  fs.mkdirSync(segDir, { recursive: true });
  const m3u8 = path.join(segDir, 'stream.m3u8');
  const hlsUrl = `http://127.0.0.1:${hlsPort}/${cameraId}/stream.m3u8`;
  const rtsp = buildRtspUrl(cfg, 'main');

  const proc = ffmpeg(rtsp)
    .inputOptions([
      '-rtsp_transport',
      'tcp',
      '-rw_timeout',
      '10000000',
      '-ss',
      String(seekSeconds),
    ])
    .videoCodec('copy')
    .audioCodec('aac')
    .outputOptions([
      '-f hls',
      '-hls_time 2',
      '-hls_list_size 5',
      '-hls_flags delete_segments+append_list',
      '-start_number 0',
    ])
    .on('error', (err: Error) => {
      console.error(`[playback:${cameraId}] error:`, err.message);
      streams.delete(cameraId);
    })
    .on('end', () => streams.delete(cameraId));

  proc.save(m3u8);
  streams.set(cameraId, { proc, hlsUrl });
  return hlsUrl;
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
      .inputOptions(['-rtsp_transport', 'tcp', '-rw_timeout', '5000000'])
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
    return withRtspAuth(cfg.rtspUrl, cfg.rtspUsername, cfg.rtspPassword);
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

// ---------------------------------------------------------------------------
// HLS HTTP server
// ---------------------------------------------------------------------------

function startServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      // Prevent path traversal
      const reqPath = (req.url ?? '/').replace(/\?.*$/, '');
      const safe = path.resolve(path.join(HLS_DIR, path.normalize(reqPath)));
      if (!safe.startsWith(HLS_DIR)) {
        res.writeHead(403).end('Forbidden');
        return;
      }

      fs.readFile(safe, (err, data) => {
        if (err) {
          res.writeHead(404).end('Not found');
          return;
        }
        const ext = path.extname(safe);
        const mime = ext === '.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/MP2T';
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
