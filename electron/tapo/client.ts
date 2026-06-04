/**
 * TapoClient — Tapo camera HTTP API client.
 *
 * Supports both firmware generations:
 *   • Older firmware: plain login with MD5-hashed password.
 *   • Newer firmware: AES-128-CBC encrypted challenge-response (encrypt_type "3").
 *
 * Auth protocol reverse-engineered from kopiro/homebridge-tapo-camera.
 *
 * IMPORTANT — prerequisites on the camera:
 *   • Newer firmware (build ≥ 230921): enable "Third-Party Compatibility"
 *     in the Tapo app → Me → Tapo Lab → Third-Party Compatibility.
 *   • Set a Camera Account (stream credentials) in Advanced Settings
 *     — these are separate from the API / TP-Link account password.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Recording, RecordingEvent } from '../types';
import {
  downloadRecordingToMp4,
  startRecordingDownloadToHls,
  type RecordingAudioOptions,
  type RecordingPlaybackJob,
} from './recordingDownloader';
import {
  extractRecordingEventsFromResponse,
  extractRecordingsFromResponse,
  firstResponseErrorCode,
  normalizeBase64,
  type ApiResponse,
} from './recordingParse';
import { createLogger } from '../log';

const MAX_LOGIN_RETRIES = 2;
const PLAYBACK_PADDING_SECONDS = 5;
const DEFAULT_PLAYBACK_USER_IDS = [1, 0] as const;
const STALE_USER_ID_ERROR_CODES = new Set([-71103, -71105]);
const CONTROL_CONNECT_TIMEOUT_MS = 3_000;

interface TapoClientConfig {
  host: string;
  username: string;
  password: string;
}

interface ApiRequest {
  method: string;
  params?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function md5Upper(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex').toUpperCase();
}

function sha256Upper(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').toUpperCase();
}

function aesEncrypt(data: string, key: Buffer, iv: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(data, 'utf8')), cipher.final()]);
  return encrypted;
}

function aesDecrypt(b64: string, key: Buffer, iv: Buffer): string {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const ciphertext = Buffer.from(b64, 'base64');
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

// ---------------------------------------------------------------------------
// TapoClient
// ---------------------------------------------------------------------------

export class TapoClient {
  private static readonly userIdCache = new Map<string, number>();

  private readonly host: string;
  private readonly username: string;
  private readonly rawPassword: string;
  private readonly hashedMd5: string;
  private readonly hashedSha256: string;
  private cnonce: string;
  private readonly agent: https.Agent;
  private preferredProtocol: 'https' | 'http' = 'https';

  private stok?: string;
  private lsk?: Buffer;
  private ivb?: Buffer;
  private seq?: number;
  private isSecureValue?: boolean;
  private passwordMethod?: 'md5' | 'sha256';
  private triedSecureDowngrade = false;
  private cachedUserId?: number;
  private loginPromise?: Promise<void>;

  constructor(cfg: TapoClientConfig) {
    this.host = cfg.host;
    this.username = cfg.username || 'admin';
    this.rawPassword = cfg.password;
    this.hashedMd5 = md5Upper(cfg.password);
    this.hashedSha256 = sha256Upper(cfg.password);
    this.cnonce = crypto.randomBytes(8).toString('hex').toUpperCase();
    this.agent = new https.Agent({
      rejectUnauthorized: false,
      ciphers: 'AES256-SHA:AES128-GCM-SHA256',
    });

    const cachedUserId = TapoClient.userIdCache.get(this.userIdCacheKey());
    if (typeof cachedUserId === 'number') {
      this.cachedUserId = cachedUserId;
    }
  }

  private userIdCacheKey(): string {
    return `${this.host}\u0000${this.username}\u0000${this.hashedMd5}`;
  }

  private rememberUserId(userId: number): number {
    this.cachedUserId = userId;
    TapoClient.userIdCache.set(this.userIdCacheKey(), userId);
    return userId;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      this.reset();
      await this.getStok();
      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  getCachedUserId(): number | undefined {
    return this.cachedUserId;
  }

  /**
   * Return recordings for a given day.
   * @param date YYYYMMDD string
   */
  async getRecordingsForDate(date: string): Promise<Recording[]> {
    const primary = await this.queryRecordingsForDateWithFallbacks(date);
    if (primary.length > 0) {
      return primary;
    }

    const nearbyDates = await this.searchDatesWithVideo(date);

    for (const candidateDate of nearbyDates) {
      if (candidateDate === date) continue;
      const fromCandidate = await this.queryRecordingsForDateWithFallbacks(candidateDate);
      if (fromCandidate.length > 0) {
        return fromCandidate;
      }
    }

    if (nearbyDates.length > 0) {
      throw new Error(
        'Camera reports recording dates, but segment detail queries are denied/empty. Try owner admin credentials for camera API access.',
      );
    }

    return [];
  }

  async getRecordingEventsForDate(date: string): Promise<RecordingEvent[]> {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(4, 6));
    const day = Number(date.slice(6, 8));
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return [];
    }

    const localStartSec = Math.floor(new Date(year, month - 1, day, 0, 0, 0).getTime() / 1000);
    const localEndSec = Math.floor(new Date(year, month - 1, day, 23, 59, 59).getTime() / 1000);
    const timeCorrection = await this.getTimeCorrection();

    const queryStartSec = localStartSec - timeCorrection;
    const queryEndSec = localEndSec - timeCorrection;

    const directResp = await this.apiRequest({
      method: 'searchDetectionList',
      params: {
        playback: {
          search_detection_list: {
            start_index: 0,
            channel: 0,
            start_time: queryStartSec,
            end_time: queryEndSec,
            end_index: 999,
          },
        },
      },
    });

    const directEvents = extractRecordingEventsFromResponse(directResp, timeCorrection);
    if (directEvents.length > 0) {
      return directEvents;
    }

    const nestedResp = await this.apiRequest({
      method: 'multipleRequest',
      params: {
        requests: [
          {
            method: 'searchDetectionList',
            params: {
              playback: {
                search_detection_list: {
                  start_index: 0,
                  channel: 0,
                  start_time: queryStartSec,
                  end_time: queryEndSec,
                  end_index: 999,
                },
              },
            },
          },
        ],
      },
    });

    return extractRecordingEventsFromResponse(nestedResp, timeCorrection);
  }

  private async queryRecordingsForDateWithFallbacks(date: string): Promise<Recording[]> {
    const attemptedUserIds = new Set<string>();
    const candidateUserIds: Array<number | undefined> = [];
    const pushCandidateUserId = (value: number | undefined): void => {
      const key = value === undefined ? 'none' : String(value);
      if (attemptedUserIds.has(key)) {
        return;
      }
      attemptedUserIds.add(key);
      candidateUserIds.push(value);
    };

    if (typeof this.cachedUserId === 'number') {
      pushCandidateUserId(this.cachedUserId);
    }
    pushCandidateUserId(undefined);

    for (const candidateUserId of candidateUserIds) {
      const recordings = await this.queryRecordingsForDate(date, candidateUserId);
      if (recordings.length > 0) {
        return recordings;
      }
    }

    const resolvedUserId = await this.tryResolvePlaybackUserId(false);
    if (typeof resolvedUserId === 'number' && !attemptedUserIds.has(String(resolvedUserId))) {
      const recordings = await this.queryRecordingsForDate(date, resolvedUserId);
      return recordings;
    }

    return [];
  }

  private async queryRecordingsForDate(date: string, userId?: number): Promise<Recording[]> {
    const daySearchParams: {
      channel: number;
      date: string;
      end_index: number;
      start_index: number;
      id?: number;
    } = {
      channel: 0,
      date,
      end_index: 9999,
      start_index: 0,
    };

    if (typeof userId === 'number') {
      daySearchParams.id = userId;
    }

    const resp = await this.apiRequest({
      method: 'multipleRequest',
      params: {
        requests: [
          {
            method: 'searchVideoOfDay',
            params: daySearchParams,
          },
        ],
      },
    });

    const direct = extractRecordingsFromResponse(resp);
    if (direct.length > 0) {
      return direct;
    }
    if (
      typeof userId === 'number' &&
      STALE_USER_ID_ERROR_CODES.has(firstResponseErrorCode(resp) ?? Number.NaN)
    ) {
      const refreshedUserId = await this.tryResolvePlaybackUserId(true);
      if (typeof refreshedUserId === 'number' && refreshedUserId !== userId) {
        return this.queryRecordingsForDate(date, refreshedUserId);
      }
    }

    // pytapo-compatible shape used by several firmware variants.
    const legacyResp = await this.apiRequest({
      method: 'multipleRequest',
      params: {
        requests: [
          {
            method: 'searchVideoOfDay',
            params: {
              playback: {
                search_video_utility: daySearchParams,
              },
            },
          },
        ],
      },
    });

    const legacyParsed = extractRecordingsFromResponse(legacyResp);
    if (legacyParsed.length > 0) {
      return legacyParsed;
    }
    if (
      typeof userId === 'number' &&
      STALE_USER_ID_ERROR_CODES.has(firstResponseErrorCode(legacyResp) ?? Number.NaN)
    ) {
      const refreshedUserId = await this.tryResolvePlaybackUserId(true);
      if (typeof refreshedUserId === 'number' && refreshedUserId !== userId) {
        return this.queryRecordingsForDate(date, refreshedUserId);
      }
    }

    // Some firmware/timezone combinations return empty day results but work with UTC range search.
    const utcFallback = await this.searchRecordingsWithUtcRange(date, userId);
    return utcFallback;
  }

  private async searchDatesWithVideo(date: string): Promise<string[]> {
    const resp = await this.apiRequest({
      method: 'multipleRequest',
      params: {
        requests: [
          {
            method: 'searchDateWithVideo',
            params: {
              playback: {
                search_year_utility: {
                  channel: [0],
                  start_date: date,
                  end_date: date,
                },
              },
            },
          },
        ],
      },
    });

    const sub =
      (
        resp.result?.responses?.[0] as
          | {
              result?: { playback?: { search_results?: Array<Record<string, unknown>> } };
            }
          | undefined
      )?.result?.playback?.search_results ?? [];

    const dates = new Set<string>();
    for (const item of sub) {
      for (const value of Object.values(item)) {
        if (typeof value === 'string' && /^\d{8}$/.test(value)) {
          dates.add(value);
          continue;
        }
        if (value && typeof value === 'object') {
          const obj = value as Record<string, unknown>;
          for (const nested of Object.values(obj)) {
            if (typeof nested === 'string' && /^\d{8}$/.test(nested)) {
              dates.add(nested);
            }
          }
        }
      }
    }

    return Array.from(dates).sort();
  }

  private async runRecordingAttempts<T>(
    startTimeMs: number,
    endTimeMs: number,
    userIdOverride: number | undefined,
    fallbackErrorMessage: string,
    attempt: (ctx: {
      userId: number;
      windowSize: number;
      startTime: number;
      paddedEndTime: number;
      encryptionMethod: 'md5' | 'sha256';
      hashedPassword: string;
      audio: RecordingAudioOptions | undefined;
    }) => Promise<T>,
  ): Promise<T> {
    const startTime = Math.floor(startTimeMs / 1000);
    const endTime = Math.floor(endTimeMs / 1000);
    const paddedEndTime = endTime + PLAYBACK_PADDING_SECONDS;

    if (endTime <= startTime) {
      throw new Error('Invalid recording interval');
    }

    if (typeof userIdOverride === 'number') {
      this.rememberUserId(userIdOverride);
    }

    if (Math.floor(Date.now() / 1000) - 60 < endTime) {
      throw new Error('Recording is currently in progress');
    }

    const encryptionMethod = this.passwordMethod ?? 'md5';
    const hashedPassword = this.getHashedPassword();
    const audio = await this.getRecordingAudioConfig();

    const candidateUserIds = await this.resolvePlaybackUserIdCandidates(userIdOverride);

    if (candidateUserIds.length === 0) {
      throw new Error('Failed to resolve playback user ID');
    }

    let lastError: unknown = null;
    for (let i = 0; i < candidateUserIds.length; i += 1) {
      const candidateUserId = candidateUserIds[i];
      const isRetry = i > 0;
      try {
        return await attempt({
          userId: candidateUserId,
          windowSize: isRetry ? 50 : 200,
          startTime,
          paddedEndTime,
          encryptionMethod,
          hashedPassword,
          audio,
        });
      } catch (e) {
        lastError = e;
        const msg = String((e as Error)?.message ?? e ?? '');
        const shouldTryNextUserId =
          this.isRetryablePlaybackStreamError(msg) && i < candidateUserIds.length - 1;
        if (!shouldTryNextUserId) {
          throw e;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(fallbackErrorMessage);
  }

  async downloadRecording(startTimeMs: number, endTimeMs: number, userIdOverride?: number): Promise<string> {
    const startTime = Math.floor(startTimeMs / 1000);
    const endTime = Math.floor(endTimeMs / 1000);
    const hostDir = this.host.replace(/[^a-zA-Z0-9.-]/g, '_');
    const outDir = path.join(os.tmpdir(), 'vigilatus-recordings', hostDir);
    const outFile = path.join(outDir, `${startTime}-${endTime}.mp4`);

    return this.runRecordingAttempts(
      startTimeMs,
      endTimeMs,
      userIdOverride,
      'Unable to download recording stream',
      ({ userId, windowSize, startTime: start, paddedEndTime, encryptionMethod, hashedPassword, audio }) =>
        downloadRecordingToMp4({
          host: this.host,
          username: this.username,
          hashedPassword,
          encryptionMethod,
          audio,
          userId,
          startTime: start,
          endTime: paddedEndTime,
          outputPath: outFile,
          windowSize,
        }),
    );
  }

  async startRecordingPlayback(
    startTimeMs: number,
    endTimeMs: number,
    outputDir: string,
    userIdOverride?: number,
    seekOffsetSec?: number,
  ): Promise<RecordingPlaybackJob> {
    return this.runRecordingAttempts(
      startTimeMs,
      endTimeMs,
      userIdOverride,
      'Unable to start recording playback stream',
      ({ userId, windowSize, startTime, paddedEndTime, encryptionMethod, hashedPassword, audio }) =>
        startRecordingDownloadToHls({
          host: this.host,
          username: this.username,
          hashedPassword,
          encryptionMethod,
          audio,
          userId,
          startTime,
          endTime: paddedEndTime,
          outputDir,
          windowSize,
          seekOffsetSec,
        }),
    );
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  private reset(): void {
    this.stok = undefined;
    this.lsk = undefined;
    this.ivb = undefined;
    this.seq = undefined;
    this.isSecureValue = undefined;
    this.passwordMethod = undefined;
    this.triedSecureDowngrade = false;
  }

  private clearSession(): void {
    this.stok = undefined;
    this.lsk = undefined;
    this.ivb = undefined;
    this.seq = undefined;
  }

  private getHashedPassword(): string {
    return this.passwordMethod === 'sha256' ? this.hashedSha256 : this.hashedMd5;
  }

  private async isSecureConnection(): Promise<boolean> {
    if (this.isSecureValue !== undefined) return this.isSecureValue;

    await this.ensureControlPortReachable();

    const probeCnonce = crypto.randomBytes(8).toString('hex').toUpperCase();

    const resp = await this.post<ApiResponse>(`https://${this.host}`, {
      method: 'login',
      params: { cnonce: probeCnonce, encrypt_type: '3', username: this.username },
    });

    this.isSecureValue =
      resp.error_code === -40413 && String(resp.result?.data?.encrypt_type ?? '').includes('3');
    return this.isSecureValue;
  }

  private validateDeviceConfirm(nonce: string, deviceConfirm: string): boolean {
    const sha256Check = sha256Upper(this.cnonce + this.hashedSha256 + nonce);
    if (deviceConfirm === sha256Check + nonce + this.cnonce) {
      this.passwordMethod = 'sha256';
      return true;
    }
    const md5Check = md5Upper(this.cnonce + this.hashedMd5 + nonce);
    if (deviceConfirm === md5Check + nonce + this.cnonce) {
      this.passwordMethod = 'md5';
      return true;
    }
    return false;
  }

  private generateToken(tokenType: string, nonce: string): Buffer {
    const hashedKey = sha256Upper(this.cnonce + this.getHashedPassword() + nonce);
    return crypto
      .createHash('sha256')
      .update(tokenType + this.cnonce + nonce + hashedKey)
      .digest()
      .slice(0, 16);
  }

  private tapoTag(encryptedBody: object): string {
    const base = sha256Upper(this.getHashedPassword() + this.cnonce);
    return sha256Upper(base + JSON.stringify(encryptedBody) + this.seq!.toString());
  }

  async refreshStok(retryCount = 0): Promise<void> {
    // Match pytapo behavior: use a fresh cnonce for each login refresh sequence.
    this.cnonce = crypto.randomBytes(8).toString('hex').toUpperCase();
    const secure = await this.isSecureConnection();

    if (!secure) {
      // ---- insecure path (firmware variants differ on password field expectations) ----
      const hashedResp = await this.post<ApiResponse>(`https://${this.host}`, {
        method: 'login',
        params: { username: this.username, password: this.hashedMd5, hashed: true },
      });

      if (hashedResp?.result?.stok) {
        this.passwordMethod = 'md5';
        this.stok = hashedResp.result.stok;
        return;
      }

      const plainResp = await this.post<ApiResponse>(`https://${this.host}`, {
        method: 'login',
        params: { username: this.username, password: this.rawPassword },
      });

      if (plainResp?.result?.stok) {
        this.passwordMethod = 'md5';
        this.stok = plainResp.result.stok;
        return;
      }

      // If probe said insecure but insecure login still fails, attempt secure flow once.
      this.isSecureValue = true;
    }

    // ---- secure path: step 1 — request nonce ----
    const step1 = await this.post<ApiResponse>(`https://${this.host}`, {
      method: 'login',
      params: { cnonce: this.cnonce, encrypt_type: '3', username: this.username },
    });

    const nonce = step1.result?.data?.nonce;
    const deviceConfirm = step1.result?.data?.device_confirm;

    if (!nonce || !deviceConfirm || !this.validateDeviceConfirm(nonce, deviceConfirm)) {
      if (step1.error_code === -40413 && retryCount < MAX_LOGIN_RETRIES) {
        return this.refreshStok(retryCount + 1);
      }
      throw new Error('Secure login: invalid device confirm');
    }

    // ---- secure path: step 2 — respond with digest ----
    const digestPasswd = sha256Upper(this.getHashedPassword() + this.cnonce + nonce);
    const digestPasswdFull = Buffer.concat([
      Buffer.from(digestPasswd, 'utf8'),
      Buffer.from(this.cnonce, 'utf8'),
      Buffer.from(nonce, 'utf8'),
    ]).toString('utf8');

    const step2 = await this.post<ApiResponse>(`https://${this.host}`, {
      method: 'login',
      params: {
        cnonce: this.cnonce,
        encrypt_type: '3',
        digest_passwd: digestPasswdFull,
        username: this.username,
      },
    });

    const secLeft = step2.result?.data?.sec_left ?? 0;
    if (secLeft > 0) {
      throw new Error(`Temporary suspension: retry in ${secLeft}s`);
    }

    if (!step2.result?.stok) {
      if (step2.error_code === -40413 && retryCount < MAX_LOGIN_RETRIES) {
        return this.refreshStok(retryCount + 1);
      }
      throw new Error('Secure login: no stok in step-2 response');
    }

    if (step2.result.user_group !== 'root') {
      throw new Error('Secure login: user_group is not root — 3rd-party access may be disabled');
    }

    this.stok = step2.result.stok;
    this.seq = step2.result.start_seq;
    this.lsk = this.generateToken('lsk', nonce);
    this.ivb = this.generateToken('ivb', nonce);
  }

  async getStok(retryCount = 0): Promise<string> {
    if (this.stok) return this.stok;

    if (!this.loginPromise) {
      this.loginPromise = this.refreshStok(retryCount).finally(() => {
        this.loginPromise = undefined;
      });
    }

    await this.loginPromise;
    if (!this.stok) throw new Error('Failed to obtain stok');
    return this.stok;
  }

  // -------------------------------------------------------------------------
  // API requests
  // -------------------------------------------------------------------------

  async apiRequest(req: ApiRequest, retryCount = 0): Promise<ApiResponse> {
    const secure = await this.isSecureConnection();
    const stok = await this.getStok(retryCount);
    const url = `https://${this.host}/stok=${stok}/ds`;

    let fetchBody: object = req;
    let extraHeaders: Record<string, string> = {};

    if (secure && this.lsk && this.ivb && this.seq !== undefined) {
      const encrypted = aesEncrypt(JSON.stringify(req), this.lsk, this.ivb);
      const encBody = {
        method: 'securePassthrough',
        params: { request: encrypted.toString('base64') },
      };
      extraHeaders = {
        Tapo_tag: this.tapoTag(encBody),
        Seq: String(this.seq),
      };
      this.seq += 1;
      fetchBody = encBody;
    }

    const raw = await this.post<ApiResponse>(url, fetchBody, extraHeaders);
    let responseData: ApiResponse | null = null;

    // Token expired
    if (!raw || raw.error_code === -40401 || raw.error_code === -1) {
      this.clearSession();
      if (retryCount < MAX_LOGIN_RETRIES) return this.apiRequest(req, retryCount + 1);
      throw new Error(`API request failed: error_code ${raw?.error_code}`);
    }

    // Decrypt if secure
    if (secure && raw.result?.response) {
      const secureResponse = raw.result.response;
      const normalizedSecureResponse = normalizeBase64(secureResponse);
      try {
        const decrypted = aesDecrypt(normalizedSecureResponse, this.lsk!, this.ivb!);
        responseData = JSON.parse(decrypted) as ApiResponse;
      } catch {
        try {
          // Some firmware revisions return plain JSON text in response instead of AES payload.
          responseData = JSON.parse(secureResponse) as ApiResponse;
        } catch {
          try {
            // Some variants return base64-encoded plain JSON payloads.
            const decoded = Buffer.from(normalizedSecureResponse, 'base64').toString('utf8');
            responseData = JSON.parse(decoded) as ApiResponse;
          } catch {
            this.clearSession();
            if (retryCount < MAX_LOGIN_RETRIES) return this.apiRequest(req, retryCount + 1);

            if (!this.triedSecureDowngrade) {
              this.triedSecureDowngrade = true;
              this.isSecureValue = false;
              this.passwordMethod = 'md5';
              return this.apiRequest(req, 0);
            }

            throw new Error('Failed to decrypt API response');
          }
        }
      }
    } else if (!secure) {
      responseData = raw;
    }

    if (!responseData) {
      this.clearSession();
      if (retryCount < MAX_LOGIN_RETRIES) return this.apiRequest(req, retryCount + 1);
      throw new Error('API request returned no usable response');
    }

    return responseData;
  }

  private async getUserId(retryCount = 0): Promise<number> {
    if (retryCount === 0 && this.cachedUserId !== undefined) {
      return this.cachedUserId;
    }
    const resp = await this.apiRequest({
      method: 'multipleRequest',
      params: {
        requests: [
          {
            method: 'getUserID',
            params: { system: { get_user_id: 'null' } },
          },
        ],
      },
    });

    const firstResponseErrorCode = (resp.result.responses?.[0] as { error_code?: unknown } | undefined)
      ?.error_code;
    if (
      (firstResponseErrorCode === -1 || firstResponseErrorCode === -40401) &&
      retryCount < MAX_LOGIN_RETRIES
    ) {
      this.clearSession();
      return this.getUserId(retryCount + 1);
    }

    const asNumber = (v: unknown): number | null => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
      return null;
    };

    const direct = (resp.result as { user_id?: unknown }).user_id;
    const directNum = asNumber(direct);
    if (directNum != null) {
      return this.rememberUserId(directNum);
    }

    const nested = (resp.result.responses?.[0] as { result?: { user_id?: unknown } } | undefined)?.result
      ?.user_id;
    const nestedNum = asNumber(nested);
    if (nestedNum != null) {
      return this.rememberUserId(nestedNum);
    }

    const systemNested = (
      resp.result.responses?.[0] as
        | {
            result?: { system?: { get_user_id?: { id?: unknown; user_id?: unknown } } };
          }
        | undefined
    )?.result?.system?.get_user_id;

    const systemUserId = asNumber(systemNested?.user_id);
    if (systemUserId != null) {
      return this.rememberUserId(systemUserId);
    }

    const systemId = asNumber(systemNested?.id);
    if (systemId != null) {
      return this.rememberUserId(systemId);
    }

    const multiResponseUserId = (
      resp.result.responses?.[0] as
        | {
            result?: { user_id?: unknown };
          }
        | undefined
    )?.result?.user_id;
    const multiResponseUserIdNum = asNumber(multiResponseUserId);
    if (multiResponseUserIdNum != null) {
      return this.rememberUserId(multiResponseUserIdNum);
    }

    const resultPreview = JSON.stringify(resp?.result ?? {}).slice(0, 500);
    createLogger('recordings:getUserId').warn('unparsed response', resultPreview);

    if (retryCount < MAX_LOGIN_RETRIES) {
      this.clearSession();
      return this.getUserId(retryCount + 1);
    }

    throw new Error('Failed to retrieve recording user ID');
  }

  private async tryResolvePlaybackUserId(forceReload: boolean): Promise<number | undefined> {
    try {
      return forceReload ? await this.getUserId(1) : await this.getUserId();
    } catch {
      return undefined;
    }
  }

  private appendPlaybackUserIdCandidate(
    candidateUserIds: number[],
    seenUserIds: Set<number>,
    value: unknown,
  ): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return;
    }
    if (seenUserIds.has(value)) {
      return;
    }
    seenUserIds.add(value);
    candidateUserIds.push(value);
  }

  private appendNearbyPlaybackUserIds(
    candidateUserIds: number[],
    seenUserIds: Set<number>,
    seed: number,
  ): void {
    this.appendPlaybackUserIdCandidate(candidateUserIds, seenUserIds, seed + 1);
    if (seed > 0) {
      this.appendPlaybackUserIdCandidate(candidateUserIds, seenUserIds, seed - 1);
    }
    this.appendPlaybackUserIdCandidate(candidateUserIds, seenUserIds, seed + 2);
    if (seed > 1) {
      this.appendPlaybackUserIdCandidate(candidateUserIds, seenUserIds, seed - 2);
    }
  }

  private async resolvePlaybackUserIdCandidates(userIdOverride: number | undefined): Promise<number[]> {
    const candidateUserIds: number[] = [];
    const seenUserIds = new Set<number>();
    const appendCandidate = (value: unknown): void => {
      this.appendPlaybackUserIdCandidate(candidateUserIds, seenUserIds, value);
    };
    const appendNearbyCandidates = (seed: number): void => {
      this.appendNearbyPlaybackUserIds(candidateUserIds, seenUserIds, seed);
    };

    appendCandidate(userIdOverride);
    appendCandidate(this.cachedUserId);

    const initialSeeds = [...candidateUserIds];
    for (const seed of initialSeeds) {
      appendNearbyCandidates(seed);
    }

    for (const fallbackUserId of DEFAULT_PLAYBACK_USER_IDS) {
      appendCandidate(fallbackUserId);
    }

    const resolvedUserId = await this.tryResolvePlaybackUserId(false);
    if (typeof resolvedUserId === 'number') {
      appendCandidate(resolvedUserId);
      appendNearbyCandidates(resolvedUserId);
    }

    if (candidateUserIds.length === 0) {
      throw new Error('Failed to resolve playback user ID');
    }

    return candidateUserIds;
  }

  private isRetryablePlaybackStreamError(message: string): boolean {
    return (
      message.includes('Camera closed the recording stream unexpectedly') ||
      message.includes('Timed out waiting for recording data from camera') ||
      message.includes('ffmpeg created an empty recording file')
    );
  }

  private async getTimeCorrection(): Promise<number> {
    try {
      const resp = await this.apiRequest({
        method: 'getClockStatus',
        params: { system: { name: 'clock_status' } },
      });

      const direct = (resp.result as { system?: { clock_status?: { seconds_from_1970?: unknown } } }).system
        ?.clock_status?.seconds_from_1970;
      if (typeof direct === 'number') {
        return Math.floor(Date.now() / 1000) - direct;
      }

      const nested = (
        resp.result.responses?.[0] as
          | {
              result?: { system?: { clock_status?: { seconds_from_1970?: unknown } } };
            }
          | undefined
      )?.result?.system?.clock_status?.seconds_from_1970;
      if (typeof nested === 'number') {
        return Math.floor(Date.now() / 1000) - nested;
      }
    } catch {
      // Some models/firmware variants don't expose this shape reliably.
    }

    return 0;
  }

  private async getRecordingAudioConfig(): Promise<RecordingAudioOptions | undefined> {
    try {
      const resp = await this.apiRequest({
        method: 'multipleRequest',
        params: {
          requests: [
            {
              method: 'getAudioConfig',
              params: {
                method: 'get',
                audio_config: { name: ['speaker', 'microphone', 'record_audio'] },
              },
            },
          ],
        },
      });

      const subResult = (
        resp.result.responses?.[0] as
          | {
              result?: { audio_config?: { microphone?: { encode_type?: unknown; sampling_rate?: unknown } } };
            }
          | undefined
      )?.result?.audio_config?.microphone;

      const encodeType = String(subResult?.encode_type ?? '').toLowerCase();
      const sampleRateValue = subResult?.sampling_rate;
      const sampleRate =
        typeof sampleRateValue === 'number'
          ? sampleRateValue * 1000
          : typeof sampleRateValue === 'string' && /^\d+$/.test(sampleRateValue)
            ? Number(sampleRateValue) * 1000
            : 8000;

      const codec: RecordingAudioOptions['codec'] = encodeType.includes('ulaw') ? 'pcmu' : 'pcma';
      return { codec, sampleRate };
    } catch {
      return undefined;
    }
  }

  private async searchRecordingsWithUtcRange(date: string, userId?: number): Promise<Recording[]> {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(4, 6));
    const day = Number(date.slice(6, 8));
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return [];
    }

    const buildSearchParams = (
      startSec: number,
      endSec: number,
    ): {
      channel: number;
      start_time: number;
      end_time: number;
      start_index: number;
      end_index: number;
      id?: number;
    } => ({
      channel: 0,
      start_time: startSec,
      end_time: endSec,
      start_index: 0,
      end_index: 9999,
    });

    const queryRange = async (startSec: number, endSec: number): Promise<Recording[]> => {
      const searchParams = buildSearchParams(startSec, endSec);
      if (typeof userId === 'number') {
        searchParams.id = userId;
      }

      const resp = await this.apiRequest({
        method: 'multipleRequest',
        params: {
          requests: [
            {
              method: 'searchVideoWithUTC',
              params: searchParams,
            },
          ],
        },
      });
      const parsed = extractRecordingsFromResponse(resp);
      if (parsed.length > 0) {
        return parsed;
      }
      if (
        typeof userId === 'number' &&
        STALE_USER_ID_ERROR_CODES.has(firstResponseErrorCode(resp) ?? Number.NaN)
      ) {
        const refreshedUserId = await this.tryResolvePlaybackUserId(true);
        if (typeof refreshedUserId === 'number' && refreshedUserId !== userId) {
          return this.searchRecordingsWithUtcRange(date, refreshedUserId);
        }
      }

      const legacyUtcResp = await this.apiRequest({
        method: 'multipleRequest',
        params: {
          requests: [
            {
              method: 'searchVideoWithUTC',
              params: {
                playback: {
                  search_video_with_utc: searchParams,
                },
              },
            },
          ],
        },
      });
      const legacyParsed = extractRecordingsFromResponse(legacyUtcResp);
      if (
        legacyParsed.length === 0 &&
        typeof userId === 'number' &&
        STALE_USER_ID_ERROR_CODES.has(firstResponseErrorCode(legacyUtcResp) ?? Number.NaN)
      ) {
        const refreshedUserId = await this.tryResolvePlaybackUserId(true);
        if (typeof refreshedUserId === 'number' && refreshedUserId !== userId) {
          return this.searchRecordingsWithUtcRange(date, refreshedUserId);
        }
      }
      return legacyParsed;
    };

    // pytapo-compatible local day epoch (device/local time) first.
    const localStartSec = Math.floor(new Date(year, month - 1, day, 0, 0, 0).getTime() / 1000);
    const localEndSec = Math.floor(new Date(year, month - 1, day, 23, 59, 59).getTime() / 1000);
    const localResult = await queryRange(localStartSec, localEndSec);
    if (localResult.length > 0) {
      return localResult;
    }

    // UTC day range fallback for firmware expecting UTC boundaries.
    const startUtcSec = Math.floor(Date.UTC(year, month - 1, day, 0, 0, 0) / 1000);
    const endUtcSec = Math.floor(Date.UTC(year, month - 1, day, 23, 59, 59) / 1000);
    return queryRange(startUtcSec, endUtcSec);
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private async ensureControlPortReachable(port = 443): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port });

      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };

      socket.setTimeout(CONTROL_CONNECT_TIMEOUT_MS);
      socket.once('connect', () => {
        cleanup();
        resolve();
      });
      socket.once('timeout', () => {
        cleanup();
        reject(new Error(`Camera control port is unreachable (${this.host}:${port})`));
      });
      socket.once('error', (error) => {
        const message = (error as Error)?.message ?? String(error);
        cleanup();
        reject(new Error(`Camera control port is unreachable (${this.host}:${port}): ${message}`));
      });
    });
  }

  private post<T>(url: string, body: object, extraHeaders?: Record<string, string>): Promise<T> {
    const parsed = new URL(url);
    const pathName = parsed.pathname + parsed.search;
    const controlPort = parsed.port ? Number(parsed.port) : 443;

    const makeRequest = (protocol: 'https' | 'http', port: number): Promise<T> =>
      new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body), 'utf-8');
        const isHttps = protocol === 'https';
        const requestImpl = isHttps ? https.request : http.request;
        const req = requestImpl(
          {
            hostname: this.host,
            port,
            path: pathName,
            method: 'POST',
            ...(isHttps ? { agent: this.agent } : {}),
            headers: {
              Host: `${protocol}://${this.host}`,
              Referer: `${protocol}://${this.host}`,
              Accept: 'application/json',
              'Accept-Encoding': 'gzip, deflate',
              'User-Agent': 'Tapo CameraClient Android',
              Connection: 'close',
              requestByApp: 'true',
              'Content-Type': 'application/json; charset=UTF-8',
              'Content-Length': data.length,
              ...extraHeaders,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T);
              } catch {
                reject(new Error('Invalid JSON from camera'));
              }
            });
          },
        );

        req.setTimeout(10_000, () => {
          req.destroy(new Error(`Request timed out (${protocol.toUpperCase()} ${this.host}:${port})`));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
      });

    const shouldFallbackToHttp = (error: unknown): boolean => {
      const msg = String((error as Error)?.message ?? error ?? '');
      return (
        msg.includes('Expected HTTP/') ||
        msg.includes('wrong version number') ||
        msg.includes('EPROTO') ||
        msg.includes('socket hang up') ||
        msg.includes('Request timed out') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ENOTFOUND')
      );
    };

    const shouldFallbackToHttps = (error: unknown): boolean => {
      const msg = String((error as Error)?.message ?? error ?? '');
      return (
        msg.includes('ECONNREFUSED') ||
        msg.includes('EHOSTUNREACH') ||
        msg.includes('Request timed out') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('socket hang up') ||
        msg.includes('Expected HTTP/') ||
        msg.includes('wrong version number') ||
        msg.includes('EPROTO')
      );
    };

    if (this.preferredProtocol === 'https') {
      return makeRequest('https', controlPort).catch((err) => {
        if (shouldFallbackToHttp(err)) {
          return makeRequest('http', controlPort).then((result) => {
            this.preferredProtocol = 'http';
            return result;
          });
        }
        throw err;
      });
    }

    return makeRequest('http', controlPort).catch((err) => {
      if (shouldFallbackToHttps(err)) {
        return makeRequest('https', controlPort).then((result) => {
          this.preferredProtocol = 'https';
          return result;
        });
      }
      throw err;
    });
  }
}
