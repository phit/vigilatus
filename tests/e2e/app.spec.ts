import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launchElectronApp } from './helpers/launchElectronApp';

test('launches the real app and creates a camera through the UI', async () => {
  const { app, window, userDataDir } = await launchElectronApp({ fixtures: { streams: {}, snapshots: {} } });

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
    snapshots: {},
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
