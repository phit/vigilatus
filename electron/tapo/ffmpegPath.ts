import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

function isAsarArchivePath(candidate: string): boolean {
  return candidate.includes('app.asar') && !candidate.includes('app.asar.unpacked');
}

function extractBinaryFromAsar(sourcePath: string): string {
  const binaryName = path.basename(sourcePath);
  const targetDir = path.join(app.getPath('userData'), 'bin');
  const targetPath = path.join(targetDir, binaryName);

  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);

  if (process.platform !== 'win32') {
    fs.chmodSync(targetPath, 0o755);
  }

  console.log('[ffmpegPath] Extracted asar binary to:', targetPath);
  return targetPath;
}

export function resolveFfmpegBinaryPath(ffmpegPath: string | null): string {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static is not available on this platform');
  }

  const candidates = new Set<string>();

  // In packaged Electron apps, try multiple locations
  if (ffmpegPath.includes('app.asar')) {
    // Try unpacked location first
    candidates.add(ffmpegPath.replace('app.asar\\', 'app.asar.unpacked\\'));
    candidates.add(ffmpegPath.replace('app.asar/', 'app.asar.unpacked/'));
  }

  candidates.add(ffmpegPath);

  // Also check in app resources
  if (app.isPackaged) {
    const appPath = app.getAppPath();
    const resourcesPath = path.join(path.dirname(appPath), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
    candidates.add(resourcesPath);
  }

  console.log('[ffmpegPath] Input:', ffmpegPath);
  console.log('[ffmpegPath] Candidates:', Array.from(candidates));
  console.log('[ffmpegPath] app.isPackaged:', app.isPackaged);

  for (const candidate of candidates) {
    console.log('[ffmpegPath] Checking:', candidate, '- exists:', fs.existsSync(candidate));
    if (!fs.existsSync(candidate)) {
      continue;
    }

    if (app.isPackaged && isAsarArchivePath(candidate)) {
      console.log('[ffmpegPath] Found in app.asar, extracting to a real file for execution');
      return extractBinaryFromAsar(candidate);
    }

    if (fs.statSync(candidate).isFile()) {
      console.log('[ffmpegPath] Found at:', candidate);
      return candidate;
    }
  }

  throw new Error(`ffmpeg binary not found at expected paths: ${Array.from(candidates).join(', ')}`);
}
