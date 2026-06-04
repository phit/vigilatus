/**
 * Snapshot capture: prefers grabbing a frame from a running HLS stream, then
 * falls back to a one-shot RTSP frame or an HTTP Media Session frame.
 */

import ffmpeg from 'fluent-ffmpeg';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { CameraConfig } from '../types';
import { ffmpegBinaryPath } from './ffmpegPath';
import { MediaSession, hashMediaPassword } from './recordingDownloader';
import * as configStore from '../config/store';
import { createLogger } from '../log';
import { SNAP_DIR } from './streamConstants';
import { buildRtspUrl } from './streamHelpers';
import { streams } from './streamRegistry';

type HashMethod = 'md5' | 'sha256';

/** Per-camera in-progress snapshot promise (prevents parallel captures) */
const snapshotLocks = new Map<string, Promise<string | null>>();

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
