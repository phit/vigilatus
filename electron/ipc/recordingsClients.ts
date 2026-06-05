import { TapoClient } from '../tapo/client';
import type { CameraConfig } from '../types';

export const recordingsCredentialCache = new Map<
  string,
  Pick<CameraConfig, 'host' | 'username' | 'password'>
>();
export const recordingsClientCache = new Map<string, TapoClient>();
export const recordingsUserIdCache = new Map<string, number>();

export function primaryCredential(cam: CameraConfig): Pick<CameraConfig, 'host' | 'username' | 'password'> {
  return { host: cam.host, username: cam.username || 'admin', password: cam.password };
}

export function getOrCreateRecordingsClient(cameraId: string, cam: CameraConfig): TapoClient {
  const credential = recordingsCredentialCache.get(cameraId) ?? primaryCredential(cam);
  let client = recordingsClientCache.get(cameraId);
  if (!client) {
    client = new TapoClient(credential);
    recordingsCredentialCache.set(cameraId, credential);
    recordingsClientCache.set(cameraId, client);
  }
  return client;
}

export function clearRecordingsClientCaches(cameraId: string): void {
  recordingsCredentialCache.delete(cameraId);
  recordingsClientCache.delete(cameraId);
  recordingsUserIdCache.delete(cameraId);
}
