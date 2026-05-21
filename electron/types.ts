/** Types shared between electron main-process modules */

export interface CameraConfig {
  id: string;
  name: string;
  host: string;
  username: string;
  password: string;
  streamUser: string;
  streamPassword: string;
  rtspUrl?: string;
  rtspUsername?: string;
  rtspPassword?: string;
  model?: string;
  streamProtocol?: 'rtsp' | 'http';
  /** Auto-detected password hash method for HTTP media session (md5 or sha256) */
  httpHashMethod?: 'md5' | 'sha256';
}

export interface Recording {
  startTime: number; // unix ms
  endTime: number; // unix ms
}

export interface RecordingEvent {
  startTime: number; // unix ms
  endTime: number; // unix ms
  alarmType?: number;
}

export type PreviewPosition = 'left' | 'right' | 'top' | 'bottom';

export interface RuntimeInfo {
  userData: string;
  logPath: string | null;
  isDevelopment: boolean;
  isPackaged: boolean;
}
