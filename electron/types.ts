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
}

export interface Recording {
  startTime: number; // unix ms
  endTime: number; // unix ms
}

export type PreviewPosition = 'left' | 'right' | 'top' | 'bottom';

export interface RuntimeInfo {
  userData: string;
  logPath: string | null;
  isDevelopment: boolean;
  isPackaged: boolean;
}
