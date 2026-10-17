/**
 * Renderer media capability checks, reported to the main process so it can
 * pick a live pipeline the player can actually decode.
 */

// HEVC Main profile, level 5.1 — enough for 2160p cameras.
const HEVC_4K_MIME = 'video/mp4; codecs="hvc1.1.6.L153.B0"';

let hevcSupported: boolean | undefined;

/**
 * Whether MSE (and thus hls.js) can play HEVC from fMP4. Chromium only reports
 * this when a hardware/platform decoder is available. Cached after first call.
 */
export function canPlayHevc(): boolean {
  if (hevcSupported === undefined) {
    try {
      hevcSupported = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(HEVC_4K_MIME);
    } catch {
      hevcSupported = false;
    }
  }
  return hevcSupported;
}
