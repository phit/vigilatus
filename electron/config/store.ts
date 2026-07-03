import fs from 'node:fs';
import path from 'node:path';
import type { CameraConfig, MainLayout, PreviewPosition } from '../types';
import { createLogger } from '../log';

const log = createLogger('config');

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

interface UiDisplay {
  previews: boolean;
  timeline: boolean;
  header: boolean;
  previewPosition: PreviewPosition;
  language: string;
}

interface Config {
  cameras: CameraConfig[];
  uiDisplay: UiDisplay;
  windowState: WindowState;
  mainLayout: MainLayout;
}

const DEFAULT_MAIN_LAYOUT: MainLayout = {
  tiles: [],
  focusedTileId: null,
};

const DEFAULT_UI_DISPLAY: UiDisplay = {
  previews: true,
  timeline: true,
  header: false,
  previewPosition: 'right',
  language: 'system',
};

const defaultWindowState: WindowState = {
  width: 1680,
  height: 1024,
  isMaximized: false,
};

let configPath = '';

function createDefaultConfig(): Config {
  return {
    cameras: [],
    uiDisplay: { ...DEFAULT_UI_DISPLAY },
    windowState: { ...defaultWindowState },
    mainLayout: { ...DEFAULT_MAIN_LAYOUT, tiles: [] },
  };
}

/** Merge a parsed (possibly partial / legacy) config against the current defaults. */
function mergeConfig(parsed: Partial<Config>): Config {
  // Volume used to be a single global uiDisplay preference; seed cameras that
  // predate per-camera volume with it so users keep their configured level.
  const legacyVolume = (parsed.uiDisplay as { volume?: number } | undefined)?.volume;
  return {
    cameras: (parsed.cameras ?? []).map((c) =>
      c.volume === undefined && legacyVolume !== undefined ? { ...c, volume: legacyVolume } : c,
    ),
    uiDisplay: {
      previews: parsed.uiDisplay?.previews ?? DEFAULT_UI_DISPLAY.previews,
      timeline: parsed.uiDisplay?.timeline ?? DEFAULT_UI_DISPLAY.timeline,
      header: parsed.uiDisplay?.header ?? DEFAULT_UI_DISPLAY.header,
      previewPosition: parsed.uiDisplay?.previewPosition ?? DEFAULT_UI_DISPLAY.previewPosition,
      language: parsed.uiDisplay?.language ?? DEFAULT_UI_DISPLAY.language,
    },
    windowState: {
      x: parsed.windowState?.x,
      y: parsed.windowState?.y,
      width: parsed.windowState?.width ?? defaultWindowState.width,
      height: parsed.windowState?.height ?? defaultWindowState.height,
      isMaximized: parsed.windowState?.isMaximized ?? defaultWindowState.isMaximized,
    },
    mainLayout: {
      tiles: parsed.mainLayout?.tiles ?? DEFAULT_MAIN_LAYOUT.tiles,
      focusedTileId: parsed.mainLayout?.focusedTileId ?? DEFAULT_MAIN_LAYOUT.focusedTileId,
    },
  };
}

/** Read and merge a config file; returns null when it is missing or corrupt. */
function loadConfigFile(filePath: string): Config | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<Config>;
    return mergeConfig(parsed);
  } catch {
    return null;
  }
}

let config: Config = createDefaultConfig();

export function init(userDataPath: string): void {
  configPath = path.join(userDataPath, 'cameras.json');

  // TODO: Remove this migration after a few releases (added 2026-05-19).
  // Copy config from the old "TapoStudio" user-data folder if the new one doesn't exist yet.
  if (!fs.existsSync(configPath)) {
    const oldPath = path.join(path.dirname(userDataPath), 'TapoStudio', 'cameras.json');
    if (fs.existsSync(oldPath)) {
      try {
        fs.mkdirSync(userDataPath, { recursive: true });
        fs.copyFileSync(oldPath, configPath);
        log.info('Migrated config from TapoStudio →', configPath);
      } catch (err) {
        log.warn('Failed to migrate old config:', err);
      }
    }
  }

  if (fs.existsSync(configPath)) {
    const loaded = loadConfigFile(configPath);
    if (loaded) {
      config = loaded;
      return;
    }

    // Primary config is corrupt/unreadable — try the last-good backup before
    // discarding the user's cameras and preferences.
    log.error('Config file is corrupt or unreadable:', configPath);
    const backupPath = `${configPath}.bak`;
    const recovered = fs.existsSync(backupPath) ? loadConfigFile(backupPath) : null;
    if (recovered) {
      log.warn('Recovered configuration from backup:', backupPath);
      config = recovered;
    } else {
      log.error('No usable backup found; falling back to default configuration');
      config = createDefaultConfig();
    }
  }
}

export function getCameras(): CameraConfig[] {
  return config.cameras;
}

export function addCamera(cam: CameraConfig): void {
  config.cameras.push(cam);
  save();
}

export function updateCamera(id: string, updates: Partial<CameraConfig>): void {
  const idx = config.cameras.findIndex((c) => c.id === id);
  if (idx !== -1) {
    config.cameras[idx] = { ...config.cameras[idx], ...updates };
    save();
  }
}

export function removeCamera(id: string): void {
  config.cameras = config.cameras.filter((c) => c.id !== id);
  save();
}

export function moveCamera(id: string, direction: 'up' | 'down'): void {
  const idx = config.cameras.findIndex((c) => c.id === id);
  if (idx === -1) return;
  const swap = direction === 'up' ? idx - 1 : idx + 1;
  if (swap < 0 || swap >= config.cameras.length) return;
  [config.cameras[idx], config.cameras[swap]] = [config.cameras[swap], config.cameras[idx]];
  save();
}

export function getUiDisplayPreferences(): UiDisplay {
  return { ...config.uiDisplay };
}

export function setUiDisplayPreferences(preferences: Partial<UiDisplay>): void {
  config.uiDisplay = {
    previews: preferences.previews ?? config.uiDisplay.previews,
    timeline: preferences.timeline ?? config.uiDisplay.timeline,
    header: preferences.header ?? config.uiDisplay.header,
    previewPosition: preferences.previewPosition ?? config.uiDisplay.previewPosition,
    language: preferences.language ?? config.uiDisplay.language,
  };
  save();
}

export function getWindowState(): WindowState {
  return { ...config.windowState };
}

export function setWindowState(windowState: WindowState): void {
  config.windowState = { ...windowState };
  save();
}

export function getMainLayout(): MainLayout {
  return { ...config.mainLayout, tiles: [...config.mainLayout.tiles] };
}

export function setMainLayout(layout: MainLayout): void {
  config.mainLayout = { tiles: [...layout.tiles], focusedTileId: layout.focusedTileId };
  save();
}

function save(): void {
  try {
    const serialized = JSON.stringify(config, null, 2);
    // Write to a temp file and rename over the target so an interrupted write
    // (crash, power loss, full disk) can never leave a half-written config.
    const tempPath = `${configPath}.tmp`;
    fs.writeFileSync(tempPath, serialized, 'utf8');
    // Preserve the previous good config as a backup before replacing it.
    if (fs.existsSync(configPath)) {
      try {
        fs.copyFileSync(configPath, `${configPath}.bak`);
      } catch (err) {
        log.warn('Failed to back up config before save:', err);
      }
    }
    fs.renameSync(tempPath, configPath);
  } catch (err) {
    log.error('Failed to persist config:', err);
  }
}
