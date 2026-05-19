import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TapoClient } from '../tapo/client';
import type { CameraConfig } from '../types';

interface CliArgs {
  cameraId?: string;
  host?: string;
  username?: string;
  password?: string;
  date: string;
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

  const cameraId = args.get('cameraId') ?? undefined;
  const host = args.get('host') ?? undefined;
  const username = args.get('username') ?? undefined;
  const password = args.get('password') ?? undefined;
  const date = args.get('date') ?? '';

  const hasDirectCredentials = Boolean(host && username && password);
  if ((!cameraId && !hasDirectCredentials) || !/^\d{8}$/.test(date)) {
    throw new Error(
      'Usage: npm run probe:recordings -- --cameraId <id> --date YYYYMMDD\n' +
        '   or: npm run probe:recordings -- --host <ip-or-host> --username <user> --password <pass> --date YYYYMMDD [--streamUser <user> --streamPassword <pass>]',
    );
  }

  return {
    cameraId,
    host,
    username,
    password,
    date,
  };
}

function loadCameras(): CameraConfig[] {
  const filePath = path.join(os.homedir(), 'AppData', 'Roaming', 'tapostudio', 'cameras.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as { cameras?: CameraConfig[] };
  return parsed.cameras ?? [];
}

async function run(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  let host = cli.host;
  let username = cli.username;
  let password = cli.password;
  let probeLabel = 'direct';

  if (cli.cameraId) {
    const cameras = loadCameras();
    const camera = cameras.find((entry) => entry.id === cli.cameraId);
    if (!camera) {
      throw new Error(`Camera ${cli.cameraId} not found in saved config`);
    }
    host = camera.host;
    username = camera.username;
    password = camera.password;
    probeLabel = `camera=${camera.id}`;
    console.info(
      `[probe:recordings] ${probeLabel} host=${camera.host} user=${camera.username} date=${cli.date}`,
    );
  } else {
    host = cli.host;
    console.info(`[probe:recordings] host=${host} user=${username} date=${cli.date}`);
  }

  if (!host || !username || !password) {
    throw new Error('Missing host or credentials for recordings probe');
  }

  const startedAt = Date.now();
  try {
    const client = new TapoClient({
      host,
      username,
      password,
    });

    const recordings = await client.getRecordingsForDate(cli.date);
    const tookMs = Date.now() - startedAt;
    console.info(`[probe:recordings] ${probeLabel} success=true count=${recordings.length} tookMs=${tookMs}`);

    if (recordings.length > 0) {
      const sample = recordings.slice(0, 5).map((r) => ({
        startTime: r.startTime,
        endTime: r.endTime,
      }));
      console.info(`[probe:recordings] sample=${JSON.stringify(sample)}`);
    }
  } catch (error) {
    const tookMs = Date.now() - startedAt;
    console.error(
      `[probe:recordings] ${probeLabel} success=false tookMs=${tookMs} error=${(error as Error).message}`,
    );
    process.exitCode = 1;
  }
}

void run().catch((error) => {
  console.error('[probe:recordings] fatal', (error as Error).message);
  process.exitCode = 1;
});
