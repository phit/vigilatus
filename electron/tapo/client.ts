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
import os from 'node:os';
import path from 'node:path';
import type { Recording } from '../types';
import { downloadRecordingToMp4 } from './recordingDownloader';

const AES_BLOCK_SIZE = 16;
const MAX_LOGIN_RETRIES = 2;

interface TapoClientConfig {
  host: string;
  username: string;
  password: string;
}

interface ApiRequest {
  method: string;
  params?: unknown;
}

interface ApiResponse {
  error_code: number;
  result: {
    stok?: string;
    start_seq?: number;
    user_group?: string;
    data?: {
      nonce?: string;
      device_confirm?: string;
      encrypt_type?: string;
      code?: number;
      sec_left?: number;
    };
    response?: string;
    responses?: Array<{ method: string; error_code: number; result: unknown }>;
  };
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

function encryptPad(text: string, blockSize: number): string {
  const padSize = blockSize - (text.length % blockSize);
  return text + String.fromCharCode(padSize).repeat(padSize);
}

function encryptUnpad(text: string, blockSize: number): string {
  const padLen = text.charCodeAt(text.length - 1);
  if (padLen > blockSize || padLen > text.length) throw new Error('Invalid AES padding');
  return text.slice(0, text.length - padLen);
}

function aesEncrypt(data: string, key: Buffer, iv: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const padded = encryptPad(data, AES_BLOCK_SIZE);
  const hex = cipher.update(padded, 'utf-8', 'hex') + cipher.final('hex');
  return Buffer.from(hex, 'hex');
}

function aesDecrypt(b64: string, key: Buffer, iv: Buffer): string {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const raw = decipher.update(b64, 'base64', 'utf-8') + decipher.final('utf-8');
  return encryptUnpad(raw, AES_BLOCK_SIZE);
}

// ---------------------------------------------------------------------------
// TapoClient
// ---------------------------------------------------------------------------

export class TapoClient {
  private readonly host: string;
  private readonly username: string;
  private readonly hashedMd5: string;
  private readonly hashedSha256: string;
  private readonly cnonce: string;
  private readonly agent: https.Agent;
  private preferredProtocol: 'https' | 'http' = 'https';
  private preferredPort = 443;

  private stok?: string;
  private lsk?: Buffer;
  private ivb?: Buffer;
  private seq?: number;
  private isSecureValue?: boolean;
  private passwordMethod?: 'md5' | 'sha256';
  private triedSecureDowngrade = false;

  constructor(cfg: TapoClientConfig) {
    this.host = cfg.host;
    this.username = cfg.username || 'admin';
    this.hashedMd5 = md5Upper(cfg.password);
    this.hashedSha256 = sha256Upper(cfg.password);
    this.cnonce = crypto.randomBytes(8).toString('hex').toUpperCase();
    this.agent = new https.Agent({
      rejectUnauthorized: false,
      ciphers: 'AES256-SHA:AES128-GCM-SHA256',
    });
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

  /**
   * Return recordings for a given day.
   * @param date YYYYMMDD string
   */
  async getRecordingsForDate(date: string): Promise<Recording[]> {
    const userId = await this.getUserId();

    const resp = await this.apiRequest({
      method: 'multipleRequest',
      params: {
        requests: [
          {
            method: 'searchVideoOfDay',
            params: { channel: 0, date, id: userId, end_index: 9999, start_index: 0 },
          },
        ],
      },
    });

    const direct = this.extractRecordingsFromResponse(resp);
    if (direct.length > 0) {
      return direct;
    }

    // Some firmware/timezone combinations return empty day results but work with UTC range search.
    const utcFallback = await this.searchRecordingsWithUtcRange(date, userId);
    return utcFallback;
  }

  async downloadRecording(startTimeMs: number, endTimeMs: number): Promise<string> {
    const startTime = Math.floor(startTimeMs / 1000);
    const endTime = Math.floor(endTimeMs / 1000);

    if (endTime <= startTime) {
      throw new Error('Invalid recording interval');
    }

    await this.getStok();
    const userId = await this.getUserId();
    const timeCorrection = await this.getTimeCorrection();

    if (Math.floor(Date.now() / 1000) - 60 - timeCorrection < endTime) {
      throw new Error('Recording is currently in progress');
    }

    const hostDir = this.host.replace(/[^a-zA-Z0-9.-]/g, '_');
    const outDir = path.join(os.tmpdir(), 'tapostudio-recordings', hostDir);
    const outFile = path.join(outDir, `${startTime}-${endTime}.mp4`);

    const encryptionMethod = this.passwordMethod ?? 'md5';
    const hashedPassword = this.getHashedPassword();

    return downloadRecordingToMp4({
      host: this.host,
      username: this.username,
      hashedPassword,
      encryptionMethod,
      userId,
      startTime,
      endTime,
      outputPath: outFile,
    });
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

    const resp = await this.post<ApiResponse>(`https://${this.host}`, {
      method: 'login',
      params: { encrypt_type: '3', username: this.username },
    });

    this.isSecureValue =
      resp.error_code === -40413 &&
      String(resp.result?.data?.encrypt_type ?? '').includes('3');
    return this.isSecureValue;
  }

  private validateDeviceConfirm(
    nonce: string,
    deviceConfirm: string,
  ): boolean {
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
        params: { username: this.username, password: this.hashedMd5 },
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
      params: { cnonce: this.cnonce, encrypt_type: '3', digest_passwd: digestPasswdFull, username: this.username },
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
    await this.refreshStok(retryCount);
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
    if (
      !raw ||
      raw.error_code === -40401 ||
      raw.error_code === -1
    ) {
      this.clearSession();
      if (retryCount < MAX_LOGIN_RETRIES) return this.apiRequest(req, retryCount + 1);
      throw new Error(`API request failed: error_code ${raw?.error_code}`);
    }

    // Decrypt if secure
    if (secure && raw.result?.response) {
      const secureResponse = raw.result.response;
      try {
        const decrypted = aesDecrypt(secureResponse, this.lsk!, this.ivb!);
        responseData = JSON.parse(decrypted) as ApiResponse;
      } catch {
        try {
          // Some firmware revisions return plain JSON text in response instead of AES payload.
          responseData = JSON.parse(secureResponse) as ApiResponse;
        } catch {
          try {
            // Some variants return base64-encoded plain JSON payloads.
            const decoded = Buffer.from(secureResponse, 'base64').toString('utf8');
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

  private async getUserId(): Promise<number> {
    const resp = await this.apiRequest({
      method: 'getUserID',
      params: { system: { get_user_id: 'null' } },
    });

    const direct = (resp.result as { user_id?: unknown }).user_id;
    if (typeof direct === 'number') return direct;

    const nested = (resp.result.responses?.[0] as { result?: { user_id?: unknown } } | undefined)
      ?.result?.user_id;
    if (typeof nested === 'number') return nested;

    throw new Error('Failed to retrieve recording user ID');
  }

  private async getTimeCorrection(): Promise<number> {
    try {
      const resp = await this.apiRequest({
        method: 'getClockStatus',
        params: { system: { name: 'clock_status' } },
      });

      const direct = (resp.result as { system?: { clock_status?: { seconds_from_1970?: unknown } } })
        .system?.clock_status?.seconds_from_1970;
      if (typeof direct === 'number') {
        return Math.floor(Date.now() / 1000) - direct;
      }

      const nested = (resp.result.responses?.[0] as {
        result?: { system?: { clock_status?: { seconds_from_1970?: unknown } } };
      } | undefined)?.result?.system?.clock_status?.seconds_from_1970;
      if (typeof nested === 'number') {
        return Math.floor(Date.now() / 1000) - nested;
      }
    } catch {
      // Some models/firmware variants don't expose this shape reliably.
    }

    return 0;
  }

  private extractRecordingsFromResponse(resp: ApiResponse): Recording[] {
    const sub = (resp.result?.responses ?? [])[0] as
      | {
          result?: {
            video?: { video_info?: Array<{ startTime?: number; endTime?: number }> };
            playback?: {
              search_video_results?: Array<Record<string, { startTime?: number; endTime?: number }>>;
            };
            search_video_results?: Array<Record<string, { startTime?: number; endTime?: number }>>;
          };
        }
      | undefined;

    const byVideoInfo = sub?.result?.video?.video_info ?? [];
    const fromVideoInfo = byVideoInfo
      .filter((v): v is { startTime: number; endTime: number } =>
        typeof v.startTime === 'number' && typeof v.endTime === 'number')
      .map((v) => ({ startTime: v.startTime * 1000, endTime: v.endTime * 1000 }));

    if (fromVideoInfo.length > 0) return fromVideoInfo;

    const nestedSearch = sub?.result?.playback?.search_video_results
      ?? sub?.result?.search_video_results
      ?? [];

    const flattened: Recording[] = [];
    for (const item of nestedSearch) {
      for (const value of Object.values(item)) {
        if (typeof value?.startTime === 'number' && typeof value?.endTime === 'number') {
          flattened.push({
            startTime: value.startTime * 1000,
            endTime: value.endTime * 1000,
          });
        }
      }
    }

    return flattened;
  }

  private async searchRecordingsWithUtcRange(date: string, userId: number): Promise<Recording[]> {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(4, 6));
    const day = Number(date.slice(6, 8));
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return [];
    }

    const startUtcSec = Math.floor(Date.UTC(year, month - 1, day, 0, 0, 0) / 1000);
    const endUtcSec = Math.floor(Date.UTC(year, month - 1, day, 23, 59, 59) / 1000);

    const resp = await this.apiRequest({
      method: 'multipleRequest',
      params: {
        requests: [
          {
            method: 'searchVideoWithUTC',
            params: {
              channel: 0,
              start_time: startUtcSec,
              end_time: endUtcSec,
              start_index: 0,
              end_index: 9999,
              id: userId,
            },
          },
        ],
      },
    });

    return this.extractRecordingsFromResponse(resp);
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private post<T>(url: string, body: object, extraHeaders?: Record<string, string>): Promise<T> {
    const parsed = new URL(url);
    const pathName = parsed.pathname + parsed.search;

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
        msg.includes('socket hang up')
      );
    };

    const shouldFallbackToHttps = (error: unknown): boolean => {
      const msg = String((error as Error)?.message ?? error ?? '');
      return (
        msg.includes('ECONNREFUSED') ||
        msg.includes('EHOSTUNREACH') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('socket hang up') ||
        msg.includes('Expected HTTP/') ||
        msg.includes('wrong version number') ||
        msg.includes('EPROTO')
      );
    };

    if (this.preferredProtocol === 'https') {
      return makeRequest('https', 443).catch((err) => {
        if (shouldFallbackToHttp(err)) {
          return makeRequest('http', 80).then((result) => {
            this.preferredProtocol = 'http';
            this.preferredPort = 80;
            return result;
          });
        }
        throw err;
      });
    }

    return makeRequest('http', 80).catch((err) => {
      if (shouldFallbackToHttps(err)) {
        return makeRequest('https', 443).then((result) => {
          this.preferredProtocol = 'https';
          this.preferredPort = 443;
          return result;
        });
      }
      throw err;
    });
  }
}
