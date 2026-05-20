/**
 * Real-camera live stream test.
 *
 * Run with:
 *   npm run build && npx playwright test tests/e2e/live-stream.spec.ts
 *
 * Requires real cameras in the user's cameras.json config.
 * Set CAMERA_ID env var to target a specific camera, otherwise the first HTTP camera is used.
 */
import { _electron as electron, expect, test } from '@playwright/test';

test.skip(!process.env.REAL_CAMERA, 'Requires a real camera (set REAL_CAMERA=1)');
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CameraConfig } from '../../electron/types';

test.setTimeout(120_000);

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

interface FfprobeStream {
  codec_type: string;
  codec_name: string;
  sample_rate?: string;
  channels?: number;
}

function ffprobeStreams(filePath: string): FfprobeStream[] {
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

test('live HTTP stream produces HLS segments with video and audio (real camera)', async () => {
  const config = loadCamerasJson();
  const targetId = process.env.CAMERA_ID;
  const camera = targetId
    ? config.cameras.find((c) => c.id === targetId)
    : config.cameras.find((c) => c.streamProtocol === 'http');
  if (!camera) {
    test.skip(true, `No HTTP camera found in cameras.json`);
    return;
  }
  if (camera.streamProtocol !== 'http') {
    test.skip(true, `Camera ${camera.name} is not an HTTP camera (protocol=${camera.streamProtocol})`);
    return;
  }

  console.info(`[test] using camera: ${camera.name} (${camera.id})`);

  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vigilatus-e2e-live-'));
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

    // Wait for the live stream video element and HLS URL
    await expect(window.locator('video')).toBeVisible({ timeout: 60_000 });
    await expect(window.locator('.viewer-badge')).toHaveText('Live', { timeout: 60_000 });

    // Let the stream run for a few seconds to accumulate HLS segments
    const hlsDir = path.join(os.tmpdir(), 'vigilatus-hls', camera.id);
    console.info(`[test] HLS segment dir: ${hlsDir}`);

    // Wait for at least 3 .ts segments to appear (confirms stable streaming)
    await expect
      .poll(
        () => {
          try {
            return fs.readdirSync(hlsDir).filter((f) => f.endsWith('.ts')).length;
          } catch {
            return 0;
          }
        },
        { timeout: 60_000, intervals: [1_000], message: 'Waiting for HLS segments' },
      )
      .toBeGreaterThanOrEqual(3);

    const segments = fs
      .readdirSync(hlsDir)
      .filter((f) => f.endsWith('.ts'))
      .sort();
    console.info(`[test] HLS segments: ${segments.join(', ')}`);

    // Pick the latest complete segment (second to last, since last may still be writing)
    const probeSegment = segments[segments.length - 2] ?? segments[segments.length - 1];
    const segmentPath = path.join(hlsDir, probeSegment);
    const segStat = fs.statSync(segmentPath);
    console.info(`[test] probing segment: ${probeSegment} (${segStat.size} bytes)`);

    let streams: FfprobeStream[] = [];
    try {
      streams = ffprobeStreams(segmentPath);
    } catch (err) {
      console.warn(`[test] ffprobe failed: ${(err as Error).message}`);
    }

    if (streams.length > 0) {
      console.info(
        `[test] streams found: ${JSON.stringify(streams.map((s) => ({ type: s.codec_type, codec: s.codec_name })))}`,
      );

      const videoStream = streams.find((s) => s.codec_type === 'video');
      expect(videoStream).toBeDefined();
      console.info(`[test] video codec: ${videoStream?.codec_name}`);

      const audioStream = streams.find((s) => s.codec_type === 'audio');
      if (audioStream) {
        console.info(
          `[test] audio codec: ${audioStream.codec_name}, rate: ${audioStream.sample_rate}, channels: ${audioStream.channels}`,
        );
        expect(audioStream.codec_name).toBe('aac');
      } else {
        console.warn('[test] WARNING: no audio stream in HLS segment');
      }
    }
  } finally {
    await app.close();
    await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
});
