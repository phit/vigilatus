import { _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import type { CameraConfig } from '../../../electron/types';
import type { TestFixtures } from '../../../electron/testing/fixtures';

const projectRoot = path.resolve(process.cwd());

export interface LaunchElectronAppOptions {
  fixtures: TestFixtures;
  cameras?: CameraConfig[];
}

export interface LaunchedElectronApp {
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
}

async function readTail(filePath: string, maxBytes: number): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    if (content.length <= maxBytes) return content;
    return content.slice(-maxBytes);
  } catch {
    return null;
  }
}

function formatLaunchFailure(error: unknown, userDataDir: string): string {
  const baseError = error instanceof Error ? error.stack || error.message : String(error);
  const runtimeLogPath = path.join(userDataDir, 'vigilatus.log');
  const bootstrapLogPath = path.join(userDataDir, 'vigilatus-bootstrap.log');
  const logHeader = [
    `Electron launch failed`,
    `userDataDir: ${userDataDir}`,
    `logPath: ${runtimeLogPath}`,
    `bootstrapLogPath: ${bootstrapLogPath}`,
  ].join('\n');

  return `${logHeader}\n\n${baseError}`;
}

export async function launchElectronApp(options: LaunchElectronAppOptions): Promise<LaunchedElectronApp> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vigilatus-e2e-'));
  const fixturePath = path.join(userDataDir, 'fixtures.json');

  await fs.writeFile(fixturePath, JSON.stringify(options.fixtures, null, 2), 'utf8');

  if (options.cameras) {
    await fs.writeFile(
      path.join(userDataDir, 'cameras.json'),
      JSON.stringify(
        {
          cameras: options.cameras,
          uiDisplay: {
            previews: true,
            timeline: true,
            previewPosition: 'right',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  const isCI = Boolean(process.env.CI);
  const isLinux = process.platform === 'linux';

  const launchArgs = [projectRoot];
  // Headless CI runners (any OS) lack a usable GPU; without this Electron's GPU
  // process can crash during startup before any app JS runs.
  if (isCI) {
    launchArgs.push('--disable-gpu', '--disable-software-rasterizer');
  }
  if (isLinux) {
    launchArgs.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage');
  }

  try {
    const app = await electron.launch({
      args: launchArgs,
      env: {
        ...process.env,
        VIGILATUS_USER_DATA_DIR: userDataDir,
        VIGILATUS_TEST_FIXTURES: fixturePath,
        VIGILATUS_OPEN_DEVTOOLS: '0',
        ...(isCI ? { ELECTRON_ENABLE_LOGGING: '1', ELECTRON_ENABLE_STACK_DUMPING: '1' } : {}),
      },
      timeout: isCI ? 30_000 : 10_000,
    });

    const proc = app.process();
    proc.stdout?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.info(`[electron] ${line}`);
    });
    proc.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.info(`[electron:err] ${line}`);
    });

    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    return { app, window, userDataDir };
  } catch (error) {
    const launchDetails = formatLaunchFailure(error, userDataDir);
    const runtimeLogTail = await readTail(path.join(userDataDir, 'vigilatus.log'), 20_000);
    const bootstrapLogTail = await readTail(path.join(userDataDir, 'vigilatus-bootstrap.log'), 20_000);
    const details = [launchDetails];
    if (bootstrapLogTail) {
      details.push(`--- vigilatus-bootstrap.log tail ---\n${bootstrapLogTail}`);
    }
    if (runtimeLogTail) {
      details.push(`--- vigilatus.log tail ---\n${runtimeLogTail}`);
    }
    throw new Error(details.join('\n\n'));
  }
}
