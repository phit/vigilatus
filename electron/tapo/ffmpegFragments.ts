/**
 * Pure, composable ffmpeg argument fragments shared across the stream pipelines
 * (recording download/playback in `ffmpegRecordingArgs.ts`, live HTTP-media →
 * HLS in `httpStream.ts`, live RTSP → HLS in `streamHelpers.ts`).
 *
 * Each helper returns the *exact* flag sequence its call sites used inline
 * before consolidation — the output is byte-for-byte identical and guarded by
 * the inline snapshots in `tests/recording-media.test.ts` and
 * `tests/ffmpeg-args.test.ts`. This module must stay pure (no electron, ffmpeg
 * binary, socket, or fs imports) so it remains trivially unit-testable.
 */

import type { RecordingAudioOptions } from './recordingAudio';
import {
  LIVE_HLS_PLAYLIST_SIZE,
  LIVE_HLS_SEGMENT_SECONDS,
  LIVE_MAX_TRANSCODE_HEIGHT,
} from './streamConstants';

/**
 * How a live pipeline handles video: `copy` passes the camera's H.264 through
 * untouched (near-zero CPU); `copy-hevc` does the same for H.265, muxed as fMP4
 * HLS since hls.js only plays HEVC from fMP4; `transcode` decodes and
 * re-encodes with libx264, downscaled to at most `LIVE_MAX_TRANSCODE_HEIGHT`.
 */
export type LiveVideoMode = 'copy' | 'copy-hevc' | 'transcode';

/**
 * The G.711 PCM audio *input* block fed to ffmpeg on fd 3:
 * `-analyzeduration 0 -probesize 32 -f mulaw|alaw -ar <rate> -ac 1 -i pipe:3`.
 *
 * Identical across the download, playback, and live HTTP pipelines.
 */
export function pcmAudioInputArgs(codec: RecordingAudioOptions['codec'], sampleRate: number): string[] {
  return [
    '-analyzeduration',
    '0',
    '-probesize',
    '32',
    '-f',
    codec === 'pcmu' ? 'mulaw' : 'alaw',
    '-ar',
    String(sampleRate),
    '-ac',
    '1',
    '-i',
    'pipe:3',
  ];
}

/**
 * The libx264 video-encode block shared by the two *live* (HLS) pipelines:
 * `-c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p
 *  -force_key_frames expr:gte(t,n_forced*<seg>) -sc_threshold 0`.
 *
 * Starts at `-c:v` — the stream `-map` differs per pipeline and stays inline.
 * Not shared with the recording playback encoder, which uses `-preset ultrafast`
 * and `-g 50` instead of `-force_key_frames`, so that block is left as-is.
 */
export function liveH264VideoArgs(): string[] {
  return [
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'zerolatency',
    '-pix_fmt',
    'yuv420p',
    '-force_key_frames',
    `expr:gte(t,n_forced*${LIVE_HLS_SEGMENT_SECONDS})`,
    '-sc_threshold',
    '0',
  ];
}

/**
 * Input options for the live pipelines: `-hwaccel auto` lets ffmpeg decode on
 * the GPU (D3D11VA/DXVA2/VideoToolbox/VAAPI/CUDA) when available and silently
 * falls back to software otherwise. Only needed when transcoding.
 */
export function liveHwDecodeInputArgs(mode: LiveVideoMode): string[] {
  return mode === 'transcode' ? ['-hwaccel', 'auto'] : [];
}

/**
 * The live video-output block (after `-map`): stream copy for the copy modes
 * (HEVC tagged `hvc1`, which Chromium's MSE requires), or a height-capped
 * libx264 encode for `transcode`. Never upscales.
 */
export function liveVideoArgs(mode: LiveVideoMode): string[] {
  if (mode === 'copy') return ['-c:v', 'copy'];
  if (mode === 'copy-hevc') return ['-c:v', 'copy', '-tag:v', 'hvc1'];
  return ['-vf', `scale=-2:'min(ih,${LIVE_MAX_TRANSCODE_HEIGHT})'`, ...liveH264VideoArgs()];
}

/**
 * Per-session live HLS file names: MPEG-TS segments, or fMP4 segments plus an
 * init segment for `copy-hevc`. Bare names (no directory) — callers join them.
 */
export function liveSegmentNames(
  mode: LiveVideoMode,
  sessionToken: string,
): { segment: string; init?: string } {
  if (mode === 'copy-hevc') {
    return { segment: `segment-${sessionToken}-%03d.m4s`, init: `init-${sessionToken}.mp4` };
  }
  return { segment: `segment-${sessionToken}-%03d.ts` };
}

/**
 * The HLS muxer block shared by both live pipelines:
 * `-max_interleave_delta 0 -muxpreload 0 -muxdelay 0 -f hls
 *  -hls_time <seg> -hls_list_size <size>
 *  -hls_flags delete_segments+independent_segments
 *  -hls_segment_filename <segDir>/segment-<token>-%03d.ts`.
 *
 * Does NOT include the playlist (`m3u8`) path: the HTTP pipeline appends it as a
 * positional arg while the RTSP pipeline supplies it via fluent-ffmpeg `.save()`.
 * `fmp4InitFilename` (a bare name, written next to the playlist) switches the
 * segments to fMP4. `segmentFilename` is the already-joined `-hls_segment_filename` value (call
 * sites build it with `node:path` so this module stays free of fs/path imports).
 */
export function hlsMuxArgs(segmentFilename: string, fmp4InitFilename?: string): string[] {
  const fmp4 = fmp4InitFilename
    ? ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', fmp4InitFilename]
    : [];
  return [
    '-max_interleave_delta',
    '0',
    '-muxpreload',
    '0',
    '-muxdelay',
    '0',
    '-f',
    'hls',
    '-hls_time',
    String(LIVE_HLS_SEGMENT_SECONDS),
    '-hls_list_size',
    String(LIVE_HLS_PLAYLIST_SIZE),
    '-hls_flags',
    'delete_segments+independent_segments',
    ...fmp4,
    '-hls_segment_filename',
    segmentFilename,
  ];
}
