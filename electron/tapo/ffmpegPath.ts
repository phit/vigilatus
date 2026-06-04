import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { app } from 'electron';
import { createLogger } from '../log';

const log = createLogger('ffmpegPath');

function supportsLibx264(ffmpegBinary: string): boolean {
  try {
    const output = execFileSync(ffmpegBinary, ['-encoders'], { encoding: 'utf-8' });
    return output.includes('libx264');
  } catch {
    return false;
  }
}

function findSystemFfmpeg(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['ffmpeg'], { encoding: 'utf-8' }).trim();
    const binary = result.split('\n')[0];
    if (binary && fs.existsSync(binary) && supportsLibx264(binary)) {
      return binary;
    }
  } catch {
    // not found on PATH
  }
  return null;
}

function resolve(): string {
  // Prefer a system-installed ffmpeg if available
  const systemFfmpeg = findSystemFfmpeg();
  if (systemFfmpeg) {
    log.info('Using system ffmpeg:', systemFfmpeg);
    return systemFfmpeg;
  }

  if (!ffmpegStatic) {
    throw new Error('ffmpeg-static is not available on this platform');
  }

  // Fall back to the bundled ffmpeg-static binary (unpacked path in packaged apps)
  const candidates: string[] = [];

  if (ffmpegStatic.includes('app.asar')) {
    candidates.push(ffmpegStatic.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep));
  }

  if (app.isPackaged) {
    const appPath = app.getAppPath();
    const ext = process.platform === 'win32' ? '.exe' : '';
    candidates.push(
      path.join(path.dirname(appPath), 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg' + ext),
    );
  }

  candidates.push(ffmpegStatic);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      log.info('Using bundled ffmpeg:', candidate);
      return candidate;
    }
  }

  throw new Error(
    'ffmpeg binary not found. Install ffmpeg on your system or ensure ffmpeg-static is unpacked. Checked: ' +
      candidates.join(', '),
  );
}

/** Resolved once at startup. Import this instead of calling a function each time. */
export const ffmpegBinaryPath = resolve();
