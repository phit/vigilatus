/// <reference types="vite/client" />

import type { CameraConfig, Recording } from './types';

declare global {
  interface Window {
    tapoStudio: {
      cameras: {
        getAll(): Promise<CameraConfig[]>;
        add(cfg: CameraConfig): Promise<void>;
        update(id: string, updates: Partial<CameraConfig>): Promise<void>;
        remove(id: string): Promise<void>;
        test(
          cfg: Pick<CameraConfig, 'host' | 'username' | 'password'>,
        ): Promise<{ success: boolean; error?: string }>;
      };
      stream: {
        start(cameraId: string): Promise<string>;
        stop(cameraId: string): Promise<void>;
        startPlayback(cameraId: string, seekSeconds: number): Promise<string>;
      };
      snapshot: {
        get(cameraId: string): Promise<string | null>;
      };
      recordings: {
        list(cameraId: string, date: string): Promise<Recording[]>;
        play(cameraId: string, startTime: number, endTime: number): Promise<string>;
      };
    };
  }
}

export {};
