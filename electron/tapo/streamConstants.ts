/** Shared constants for the stream manager modules (temp dirs, timeouts, HLS tuning). */

import os from 'node:os';
import path from 'node:path';

// Temp directories (recreated each session, except the recordings cache).
export const HLS_DIR = path.join(os.tmpdir(), 'vigilatus-hls');
export const SNAP_DIR = path.join(os.tmpdir(), 'vigilatus-snaps');
export const PLAYBACK_DIR = path.join(os.tmpdir(), 'vigilatus-playback');
export const RECORDINGS_DIR = path.join(os.tmpdir(), 'vigilatus-recordings');

// Readiness / watchdog timings.
export const STREAM_READY_TIMEOUT_MS = 15_000;
export const HTTP_STREAM_READY_TIMEOUT_MS = 30_000;
export const STREAM_READY_POLL_MS = 250;
export const STREAM_WATCHDOG_INTERVAL_MS = 5_000;
export const LIVE_STREAM_STALL_TIMEOUT_MS = 20_000;
export const EXPECTED_STOP_CLEAR_DELAY_MS = 5_000;

// Misc limits.
export const STDERR_HISTORY_LIMIT = 24;
export const MIN_PLAYBACK_FILE_BYTES = 512_000;
export const RECORDING_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// HLS output tuning (shared by the RTSP and HTTP-media-session pipelines).
export const LIVE_HLS_SEGMENT_SECONDS = 1;
export const LIVE_HLS_PLAYLIST_SIZE = 5;
export const LIVE_AUDIO_FILTER = 'aresample=async=1:first_pts=0';
