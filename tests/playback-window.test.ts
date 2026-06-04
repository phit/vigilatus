import { describe, expect, it } from 'vitest';
import {
  MAX_PLAYBACK_WINDOW_MS,
  MIN_PLAYBACK_WINDOW_MS,
  normalizePlaybackWindow,
} from '../electron/ipc/playbackWindow';

describe('normalizePlaybackWindow', () => {
  // A clip longer than MAX so the cap branch is exercised.
  const START = 1_000_000;
  const END = 1_300_000; // 300_000ms long (> MAX_PLAYBACK_WINDOW_MS)

  it('clamps a requestedTime before the clip start up to the start', () => {
    expect(normalizePlaybackWindow(START, END, 500_000)).toEqual({
      startTime: START,
      endTime: START + MAX_PLAYBACK_WINDOW_MS,
    });
  });

  it('treats requestedTime exactly at the start like the start', () => {
    expect(normalizePlaybackWindow(START, END, START)).toEqual({
      startTime: START,
      endTime: START + MAX_PLAYBACK_WINDOW_MS,
    });
  });

  it('clamps a requestedTime after the clip end down to a MIN window ending at end', () => {
    expect(normalizePlaybackWindow(START, END, 2_000_000)).toEqual({
      startTime: END - MIN_PLAYBACK_WINDOW_MS,
      endTime: END,
    });
  });

  it('treats requestedTime exactly at the end like the end', () => {
    expect(normalizePlaybackWindow(START, END, END)).toEqual({
      startTime: END - MIN_PLAYBACK_WINDOW_MS,
      endTime: END,
    });
  });

  it('caps the window at MAX from the normalized start for a clip longer than MAX', () => {
    const requested = 1_100_000;
    expect(normalizePlaybackWindow(START, END, requested)).toEqual({
      startTime: requested,
      endTime: requested + MAX_PLAYBACK_WINDOW_MS,
    });
  });

  it('falls back to a window ending at end for a clip shorter than MIN', () => {
    const shortStart = 1_000_000;
    const shortEnd = 1_010_000; // 10_000ms long (< MIN_PLAYBACK_WINDOW_MS)
    expect(normalizePlaybackWindow(shortStart, shortEnd, 1_005_000)).toEqual({
      startTime: shortStart,
      endTime: shortEnd,
    });
  });
});
