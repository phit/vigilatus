import fs from 'node:fs';
import path from 'node:path';
import type { CameraConfig, Recording, RecordingEvent } from '../types';

export interface TestFixtures {
  cameras?: CameraConfig[];
  streams?: Record<string, string | null>;
  snapshots?: Record<string, string | null>;
  recordings?: Record<string, Recording[]>;
  recordingEvents?: Record<string, RecordingEvent[]>;
  playbackUrls?: Record<string, string>;
}

export function loadTestFixtures(): TestFixtures | null {
  const fixtureFile = process.env.VIGILATUS_TEST_FIXTURES?.trim();
  if (!fixtureFile) return null;

  const resolvedPath = path.resolve(fixtureFile);
  if (!fs.existsSync(resolvedPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as TestFixtures;
  } catch {
    return null;
  }
}
