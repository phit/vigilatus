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
import { LIVE_HLS_PLAYLIST_SIZE, LIVE_HLS_SEGMENT_SECONDS } from './streamConstants';

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
 * The HLS muxer block shared by both live pipelines:
 * `-max_interleave_delta 0 -muxpreload 0 -muxdelay 0 -f hls
 *  -hls_time <seg> -hls_list_size <size>
 *  -hls_flags delete_segments+independent_segments
 *  -hls_segment_filename <segDir>/segment-<token>-%03d.ts`.
 *
 * Does NOT include the playlist (`m3u8`) path: the HTTP pipeline appends it as a
 * positional arg while the RTSP pipeline supplies it via fluent-ffmpeg `.save()`.
 * `segmentFilename` is the already-joined `-hls_segment_filename` value (call
 * sites build it with `node:path` so this module stays free of fs/path imports).
 */
export function hlsMuxArgs(segmentFilename: string): string[] {
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
    '-hls_segment_filename',
    segmentFilename,
  ];
}
