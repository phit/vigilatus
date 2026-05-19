import fs from 'node:fs';
import path from 'node:path';
import type { CameraConfig } from '../types';

type PreviewPosition = 'left' | 'right' | 'top' | 'bottom';

interface Config {
  cameras: CameraConfig[];
  uiDisplay: {
    previews: boolean;
    timeline: boolean;
    header: boolean;
    previewPosition: PreviewPosition;
  };
}

let configPath = '';
let config: Config = {
  cameras: [],
  uiDisplay: {
    previews: true,
    timeline: true,
    header: true,
    previewPosition: 'right',
  },
};

export function init(userDataPath: string): void {
  configPath = path.join(userDataPath, 'cameras.json');
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
        },
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

export function getUiDisplayPreferences(): { previews: boolean; timeline: boolean; header: boolean; previewPosition: PreviewPosition } {
  return { ...config.uiDisplay };
}

export function setUiDisplayPreferences(
  preferences: Partial<{ previews: boolean; timeline: boolean; header: boolean; previewPosition: PreviewPosition }>,
): void {
  config.uiDisplay = {
    previews: preferences.previews ?? config.uiDisplay.previews,
    timeline: preferences.timeline ?? config.uiDisplay.timeline,
    header: preferences.header ?? config.uiDisplay.header,
    previewPosition: preferences.previewPosition ?? config.uiDisplay.previewPosition,
  };
  save();
}

function save(): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}
