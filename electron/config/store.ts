import fs from 'node:fs';
import path from 'node:path';
import type { CameraConfig, PreviewPosition } from '../types';
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
  volume: number;
}

interface Config {
  cameras: CameraConfig[];
  uiDisplay: UiDisplay;
  windowState: WindowState;
}

const DEFAULT_UI_DISPLAY: UiDisplay = {
  previews: true,
  timeline: true,
  header: true,
  previewPosition: 'right',
  language: 'system',
  volume: 0,
};

const defaultWindowState: WindowState = {
  width: 1680,
  height: 1024,
  isMaximized: false,
};

let configPath = '';
let config: Config = {
  cameras: [],
  uiDisplay: { ...DEFAULT_UI_DISPLAY },
  windowState: defaultWindowState,
};

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
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<Config>;
      config = {
        cameras: parsed.cameras ?? [],
        uiDisplay: {
          previews: parsed.uiDisplay?.previews ?? DEFAULT_UI_DISPLAY.previews,
          timeline: parsed.uiDisplay?.timeline ?? DEFAULT_UI_DISPLAY.timeline,
          header: parsed.uiDisplay?.header ?? DEFAULT_UI_DISPLAY.header,
          previewPosition: parsed.uiDisplay?.previewPosition ?? DEFAULT_UI_DISPLAY.previewPosition,
          language: parsed.uiDisplay?.language ?? DEFAULT_UI_DISPLAY.language,
          volume: parsed.uiDisplay?.volume ?? DEFAULT_UI_DISPLAY.volume,
        },
        windowState: {
          x: parsed.windowState?.x,
          y: parsed.windowState?.y,
          width: parsed.windowState?.width ?? defaultWindowState.width,
          height: parsed.windowState?.height ?? defaultWindowState.height,
          isMaximized: parsed.windowState?.isMaximized ?? defaultWindowState.isMaximized,
        },
      };
    } catch {
      config = {
        cameras: [],
        uiDisplay: { ...DEFAULT_UI_DISPLAY },
        windowState: defaultWindowState,
      };
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
    volume: preferences.volume ?? config.uiDisplay.volume,
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

function save(): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}
