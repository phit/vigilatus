import { _electron as electron, expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CameraConfig } from '../../electron/types';
import type { TestFixtures } from '../../electron/testing/fixtures';

const electronPath = path.join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron',
);
const projectRoot = path.resolve(process.cwd());

async function launchElectronApp(options: { fixtures: TestFixtures; cameras?: CameraConfig[] }) {
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

  const app = await electron.launch({
    executablePath: electronPath,
    args: [
      projectRoot,
      ...(isLinux
        ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-setuid-sandbox']
        : []),
    ],
    env: {
      ...process.env,
      VIGILATUS_USER_DATA_DIR: userDataDir,
      VIGILATUS_TEST_FIXTURES: fixturePath,
      VIGILATUS_OPEN_DEVTOOLS: '0',
      ...(isCI && isLinux ? { ELECTRON_ENABLE_LOGGING: '1' } : {}),
    },
    timeout: isCI ? 30_000 : 10_000,
  });

  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  return { app, window, userDataDir };
}

test('launches the real app and creates a camera through the UI', async () => {
  const { app, window, userDataDir } = await launchElectronApp({ fixtures: { streams: {} } });

  try {
    const runtimeInfo = await window.evaluate(() => window.vigilatus.diagnostics.getRuntimeInfo());
    await expect
      .poll(async () => {
        if (!runtimeInfo.logPath) return '';
        try {
          return await fs.readFile(runtimeInfo.logPath, 'utf8');
        } catch {
          return '';
        }
      })
      .toContain('=== Vigilatus Started ===');

    await expect(window.getByTestId('empty-state')).toBeVisible();
    await window.getByTestId('empty-state-add-camera').click();
    await expect(window.getByTestId('add-camera-modal')).toBeVisible();

    await window.getByLabel('Camera name').fill('Front Door');
    await window.getByLabel('IP address').fill('192.168.1.50');
    await window.getByLabel('Tapo API username').fill('admin');
    await window.getByLabel('Tapo API password').fill('secret');
    await window.getByTestId('add-camera-save').click();

    await expect(window.getByTestId('add-camera-modal')).toHaveCount(0);
    await expect(window.getByTestId('empty-state')).toHaveCount(0);
    await expect(window.getByTestId('preview-strip')).toBeVisible();
    await expect(
      window.getByTestId('preview-strip').getByRole('button', { name: /Front Door/i }),
    ).toBeVisible();

    const persisted = JSON.parse(await fs.readFile(path.join(userDataDir, 'cameras.json'), 'utf8')) as {
      cameras?: Array<{ name: string }>;
    };
    expect(persisted.cameras?.[0]?.name).toBe('Front Door');
  } finally {
    await app.close();
  }
});

test('drives the timeline into playback using mocked recordings', async () => {
  const now = Date.now();
  const cameraId = 'front-door';
  const cameras: CameraConfig[] = [
    {
      id: cameraId,
      name: 'Front Door',
      host: '192.168.1.50',
      username: 'admin',
      password: 'secret',
      streamUser: 'admin',
      streamPassword: 'stream-secret',
    },
  ];
  const fixtures: TestFixtures = {
    streams: { [cameraId]: null },
    recordings: {
      [cameraId]: [
        {
          startTime: now - 12 * 60 * 60 * 1000,
          endTime: now - 11 * 60 * 60 * 1000,
        },
      ],
    },
    playbackUrls: { [cameraId]: 'about:blank' },
  };

  const { app, window } = await launchElectronApp({ fixtures, cameras });

  try {
    await expect(window.getByTestId('timeline')).toBeVisible();
    await expect(window.getByText(/1 recording segment found/i)).toBeVisible();

    const segment = window.locator('.timeline-segment').first();
    await expect(segment).toBeVisible();
    const segBox = await segment.boundingBox();
    expect(segBox).not.toBeNull();
    if (!segBox) return;
    await window.mouse.click(segBox.x + segBox.width / 2, segBox.y + segBox.height / 2);

    await expect(window.locator('.viewer-badge')).toHaveText('Playback');
  } finally {
    await app.close();
  }
});
