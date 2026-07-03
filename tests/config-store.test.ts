import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as configStore from '../electron/config/store';

const DEFAULTS = {
  previews: true,
  timeline: true,
  header: false,
  previewPosition: 'right' as const,
  language: 'system',
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

    configStore.setUiDisplayPreferences({ previewPosition: 'left', header: true });

    expect(configStore.getUiDisplayPreferences()).toEqual({
      ...DEFAULTS,
      previewPosition: 'left',
      header: true,
    });

    // Re-init the SAME dir to verify save + parse-merge round-trip.
    configStore.init(dir);
    expect(configStore.getUiDisplayPreferences()).toEqual({
      ...DEFAULTS,
      previewPosition: 'left',
      header: true,
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
    prefs.language = 'xx';
    prefs.previews = !prefs.previews;

    expect(configStore.getUiDisplayPreferences()).toEqual(before);
  });

  it('writes atomically and keeps a backup of the previous config', () => {
    const dir = makeTmpDir();
    const cfgPath = path.join(dir, 'cameras.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ cameras: [], uiDisplay: { previews: false } }), 'utf8');

    configStore.init(dir);
    configStore.setUiDisplayPreferences({ previews: true });

    // No temp file is left behind after a successful save.
    expect(fs.existsSync(`${cfgPath}.tmp`)).toBe(false);
    // The backup holds the previous good config, the primary holds the new value.
    expect(JSON.parse(fs.readFileSync(`${cfgPath}.bak`, 'utf8')).uiDisplay.previews).toBe(false);
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).uiDisplay.previews).toBe(true);
  });

  it('recovers from the backup when the primary config is corrupt', () => {
    const dir = makeTmpDir();
    const cfgPath = path.join(dir, 'cameras.json');
    fs.writeFileSync(cfgPath, '{ this is not valid json', 'utf8');
    fs.writeFileSync(
      `${cfgPath}.bak`,
      JSON.stringify({ cameras: [], uiDisplay: { previewPosition: 'left' } }),
      'utf8',
    );

    configStore.init(dir);

    expect(configStore.getUiDisplayPreferences()).toEqual({ ...DEFAULTS, previewPosition: 'left' });
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

    // The legacy global volume is seeded onto the migrated camera.
    expect(configStore.getCameras()).toEqual([{ ...camera, volume: 0.42 }]);
    expect(configStore.getUiDisplayPreferences()).toEqual({
      ...DEFAULTS,
      previews: false,
    });
    // The migrated file now lives in the new location.
    expect(fs.existsSync(path.join(userDataDir, 'cameras.json'))).toBe(true);
  });

  it('seeds cameras with the legacy global uiDisplay.volume only when they have none', () => {
    const dir = makeTmpDir();
    const base = { name: 'Cam', host: '192.168.1.50', username: 'admin', password: 'secret' };
    fs.writeFileSync(
      path.join(dir, 'cameras.json'),
      JSON.stringify({
        cameras: [
          { ...base, id: 'cam-legacy' },
          { ...base, id: 'cam-own-volume', volume: 0.8 },
        ],
        uiDisplay: { volume: 0.42 },
      }),
      'utf8',
    );

    configStore.init(dir);

    expect(configStore.getCameras()).toEqual([
      { ...base, id: 'cam-legacy', volume: 0.42 },
      { ...base, id: 'cam-own-volume', volume: 0.8 },
    ]);
  });

  it('returns default mainLayout when the field is absent in a legacy config', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, 'cameras.json'),
      JSON.stringify({ cameras: [], uiDisplay: { previews: false } }),
      'utf8',
    );

    configStore.init(dir);

    expect(configStore.getMainLayout()).toEqual({ tiles: [], focusedTileId: null });
  });

  it('round-trips mainLayout through save and re-init', () => {
    const dir = makeTmpDir();
    configStore.init(dir);

    const layout = {
      tiles: [{ id: 'tile-1', cameraId: 'cam-1', x: 0.1, y: 0.1, w: 0.8, h: 0.8, z: 0, locked: false }],
      focusedTileId: 'tile-1',
    };
    configStore.setMainLayout(layout);

    configStore.init(dir);

    expect(configStore.getMainLayout()).toEqual(layout);
  });

  it('falls back to defaults when the config is corrupt and no backup exists', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'cameras.json'), 'not json at all', 'utf8');

    configStore.init(dir);

    expect(configStore.getUiDisplayPreferences()).toEqual(DEFAULTS);
    expect(configStore.getCameras()).toEqual([]);
  });
});
