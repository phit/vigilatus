export type {
  CameraConfig,
  Recording,
  RecordingEvent,
  PreviewPosition,
  RuntimeInfo,
} from '../electron/types';
import type { CameraConfig } from '../electron/types';

export type CameraStatus = 'idle' | 'connecting' | 'live' | 'error' | 'offline';

export interface CameraState {
  config: CameraConfig;
  status: CameraStatus;
  hlsUrl?: string;
  snapshotDataUrl?: string;
  errorMessage?: string;
}

export type PlaybackMode = 'live' | 'playback';
