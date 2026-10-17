/**
 * Picks main vs sub stream per camera from how large its tiles are on screen.
 * Pure — no React/store imports — so it is unit-tested in isolation.
 */

import type { CameraConfig, LayoutTile, StreamQuality } from './types';

// Sub-streams are 720p. Hysteresis band in *device* pixels of tile height, so
// a resize hovering around one threshold doesn't flap between streams (every
// switch restarts the stream).
export const SUB_TO_MAIN_HEIGHT_PX = 900;
export const MAIN_TO_SUB_HEIGHT_PX = 700;

export interface Viewport {
  /** Layout area size in CSS pixels. */
  w: number;
  h: number;
  /** window.devicePixelRatio */
  dpr: number;
}

/** Whether the camera has a low-res stream to switch to. */
export function supportsSubStream(cfg: CameraConfig): boolean {
  if (cfg.streamProtocol === 'http') return false;
  // Native Tapo RTSP always has stream2; an external source needs an explicit sub URL.
  return !cfg.rtspUrl || !!cfg.rtspSubUrl;
}

/** Tallest on-screen tile height for a camera, in device pixels (0 if no tile). */
export function maxTileHeightPx(tiles: LayoutTile[], cameraId: string, viewport: Viewport): number {
  let max = 0;
  for (const tile of tiles) {
    if (tile.cameraId === cameraId) max = Math.max(max, tile.h * viewport.h * viewport.dpr);
  }
  return max;
}

export function pickStreamQuality(heightPx: number, current: StreamQuality | undefined): StreamQuality {
  if (current === 'main') return heightPx < MAIN_TO_SUB_HEIGHT_PX ? 'sub' : 'main';
  if (current === 'sub') return heightPx > SUB_TO_MAIN_HEIGHT_PX ? 'main' : 'sub';
  return heightPx > (MAIN_TO_SUB_HEIGHT_PX + SUB_TO_MAIN_HEIGHT_PX) / 2 ? 'main' : 'sub';
}

/**
 * The stream a camera should use given the layout. Falls back to `main` when
 * the camera has no sub-stream, the viewport isn't measured yet, or it has no tile.
 */
export function desiredStreamQuality(
  cfg: CameraConfig,
  tiles: LayoutTile[],
  viewport: Viewport | null,
  current: StreamQuality | undefined,
): StreamQuality {
  if (!viewport || !supportsSubStream(cfg)) return 'main';
  const height = maxTileHeightPx(tiles, cfg.id, viewport);
  if (height === 0) return current ?? 'main';
  return pickStreamQuality(height, current);
}
