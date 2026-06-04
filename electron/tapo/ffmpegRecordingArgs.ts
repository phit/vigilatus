import type { RecordingAudioOptions } from './recordingAudio';

export function buildDownloadFfmpegArgs(outputPath: string, audio?: RecordingAudioOptions): string[] {
  const args = ['-loglevel', 'error', '-y'];

  args.push('-f', 'mpegts', '-i', 'pipe:0');

  if (audio) {
    args.push(
      '-analyzeduration',
      '0',
      '-probesize',
      '32',
      '-f',
      audio.codec === 'pcmu' ? 'mulaw' : 'alaw',
      '-ar',
      String(audio.sampleRate),
      '-ac',
      '1',
      '-i',
      'pipe:3',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
    );
  } else {
    args.push('-c', 'copy');
  }

  args.push('-movflags', '+faststart', outputPath);
  return args;
}

export function buildPlaybackFfmpegArgs(
  outputPath: string,
  audio?: RecordingAudioOptions,
  seekOffsetSec?: number,
): string[] {
  const args = [
    '-loglevel',
    'error',
    '-y',
    '-fflags',
    '+genpts+discardcorrupt',
    '-err_detect',
    'ignore_err',
    '-analyzeduration',
    '1000000',
    '-probesize',
    '1000000',
  ];

  if (typeof seekOffsetSec === 'number' && seekOffsetSec > 0) {
    args.push('-ss', String(seekOffsetSec));
  }

  args.push('-f', 'mpegts', '-i', 'pipe:0');

  if (audio) {
    args.push(
      '-analyzeduration',
      '0',
      '-probesize',
      '32',
      '-f',
      audio.codec === 'pcmu' ? 'mulaw' : 'alaw',
      '-ar',
      String(audio.sampleRate),
      '-ac',
      '1',
      '-i',
      'pipe:3',
    );
  }

  args.push(
    '-map',
    '0:v:0',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '50',
    '-sc_threshold',
    '0',
  );

  if (audio) {
    args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k');
  }

  args.push('-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', outputPath);
  return args;
}
