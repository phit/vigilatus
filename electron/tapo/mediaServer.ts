/**
 * Embedded loopback HTTP server that serves HLS playlists/segments and recording
 * playback MP4s (including still-growing files) to the renderer. Owns the random
 * loopback port and the registry of in-progress playback assets.
 */

import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createLogger } from '../log';
import { HLS_DIR, MIN_PLAYBACK_FILE_BYTES, PLAYBACK_DIR } from './streamConstants';

let server: http.Server | null = null;
let hlsPort = 0;
const activePlaybackAssets = new Map<string, Promise<unknown>>();

/** Loopback port the media server is listening on (0 until startMediaServer resolves). */
export function getHlsPort(): number {
  return hlsPort;
}

export function getPlaybackAssetUrl(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return `http://127.0.0.1:${hlsPort}/playback/${normalized}`;
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

/**
 * Resolve a request's relative path against a base directory, returning the
 * absolute path only when it stays strictly inside `baseDir`. Returns null for
 * traversal attempts (`..`), absolute escapes, and requests for the base dir
 * itself. Uses path.relative rather than a string prefix check so a sibling
 * directory sharing a name prefix (e.g. `<base>-evil`) cannot slip through.
 */
export function resolveServedFilePath(baseDir: string, relativeFilePath: string): string | null {
  const resolved = path.resolve(baseDir, relativeFilePath);
  const rel = path.relative(baseDir, resolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
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
    let stats: fs.Stats | null;
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

export function startMediaServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const log = createLogger('http:server');
      const reqPath = decodeURIComponent((req.url ?? '/').replace(/\?.*$/, ''));
      const relativePath = reqPath.replace(/^\/+/, '');
      const isPlayback = relativePath.startsWith('playback/');
      const baseDir = isPlayback ? PLAYBACK_DIR : HLS_DIR;
      const filePath = isPlayback ? relativePath.replace(/^playback\//, '') : relativePath;

      const safe = resolveServedFilePath(baseDir, filePath);
      if (!safe) {
        log.error(`403 Forbidden for ${reqPath}`);
        res.writeHead(403).end('Forbidden');
        return;
      }

      // Retry logic: wait for background-created playback assets to appear.
      const maxRetries = isPlayback ? 300 : 2;
      const retryDelayMs = 200;
      let retryCount = 0;

      const tryRead = () => {
        fs.stat(safe, (statErr, stats) => {
          if (statErr) {
            if (retryCount < maxRetries && isPlayback) {
              retryCount++;
              setTimeout(tryRead, retryDelayMs);
              return;
            }

            log.error(`404 Not found after ${retryCount} retries: ${safe}`);
            res.writeHead(404).end('Not found');
            return;
          }

          if (isPlayback && stats.size <= 0) {
            if (retryCount < maxRetries) {
              retryCount++;
              setTimeout(tryRead, retryDelayMs);
              return;
            }

            log.error(`404 Empty file after ${retryCount} retries: ${safe}`);
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
              setTimeout(tryRead, retryDelayMs);
              return;
            }

            log.error(`404 Playback file too small after ${retryCount} retries: ${safe}`);
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
              log.error(`failed growing playback stream ${safe}:`, (error as Error)?.message ?? error);
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
                log.error(`416 Range Not Satisfiable: start=${start} >= fileSize=${fileSize}`);
                res
                  .writeHead(416, {
                    'Content-Range': `bytes */${fileSize}`,
                  })
                  .end();
                return;
              }

              const rangeEnd = Math.min(end, Math.max(0, fileSize - 1));
              const length = Math.max(0, rangeEnd - start + 1);

              res.writeHead(206, {
                'Content-Type': mime,
                'Content-Length': length,
                'Content-Range': `bytes ${start}-${rangeEnd}/${fileSize}`,
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                Pragma: 'no-cache',
                Expires: '0',
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
              log.error(`404 Not found: ${safe} - ${readErr.message}`);
              res.writeHead(404).end('Not found');
              return;
            }
            res.writeHead(200, {
              'Content-Type': mime,
              'Content-Length': data.length,
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-store, no-cache, must-revalidate',
              Pragma: 'no-cache',
              Expires: '0',
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

export function closeMediaServer(): void {
  server?.close();
  server?.closeAllConnections();
}
