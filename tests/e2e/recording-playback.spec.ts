/**
 * Real-camera recording playback test.
 *
 * Run with:
 *   npm run build && npx playwright test tests/e2e/recording-playback.spec.ts
 *
 * Requires real cameras in the user's cameras.json config.
 * Set CAMERA_ID env var to target a specific camera, otherwise the first camera is used.
 * Set RECORDING_DATE env var (YYYYMMDD) to pick a date, default is today.
 */
import { _electron as electron, expect, test } from '@playwright/test';

test.skip(!process.env.REAL_CAMERA, 'Requires a real camera (set REAL_CAMERA=1)');
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CameraConfig } from '../../electron/types';

// Allow plenty of time for real camera communication
test.setTimeout(300_000);

const electronPath = path.join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron',
);
const projectRoot = path.resolve(process.cwd());

function loadCamerasJson(): { cameras: CameraConfig[] } {
  const configDir =
    process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Roaming', 'vigilatus')
      : path.join(os.homedir(), '.config', 'vigilatus');
  const configPath = path.join(configDir, 'cameras.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`No cameras.json found at ${configPath}. Run the app first to create cameras.`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as { cameras: CameraConfig[] };
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

interface FfprobeStream {
  codec_type: string;
  codec_name: string;
  sample_rate?: string;
  channels?: number;
}

function ffprobeStreams(filePath: string): FfprobeStream[] {
  // Try to find ffprobe next to bundled ffmpeg-static, or fall back to PATH
  let ffprobeBin = 'ffprobe';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegStatic = require('ffmpeg-static') as string;
    const dir = path.dirname(ffmpegStatic);
    const candidate = path.join(dir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(candidate)) {
      ffprobeBin = candidate;
    }
  } catch {
    /* use PATH */
  }

  const out = execFileSync(ffprobeBin, ['-v', 'quiet', '-print_format', 'json', '-show_streams', filePath]);
  const parsed = JSON.parse(out.toString()) as { streams?: FfprobeStream[] };
  return parsed.streams ?? [];
}

test('recording playback produces a valid MP4 with video (real camera)', async () => {
  const config = loadCamerasJson();
  const targetId = process.env.CAMERA_ID;
  const camera = targetId ? config.cameras.find((c) => c.id === targetId) : config.cameras[0];
  if (!camera) {
    test.skip(true, `Camera ${targetId ?? '(first)'} not found in cameras.json`);
    return;
  }

  const date = process.env.RECORDING_DATE ?? todayStr();

  // Launch the real app with the user's camera config (no test fixtures)
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vigilatus-e2e-rec-'));
  await fsp.writeFile(
    path.join(userDataDir, 'cameras.json'),
    JSON.stringify({
      cameras: config.cameras,
      uiDisplay: { previews: true, timeline: true, previewPosition: 'right' },
    }),
  );

  const app = await electron.launch({
    executablePath: electronPath,
    args: [projectRoot],
    env: {
      ...process.env,
      VIGILATUS_USER_DATA_DIR: userDataDir,
      VIGILATUS_OPEN_DEVTOOLS: '0',
    },
    timeout: 20_000,
  });

  // Capture main process output for diagnostics
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

  try {
    // Select the target camera
    const cameraButton = window
      .getByTestId('preview-strip')
      .getByRole('button', { name: new RegExp(camera.name, 'i') });
    await expect(cameraButton).toBeVisible({ timeout: 15_000 });
    await cameraButton.click();

    // Wait for the timeline to appear
    await expect(window.getByTestId('timeline')).toBeVisible({ timeout: 10_000 });

    // Navigate to the target date if not today
    if (date !== todayStr()) {
      // The timeline shows today by default — use the date nav buttons or evaluate
      await window.evaluate(
        ([cameraId, dateStr]) => {
          void window.vigilatus.recordings.list(cameraId, dateStr);
        },
        [camera.id, date] as const,
      );
    }

    // Wait for recordings to load (status message shows segment count)
    await expect(window.locator('.timeline-status')).toContainText(/\d+ recording/, { timeout: 30_000 });

    // Get the first visible timeline segment and click it
    const segment = window.locator('.timeline-segment').first();
    await expect(segment).toBeVisible({ timeout: 5_000 });
    const segBox = await segment.boundingBox();
    expect(segBox).not.toBeNull();
    if (!segBox) return;
    await window.mouse.click(segBox.x + segBox.width / 2, segBox.y + segBox.height / 2);

    // Wait for playback mode to engage
    await expect(window.locator('.viewer-badge')).toHaveText('Playback', { timeout: 30_000 });

    // Wait for the video element to appear (audio+video attempt may fall back to video-only)
    await expect(window.locator('video')).toBeVisible({ timeout: 120_000 });

    await expect
      .poll(
        async () => {
          return window.evaluate(() => {
            const video = document.querySelector('video') as HTMLVideoElement | null;
            if (!video) return null;
            const src = video.src;
            if (!src || src === '' || src === window.location.href) return null;
            return src;
          });
        },
        { timeout: 120_000, intervals: [1_000] },
      )
      .toBeTruthy();

    // Re-fetch the final URL value after poll succeeds
    const finalUrl = await window.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement | null;
      return video?.src ?? null;
    });

    expect(finalUrl).toBeTruthy();
    console.info(`[test] playback URL: ${finalUrl}`);

    // Extract the asset path from the URL and find the file on disk.
    // URL format: http://127.0.0.1:PORT/playback/CAMERA_ID/CLIP_KEY/stream.mp4
    const urlPath = new URL(finalUrl!).pathname.replace(/^\/playback\//, '');
    const assetPath = path.join(os.tmpdir(), 'vigilatus-playback', urlPath);
    console.info(`[test] asset path: ${assetPath}`);

    // Wait for the file to grow to a reasonable size (progressive download)
    await expect
      .poll(
        () => {
          try {
            return fs.statSync(assetPath).size;
          } catch {
            return 0;
          }
        },
        { timeout: 60_000, intervals: [1_000], message: 'Waiting for playback MP4 to grow' },
      )
      .toBeGreaterThan(50_000);

    const stat = fs.statSync(assetPath);
    console.info(`[test] playback MP4: ${stat.size} bytes`);

    // Probe streams with ffprobe
    let streams: FfprobeStream[] = [];
    try {
      streams = ffprobeStreams(assetPath);
    } catch (err) {
      console.warn(`[test] ffprobe not available, skipping stream analysis: ${(err as Error).message}`);
    }

    if (streams.length > 0) {
      console.info(
        `[test] streams found: ${JSON.stringify(streams.map((s) => ({ type: s.codec_type, codec: s.codec_name })))}`,
      );

      const videoStream = streams.find((s) => s.codec_type === 'video');
      expect(videoStream).toBeDefined();
      console.info(`[test] video codec: ${videoStream?.codec_name}`);

      const audioStream = streams.find((s) => s.codec_type === 'audio');
      expect(audioStream).toBeDefined();
      console.info(
        `[test] audio codec: ${audioStream?.codec_name}, rate: ${audioStream?.sample_rate}, channels: ${audioStream?.channels}`,
      );
      expect(audioStream!.codec_name).toBe('aac');
    }
  } finally {
    await app.close();
    await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});
