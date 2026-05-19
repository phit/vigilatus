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

async function launchElectronApp(options: {
  fixtures: TestFixtures;
  cameras?: CameraConfig[];
}) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tapostudio-e2e-'));
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

  const app = await electron.launch({
    executablePath: electronPath,
    args: [projectRoot],
    env: {
      ...process.env,
      TAPOSTUDIO_USER_DATA_DIR: userDataDir,
      TAPOSTUDIO_TEST_FIXTURES: fixturePath,
      TAPOSTUDIO_OPEN_DEVTOOLS: '0',
    },
  });

  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  return { app, window, userDataDir };
}

test('launches the real app and creates a camera through the UI', async () => {
  const { app, window, userDataDir } = await launchElectronApp({ fixtures: { streams: {} } });

  try {
    const runtimeInfo = await window.evaluate(() => window.tapoStudio.diagnostics.getRuntimeInfo());
    await expect
      .poll(async () => {
        if (!runtimeInfo.logPath) return '';
        try {
          return await fs.readFile(runtimeInfo.logPath, 'utf8');
        } catch {
          return '';
        }
      })
      .toContain('=== TapoStudio Started ===');

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
    await expect(window.getByTestId('preview-strip').getByRole('button', { name: /Front Door/i })).toBeVisible();

    const persisted = JSON.parse(
      await fs.readFile(path.join(userDataDir, 'cameras.json'), 'utf8'),
    ) as { cameras?: Array<{ name: string }> };
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

    const track = window.locator('.timeline-track');
    const box = await track.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    await window.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);

    await expect(window.locator('.viewer-badge')).toHaveText('Playback');
  } finally {
    await app.close();
  }
});