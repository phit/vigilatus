import fs from 'node:fs';
import path from 'node:path';
import type { CameraConfig } from '../types';

interface Config {
  cameras: CameraConfig[];
}

let configPath = '';
let config: Config = { cameras: [] };

export function init(userDataPath: string): void {
  configPath = path.join(userDataPath, 'cameras.json');
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Config;
    } catch {
      config = { cameras: [] };
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

function save(): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}
