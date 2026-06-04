import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TapoClient } from '../tapo/client';
import type { CameraConfig, Recording } from '../types';
import { createLogger } from '../log';

const log = createLogger('probe:playback');

interface CliArgs {
  cameraId: string;
  date: string;
  clipIndex: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for argument ${key}`);
    }
    args.set(key.slice(2), value);
    i += 1;
  }

  const cameraId = args.get('cameraId') ?? '';
  const date = args.get('date') ?? '';
  const clipIndexRaw = args.get('clipIndex') ?? '1';
  const clipIndex = Number(clipIndexRaw);

  if (!cameraId || !/^\d{8}$/.test(date) || !Number.isInteger(clipIndex) || clipIndex < 0) {
    throw new Error(
      'Usage: npm run probe:playback -- --cameraId <id> --date YYYYMMDD [--clipIndex <>=0 default 1]',
    );
  }

  return { cameraId, date, clipIndex };
}

function loadCameras(): CameraConfig[] {
  const filePath = path.join(os.homedir(), 'AppData', 'Roaming', 'vigilatus', 'cameras.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as { cameras?: CameraConfig[] };
  return parsed.cameras ?? [];
}

function buildCandidates(
  cam: CameraConfig,
): Array<{ label: string; cfg: Pick<CameraConfig, 'host' | 'username' | 'password'> }> {
  const candidates: Array<{ label: string; cfg: Pick<CameraConfig, 'host' | 'username' | 'password'> }> = [];
  const seen = new Set<string>();

  const push = (label: string, username?: string, password?: string) => {
    if (!username || !password) return;
    const key = `${username}\u0000${password}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      label,
      cfg: {
        host: cam.host,
        username,
        password,
      },
    });
  };

  push('admin+apiPass', 'admin', cam.password);
  push('admin+streamPass', 'admin', cam.streamPassword);
  push('api', cam.username, cam.password);
  push('stream', cam.streamUser, cam.streamPassword);
  push('api+streamPass', cam.username, cam.streamPassword);
  push('stream+apiPass', cam.streamUser, cam.password);

  return candidates;
}

function pickClip(recordings: Recording[], clipIndex: number): Recording {
  if (recordings.length === 0) {
    throw new Error('No recordings returned for date');
  }

  if (clipIndex < recordings.length) {
    return recordings[clipIndex];
  }

  // Fallback to longest segment if index is out of range.
  return [...recordings].sort((a, b) => b.endTime - b.startTime - (a.endTime - a.startTime))[0];
}

async function run(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const cameras = loadCameras();
  const camera = cameras.find((c) => c.id === cli.cameraId);
  if (!camera) {
    throw new Error(`Camera ${cli.cameraId} not found in saved config`);
  }

  const candidates = buildCandidates(camera);
  log.info(`camera=${camera.id} date=${cli.date} candidates=${candidates.length} clipIndex=${cli.clipIndex}`);

  let succeeded = false;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const startedAt = Date.now();
    try {
      const client = new TapoClient(candidate.cfg);
      const recordings = await client.getRecordingsForDate(cli.date);
      log.info(`candidate=${i + 1}/${candidates.length} ${candidate.label} listCount=${recordings.length}`);

      const clip = pickClip(recordings, cli.clipIndex);
      const durationSec = Math.max(0, Math.floor((clip.endTime - clip.startTime) / 1000));
      log.info(
        `candidate=${i + 1}/${candidates.length} clipStart=${clip.startTime} clipEnd=${clip.endTime} durationSec=${durationSec}`,
      );

      const output = await client.downloadRecording(clip.startTime, clip.endTime);
      const tookMs = Date.now() - startedAt;
      const stat = fs.statSync(output);
      log.info(
        `candidate=${i + 1}/${candidates.length} success=true tookMs=${tookMs} output=${output} size=${stat.size}`,
      );
      succeeded = true;
      break;
    } catch (error) {
      const tookMs = Date.now() - startedAt;
      log.warn(
        `candidate=${i + 1}/${candidates.length} success=false tookMs=${tookMs} error=${(error as Error).message}`,
      );
    }
  }

  if (!succeeded) {
    process.exitCode = 1;
  }
}

void run().catch((error) => {
  log.error('fatal', (error as Error).message);
  process.exitCode = 1;
});
