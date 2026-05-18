export interface CameraConfig {
  id: string;
  name: string;
  host: string;
  /** API auth username (default: admin) */
  username: string;
  /** API auth password (TP-Link / device password) */
  password: string;
  /** RTSP stream username — set via Camera Account in Tapo app */
  streamUser: string;
  /** RTSP stream password — set via Camera Account in Tapo app */
  streamPassword: string;
  /** Optional external RTSP source, e.g. an RTSP proxy that fans out the camera stream */
  rtspUrl?: string;
  /** Optional basic auth username for the external RTSP source */
  rtspUsername?: string;
  /** Optional basic auth password for the external RTSP source */
  rtspPassword?: string;
  model?: string;
}

export type CameraStatus = 'idle' | 'connecting' | 'live' | 'error' | 'offline';

export interface CameraState {
  config: CameraConfig;
  status: CameraStatus;
  hlsUrl?: string;
  snapshotDataUrl?: string;
  errorMessage?: string;
}

export interface Recording {
  /** Unix ms */
  startTime: number;
  /** Unix ms */
  endTime: number;
}

export type PlaybackMode = 'live' | 'playback';

export type PreviewPosition = 'left' | 'right' | 'top' | 'bottom';
