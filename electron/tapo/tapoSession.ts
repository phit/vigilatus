/**
 * TapoSession — Tapo camera connection, login, and encrypted request envelope.
 *
 * Owns the auth protocol (reverse-engineered from kopiro/homebridge-tapo-camera)
 * and the HTTP transport. Supports both firmware generations:
 *   • Older firmware: plain login with MD5-hashed password.
 *   • Newer firmware: AES-128-CBC encrypted challenge-response (encrypt_type "3").
 *
 * `TapoClient` composes a `TapoSession` and layers the high-level recordings /
 * playback / user-id-resolution logic on top.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { normalizeBase64, type ApiResponse } from './recordingParse';

const MAX_LOGIN_RETRIES = 2;
const CONTROL_CONNECT_TIMEOUT_MS = 3_000;

export interface TapoSessionConfig {
  host: string;
  username: string;
  password: string;
}

export interface ApiRequest {
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
// TapoSession
// ---------------------------------------------------------------------------

export class TapoSession {
  private readonly host: string;
  private readonly username: string;
  private readonly rawPassword: string;
  private readonly hashedMd5Value: string;
  private readonly hashedSha256: string;
  private cnonce: string;
  private readonly agent: https.Agent;
  private preferredProtocol: 'https' | 'http' = 'https';

  private stok?: string;
  private lsk?: Buffer;
  private ivb?: Buffer;
  private seq?: number;
  private isSecureValue?: boolean;
  private passwordMethodValue?: 'md5' | 'sha256';
  private triedSecureDowngrade = false;
  private loginPromise?: Promise<void>;

  constructor(cfg: TapoSessionConfig) {
    this.host = cfg.host;
    this.username = cfg.username || 'admin';
    this.rawPassword = cfg.password;
    this.hashedMd5Value = md5Upper(cfg.password);
    this.hashedSha256 = sha256Upper(cfg.password);
    this.cnonce = crypto.randomBytes(8).toString('hex').toUpperCase();
    this.agent = new https.Agent({
      rejectUnauthorized: false,
      ciphers: 'AES256-SHA:AES128-GCM-SHA256',
    });
  }

  get hashedMd5(): string {
    return this.hashedMd5Value;
  }

  get passwordMethod(): 'md5' | 'sha256' | undefined {
    return this.passwordMethodValue;
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

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  private reset(): void {
    this.stok = undefined;
    this.lsk = undefined;
    this.ivb = undefined;
    this.seq = undefined;
    this.isSecureValue = undefined;
    this.passwordMethodValue = undefined;
    this.triedSecureDowngrade = false;
  }

  clearSession(): void {
    this.stok = undefined;
    this.lsk = undefined;
    this.ivb = undefined;
    this.seq = undefined;
  }

  getHashedPassword(): string {
    return this.passwordMethodValue === 'sha256' ? this.hashedSha256 : this.hashedMd5Value;
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
      this.passwordMethodValue = 'sha256';
      return true;
    }
    const md5Check = md5Upper(this.cnonce + this.hashedMd5Value + nonce);
    if (deviceConfirm === md5Check + nonce + this.cnonce) {
      this.passwordMethodValue = 'md5';
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
        params: { username: this.username, password: this.hashedMd5Value, hashed: true },
      });

      if (hashedResp?.result?.stok) {
        this.passwordMethodValue = 'md5';
        this.stok = hashedResp.result.stok;
        return;
      }

      const plainResp = await this.post<ApiResponse>(`https://${this.host}`, {
        method: 'login',
        params: { username: this.username, password: this.rawPassword },
      });

      if (plainResp?.result?.stok) {
        this.passwordMethodValue = 'md5';
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
              this.passwordMethodValue = 'md5';
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
