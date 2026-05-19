/// <reference types="vite/client" />

import type { CameraConfig, PreviewPosition, Recording, RuntimeInfo } from './types';

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
        start(cameraId: string): Promise<string | null>;
        stop(cameraId: string): Promise<void>;
        startPlayback(cameraId: string, seekSeconds: number): Promise<string>;
      };
      snapshot: {
        get(cameraId: string): Promise<string | null>;
      };
      recordings: {
        list(cameraId: string, date: string): Promise<Recording[]>;
        play(
          cameraId: string,
          startTime: number,
          endTime: number,
          requestedTime: number,
          clipStartTime?: number,
        ): Promise<string>;
      };
      diagnostics: {
        getRuntimeInfo(): Promise<RuntimeInfo>;
      };
      contextMenu: {
        showCameraMenu(): Promise<string | null>;
      };
      ui: {
        onOpenAddCamera(callback: () => void): () => void;
        onSetPreviewsVisible(callback: (visible: boolean) => void): () => void;
        onSetTimelineVisible(callback: (visible: boolean) => void): () => void;
        onSetHeaderVisible(callback: (visible: boolean) => void): () => void;
        onSetPreviewPosition(callback: (position: PreviewPosition) => void): () => void;
        onStreamsInvalidated(callback: () => void): () => void;
        onSetLanguage(callback: (language: string) => void): () => void;
      };
    };
  }
}

export {};
