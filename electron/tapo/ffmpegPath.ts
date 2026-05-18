import fs from 'node:fs';

export function resolveFfmpegBinaryPath(ffmpegPath: string | null): string {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static is not available on this platform');
  }

  const candidates = new Set<string>([ffmpegPath]);

  // In packaged Electron apps, binaries are unpacked to app.asar.unpacked.
  if (ffmpegPath.includes('app.asar')) {
    candidates.add(ffmpegPath.replace('app.asar', 'app.asar.unpacked'));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`ffmpeg binary not found at expected paths: ${Array.from(candidates).join(', ')}`);
}
