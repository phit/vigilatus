export type {
  CameraConfig,
  LayoutTile,
  MainLayout,
  Recording,
  RecordingEvent,
  PreviewPosition,
  RuntimeInfo,
  StreamQuality,
} from '../electron/types';
import type { CameraConfig, StreamQuality } from '../electron/types';

export type CameraStatus = 'idle' | 'connecting' | 'live' | 'error' | 'offline';

export interface CameraState {
  config: CameraConfig;
  status: CameraStatus;
  hlsUrl?: string;
  snapshotDataUrl?: string;
  errorMessage?: string;
  retryAt?: number;
  /** Stream the current/last live start used (see src/streamQuality.ts). */
  streamQuality?: StreamQuality;
}

export type PlaybackMode = 'live' | 'playback';
