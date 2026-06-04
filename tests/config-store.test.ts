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

/** A controllable parent dir registered for cleanup, used to exercise dirname-based migration. */
function makeTmpParentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilatus-cfg-parent-'));
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

  it('writes atomically and keeps a backup of the previous config', () => {
    const dir = makeTmpDir();
    const cfgPath = path.join(dir, 'cameras.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ cameras: [], uiDisplay: { volume: 0.1 } }), 'utf8');

    configStore.init(dir);
    configStore.setUiDisplayPreferences({ volume: 0.9 });

    // No temp file is left behind after a successful save.
    expect(fs.existsSync(`${cfgPath}.tmp`)).toBe(false);
    // The backup holds the previous good config, the primary holds the new value.
    expect(JSON.parse(fs.readFileSync(`${cfgPath}.bak`, 'utf8')).uiDisplay.volume).toBe(0.1);
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).uiDisplay.volume).toBe(0.9);
  });

  it('recovers from the backup when the primary config is corrupt', () => {
    const dir = makeTmpDir();
    const cfgPath = path.join(dir, 'cameras.json');
    fs.writeFileSync(cfgPath, '{ this is not valid json', 'utf8');
    fs.writeFileSync(`${cfgPath}.bak`, JSON.stringify({ cameras: [], uiDisplay: { volume: 0.7 } }), 'utf8');

    configStore.init(dir);

    expect(configStore.getUiDisplayPreferences()).toEqual({ ...DEFAULTS, volume: 0.7 });
  });

  it('migrates a config from the legacy TapoStudio folder when no new config exists', () => {
    // Control the parent dir so dirname(userData) resolves to a folder we own.
    const parent = makeTmpParentDir();
    const legacyDir = path.join(parent, 'TapoStudio');
    fs.mkdirSync(legacyDir, { recursive: true });

    const camera = {
      id: 'cam-legacy',
      name: 'Legacy Cam',
      host: '192.168.1.50',
      username: 'admin',
      password: 'secret',
    };
    fs.writeFileSync(
      path.join(legacyDir, 'cameras.json'),
      JSON.stringify({ cameras: [camera], uiDisplay: { previews: false, volume: 0.42 } }),
      'utf8',
    );

    // Fresh userData subdir under the same parent with NO cameras.json yet.
    const userDataDir = path.join(parent, 'Vigilatus');

    configStore.init(userDataDir);

    expect(configStore.getCameras()).toEqual([camera]);
    expect(configStore.getUiDisplayPreferences()).toEqual({
      ...DEFAULTS,
      previews: false,
      volume: 0.42,
    });
    // The migrated file now lives in the new location.
    expect(fs.existsSync(path.join(userDataDir, 'cameras.json'))).toBe(true);
  });

  it('falls back to defaults when the config is corrupt and no backup exists', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'cameras.json'), 'not json at all', 'utf8');

    configStore.init(dir);

    expect(configStore.getUiDisplayPreferences()).toEqual(DEFAULTS);
    expect(configStore.getCameras()).toEqual([]);
  });
});
