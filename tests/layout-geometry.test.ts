import { describe, expect, it } from 'vitest';
import { cascadeRect, clampRect, toPixels } from '../src/components/layoutGeometry';

describe('clampRect', () => {
  it('returns a rect unchanged when it is already valid', () => {
    expect(clampRect({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 })).toEqual({
      x: 0.1,
      y: 0.1,
      w: 0.5,
      h: 0.5,
    });
  });

  it('clamps width below minimum', () => {
    const r = clampRect({ x: 0, y: 0, w: 0.01, h: 0.5 });
    expect(r.w).toBe(0.1);
  });

  it('clamps height below minimum', () => {
    const r = clampRect({ x: 0, y: 0, w: 0.5, h: 0.01 });
    expect(r.h).toBe(0.1);
  });

  it('clamps x so the tile does not overflow the right edge', () => {
    // w = 0.5, x = 0.8 → x must be at most 0.5
    const r = clampRect({ x: 0.8, y: 0, w: 0.5, h: 0.5 });
    expect(r.x).toBe(0.5);
  });

  it('clamps y so the tile does not overflow the bottom edge', () => {
    const r = clampRect({ x: 0, y: 0.9, w: 0.5, h: 0.5 });
    expect(r.y).toBe(0.5);
  });

  it('clamps negative x to 0', () => {
    const r = clampRect({ x: -0.2, y: 0, w: 0.4, h: 0.4 });
    expect(r.x).toBe(0);
  });

  it('respects custom minW / minH', () => {
    const r = clampRect({ x: 0, y: 0, w: 0.05, h: 0.05 }, 0.2, 0.2);
    expect(r.w).toBe(0.2);
    expect(r.h).toBe(0.2);
  });
});

describe('toPixels', () => {
  it('converts a full-area normalised rect to container dimensions', () => {
    expect(toPixels({ x: 0, y: 0, w: 1, h: 1 }, 1280, 720)).toEqual({
      left: 0,
      top: 0,
      width: 1280,
      height: 720,
    });
  });

  it('converts a half-size centred rect correctly', () => {
    expect(toPixels({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 1000, 800)).toEqual({
      left: 250,
      top: 200,
      width: 500,
      height: 400,
    });
  });
});

describe('cascadeRect', () => {
  it('returns full area for the first tile', () => {
    expect(cascadeRect(0)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('places the second tile at the half-size drag-drop default, leaving the first visible', () => {
    expect(cascadeRect(1)).toEqual({ x: 0.05, y: 0.05, w: 0.5, h: 0.5 });
  });

  it('offsets subsequent tiles at half size and keeps them within bounds', () => {
    for (let i = 1; i <= 6; i++) {
      const r = cascadeRect(i);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(1);
      expect(r.y + r.h).toBeLessThanOrEqual(1);
      expect(r.w).toBe(0.5);
      expect(r.h).toBe(0.5);
    }
  });
});
