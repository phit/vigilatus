import fs from 'node:fs';
import path from 'node:path';
import type { CameraConfig } from '../types';

type PreviewPosition = 'left' | 'right' | 'top' | 'bottom';

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

interface Config {
  cameras: CameraConfig[];
  uiDisplay: {
    previews: boolean;
    timeline: boolean;
    header: boolean;
    previewPosition: PreviewPosition;
    language: string;
    volume: number;
  };
  windowState: WindowState;
}

const defaultWindowState: WindowState = {
  width: 1680,
  height: 1024,
  isMaximized: false,
};

let configPath = '';
let config: Config = {
  cameras: [],
  uiDisplay: {
    previews: true,
    timeline: true,
    header: true,
    previewPosition: 'right',
    language: 'system',
    volume: 0,
  },
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
        console.info('[config] Migrated config from TapoStudio →', configPath);
      } catch (err) {
        console.warn('[config] Failed to migrate old config:', err);
      }
    }
  }

  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<Config>;
      config = {
        cameras: parsed.cameras ?? [],
        uiDisplay: {
          previews: parsed.uiDisplay?.previews ?? true,
          timeline: parsed.uiDisplay?.timeline ?? true,
          header: parsed.uiDisplay?.header ?? true,
          previewPosition: parsed.uiDisplay?.previewPosition ?? 'right',
          language: parsed.uiDisplay?.language ?? 'system',
          volume: parsed.uiDisplay?.volume ?? 0,
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
        uiDisplay: {
          previews: true,
          timeline: true,
          header: true,
          previewPosition: 'right',
          language: 'system',
          volume: 0,
        },
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

export function getUiDisplayPreferences(): {
  previews: boolean;
  timeline: boolean;
  header: boolean;
  previewPosition: PreviewPosition;
  language: string;
  volume: number;
} {
  return { ...config.uiDisplay };
}

export function setUiDisplayPreferences(
  preferences: Partial<{
    previews: boolean;
    timeline: boolean;
    header: boolean;
    previewPosition: PreviewPosition;
    language: string;
    volume: number;
  }>,
): void {
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
