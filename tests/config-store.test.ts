import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as configStore from '../electron/config/store';

const DEFAULTS = {
  previews: true,
  timeline: true,
  header: true,
  previewPosition: 'right' as const,
  language: 'system',
  volume: 0,
};

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilatus-cfg-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
});

describe('config store', () => {
  it('returns defaults after init on an empty dir', () => {
    const dir = makeTmpDir();
    configStore.init(dir);

    expect(configStore.getUiDisplayPreferences()).toEqual(DEFAULTS);
    expect(configStore.getCameras()).toEqual([]);
  });

  it('merges set preferences per-field and persists across re-init', () => {
    const dir = makeTmpDir();
    configStore.init(dir);

    configStore.setUiDisplayPreferences({ volume: 0.5, header: false });

    expect(configStore.getUiDisplayPreferences()).toEqual({
      ...DEFAULTS,
      volume: 0.5,
      header: false,
    });

    // Re-init the SAME dir to verify save + parse-merge round-trip.
    configStore.init(dir);
    expect(configStore.getUiDisplayPreferences()).toEqual({
      ...DEFAULTS,
      volume: 0.5,
      header: false,
    });
  });

  it('falls back to defaults for missing fields in a legacy config file', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, 'cameras.json'),
      JSON.stringify({ cameras: [], uiDisplay: { previews: false } }),
      'utf8',
    );

    configStore.init(dir);

    expect(configStore.getUiDisplayPreferences()).toEqual({
      ...DEFAULTS,
      previews: false,
    });
  });

  it('returns a copy that does not affect stored state when mutated', () => {
    const dir = makeTmpDir();
    configStore.init(dir);

    const before = configStore.getUiDisplayPreferences();
    const prefs = configStore.getUiDisplayPreferences();
    prefs.volume = 99;
    prefs.previews = !prefs.previews;

    expect(configStore.getUiDisplayPreferences()).toEqual(before);
  });
});
