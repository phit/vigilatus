export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_W = 0.1;
const MIN_H = 0.1;

/** Clamp a normalised rect so it stays within [0,1] with minimum dimensions. */
export function clampRect(rect: NormalizedRect, minW = MIN_W, minH = MIN_H): NormalizedRect {
  const w = Math.max(minW, Math.min(1, rect.w));
  const h = Math.max(minH, Math.min(1, rect.h));
  const x = Math.max(0, Math.min(1 - w, rect.x));
  const y = Math.max(0, Math.min(1 - h, rect.y));
  return { x, y, w, h };
}

/** Convert a normalised rect to absolute pixel values for a given container. */
export function toPixels(
  rect: NormalizedRect,
  containerW: number,
  containerH: number,
): { left: number; top: number; width: number; height: number } {
  return {
    left: rect.x * containerW,
    top: rect.y * containerH,
    width: rect.w * containerW,
    height: rect.h * containerH,
  };
}

/** Convert absolute pixel deltas to a normalised rect delta. */
export function toNormalisedDelta(
  dxPx: number,
  dyPx: number,
  containerW: number,
  containerH: number,
): { dx: number; dy: number } {
  return { dx: dxPx / containerW, dy: dyPx / containerH };
}

/**
 * Return a sensible default rect for a new tile based on how many tiles already exist.
 * The first tile fills the whole area; subsequent tiles cascade with decreasing size.
 */
export function cascadeRect(existingCount: number): NormalizedRect {
  if (existingCount === 0) return { x: 0, y: 0, w: 1, h: 1 };
  const offset = Math.min(0.05 * existingCount, 0.3);
  const size = Math.max(0.5, 1 - offset * 2);
  return clampRect({ x: offset, y: offset, w: size, h: size });
}

/** Return the next z value to bring a tile to the front. */
export function nextZ(currentMaxZ: number): number {
  return currentMaxZ + 1;
}
