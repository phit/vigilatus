import { once } from 'node:events';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

type EncryptionMethod = 'md5' | 'sha256';

interface DownloadRecordingOptions {
  host: string;
  username: string;
  hashedPassword: string;
  encryptionMethod: EncryptionMethod;
  userId: number;
  startTime: number;
  endTime: number;
  outputPath: string;
  windowSize?: number;
}

interface MediaPart {
  mimetype: string;
  encrypted: boolean;
  headers: Record<string, string>;
  plaintext: Buffer;
  seq?: number;
  sessionId?: number;
  json?: Record<string, unknown>;
}

const DEFAULT_CLIENT_BOUNDARY = '--client-stream-boundary--';
const DEFAULT_DEVICE_BOUNDARY = '--device-stream-boundary--';
const NO_DATA_TIMEOUT_MS = 10_000;

class BufferedSocketReader {
  private buffer = Buffer.alloc(0);
  private ended = false;
  private error: Error | null = null;
  private waiters = new Set<() => void>();

  constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.notify();
    });
    socket.on('end', () => {
      this.ended = true;
      this.notify();
    });
    socket.on('close', () => {
      this.ended = true;
      this.notify();
    });
    socket.on('error', (error) => {
      this.error = error;
      this.notify();
    });
  }

  async readExactly(length: number, timeoutMs?: number): Promise<Buffer> {
    while (this.buffer.length < length) {
      await this.waitForData(timeoutMs);
    }
    const chunk = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return chunk;
  }

  async readUntil(delimiter: Buffer, timeoutMs?: number): Promise<Buffer> {
    while (true) {
      const index = this.buffer.indexOf(delimiter);
      if (index !== -1) {
        const end = index + delimiter.length;
        const chunk = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end);
        return chunk;
      }
      await this.waitForData(timeoutMs);
    }
  }

  private async waitForData(timeoutMs?: number): Promise<void> {
    if (this.error) throw this.error;
    if (this.ended) throw new Error('Camera closed the recording stream unexpectedly');

    await new Promise<void>((resolve, reject) => {
      const onNotify = () => {
        cleanup();
        if (this.error) {
          reject(this.error);
          return;
        }
        if (this.ended && this.buffer.length === 0) {
          reject(new Error('Camera closed the recording stream unexpectedly'));
          return;
        }
        resolve();
      };

      const cleanup = () => {
        this.waiters.delete(onNotify);
        if (timer) clearTimeout(timer);
      };

      const timer = timeoutMs
        ? setTimeout(() => {
            cleanup();
            reject(new Error('Timed out waiting for recording data from camera'));
          }, timeoutMs)
        : null;

      this.waiters.add(onNotify);
    });
  }

  private notify(): void {
    for (const waiter of Array.from(this.waiters)) {
      waiter();
    }
  }
}

class MediaCipher {
  private readonly key: Buffer;
  private readonly iv: Buffer;

  constructor(keyExchangeHeader: string, hashedPassword: string) {
    const fields = parseDigestFields(keyExchangeHeader);
    const nonce = fields.nonce;
    const username = fields.username;

    if (!nonce) throw new Error('Recording stream key exchange did not include a nonce');
    if (!username || username === 'none') {
      throw new Error('Recording stream requires unsupported media-encryption mode');
    }

    this.key = crypto.createHash('md5').update(`${nonce}:${hashedPassword}`).digest();
    this.iv = crypto.createHash('md5').update(`${username}:${nonce}`).digest();
  }

  decrypt(ciphertext: Buffer): Buffer {
    const decipher = crypto.createDecipheriv('aes-128-cbc', this.key, this.iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}

class MediaSession {
  private readonly socket: net.Socket;
  private readonly reader: BufferedSocketReader;
  private readonly clientBoundary = DEFAULT_CLIENT_BOUNDARY;
  private deviceBoundary = DEFAULT_DEVICE_BOUNDARY;
  private cipher: MediaCipher | null = null;
  private readonly windowSize: number;

  constructor(
    private readonly host: string,
    private readonly username: string,
    private readonly hashedPassword: string,
    windowSize = 50,
  ) {
    this.socket = net.createConnection({ host, port: 8800 });
    this.reader = new BufferedSocketReader(this.socket);
    this.windowSize = windowSize;
  }

  async start(): Promise<void> {
    await once(this.socket, 'connect');

    const requestLine = Buffer.from('POST /stream HTTP/1.1');
    const headers: Record<string, string> = {
      'Content-Type': `multipart/mixed;boundary=${this.clientBoundary}`,
      Connection: 'keep-alive',
      'Content-Length': '-1',
    };

    await this.writeRequest(requestLine, headers);

    const firstHeaders = await this.readInitialHeaders();
    const authenticateHeader = firstHeaders['WWW-Authenticate'];
    if (!authenticateHeader) {
      throw new Error('Camera did not request recording-stream authentication');
    }

    const authFields = parseDigestFields(authenticateHeader.replace(/^Digest\s+/i, ''));
    const cnonce = crypto.randomBytes(24).toString('hex');
    const nc = '00000001';
    const qop = 'auth';
    const challenge1 = crypto
      .createHash('md5')
      .update(`${this.username}:${authFields.realm}:${this.hashedPassword}`)
      .digest('hex');
    const challenge2 = crypto.createHash('md5').update('POST:/stream').digest('hex');
    const response = crypto
      .createHash('md5')
      .update(`${challenge1}:${authFields.nonce}:${nc}:${cnonce}:${qop}:${challenge2}`)
      .digest('hex');

    headers.Authorization = `Digest username="${this.username}",realm="${authFields.realm}",uri="/stream",algorithm=MD5,nonce="${authFields.nonce}",nc=${nc},cnonce="${cnonce}",qop=${qop},response="${response}",opaque="${authFields.opaque}"`;

    await this.writeRequest(requestLine, headers);

    const okHeaders = await this.readInitialHeaders();
    const keyExchange = okHeaders['Key-Exchange'];
    if (!keyExchange) {
      throw new Error('Camera did not provide recording-stream key exchange data');
    }

    this.cipher = new MediaCipher(keyExchange, this.hashedPassword);

    const contentType = okHeaders['Content-Type'] ?? '';
    const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
    if (boundaryMatch?.[1]) {
      this.deviceBoundary = boundaryMatch[1].trim();
    }
  }

  async close(): Promise<void> {
    this.socket.destroy();
  }

  async streamRecording(
    userId: number,
    startTime: number,
    endTime: number,
    onVideoData: (chunk: Buffer) => Promise<void>,
  ): Promise<void> {
    const payload = JSON.stringify({
      type: 'request',
      seq: 1,
      params: {
        playback: {
          client_id: userId,
          channels: [0, 1],
          scale: '1/1',
          start_time: String(startTime),
          end_time: String(endTime),
          event_type: [1, 2],
        },
        method: 'get',
      },
    });

    await this.writeMultipart(Buffer.from(payload, 'utf8'), {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload)),
      'X-Data-Window-Size': String(this.windowSize),
    });

    let sessionId: number | undefined;

    while (true) {
      const part = await this.readPart();
      if (part.sessionId !== undefined) {
        sessionId = part.sessionId;
      }

      if (part.seq !== undefined && sessionId !== undefined && part.seq > 0 && part.seq % this.windowSize === 0) {
        await this.sendAck(sessionId, this.windowSize * Math.floor(part.seq / this.windowSize));
      }

      if (part.mimetype === 'video/mp2t') {
        await onVideoData(part.plaintext);
        continue;
      }

      if (part.mimetype !== 'application/json' || !part.json) {
        continue;
      }

      const params = (part.json.params ?? {}) as Record<string, unknown>;
      if (typeof params.session_id === 'number') {
        sessionId = params.session_id;
      }

      if (params.event_type === 'stream_status' && params.status === 'finished') {
        break;
      }
    }
  }

  private async sendAck(sessionId: number, received: number): Promise<void> {
    const payload = Buffer.from(JSON.stringify({
      type: 'notification',
      params: { event_type: 'stream_sequence' },
    }), 'utf8');

    await this.writeMultipart(payload, {
      'Content-Type': 'application/json',
      'Content-Length': String(payload.length),
      'X-Session-Id': String(sessionId),
      'X-Data-Received': String(received),
      'X-Data-Window-Size': String(this.windowSize),
    });
  }

  private async readInitialHeaders(): Promise<Record<string, string>> {
    const block = await this.reader.readUntil(Buffer.from('\r\n\r\n'), NO_DATA_TIMEOUT_MS);
    const separator = block.indexOf(Buffer.from('\r\n'));
    if (separator === -1) throw new Error('Camera returned malformed recording-stream response');

    const statusLine = block.subarray(0, separator).toString('utf8');
    const statusCode = parseStatusCode(statusLine);
    if (statusCode !== 200 && statusCode !== 401) {
      throw new Error(`Recording stream returned HTTP ${statusCode}`);
    }

    const headersBlock = block.subarray(separator + 2, block.length - 4);
    return parseHeaders(headersBlock.toString('utf8'));
  }

  private async readPart(): Promise<MediaPart> {
    await this.reader.readUntil(Buffer.from(this.deviceBoundary), NO_DATA_TIMEOUT_MS);
    const headerBlock = await this.reader.readUntil(Buffer.from('\r\n\r\n'), NO_DATA_TIMEOUT_MS);
    const headerText = headerBlock.subarray(0, headerBlock.length - 4).toString('utf8').trim();
    const headers = parseHeaders(headerText);
    const mimetype = headers['Content-Type'] ?? 'application/octet-stream';
    const contentLength = Number(headers['Content-Length'] ?? '0');
    const encrypted = headers['X-If-Encrypt'] === '1';
    const ciphertext = await this.reader.readExactly(contentLength, NO_DATA_TIMEOUT_MS);

    let plaintext = ciphertext;
    if (encrypted) {
      if (!this.cipher) throw new Error('Recording stream cipher was not initialised');
      plaintext = this.cipher.decrypt(ciphertext);
    }

    let json: Record<string, unknown> | undefined;
    let seq = headers['X-Data-Sequence'] ? Number(headers['X-Data-Sequence']) : undefined;
    let sessionId = headers['X-Session-Id'] ? Number(headers['X-Session-Id']) : undefined;

    if (mimetype === 'application/json') {
      try {
        json = JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>;
        if (typeof json.seq === 'number') seq = json.seq;
        const params = (json.params ?? {}) as Record<string, unknown>;
        if (typeof params.session_id === 'number') {
          sessionId = params.session_id;
        }
      } catch {
        /* ignore malformed control json */
      }
    }

    return {
      mimetype,
      encrypted,
      headers,
      plaintext,
      seq,
      sessionId,
      json,
    };
  }

  private async writeRequest(line: Buffer, headers: Record<string, string>): Promise<void> {
    this.socket.write(line);
    this.socket.write('\r\n');
    for (const [key, value] of Object.entries(headers)) {
      this.socket.write(`${key}: ${value}\r\n`);
    }
    this.socket.write('\r\n');
  }

  private async writeMultipart(data: Buffer, headers: Record<string, string>): Promise<void> {
    this.socket.write(`--${this.clientBoundary}\r\n`);
    for (const [key, value] of Object.entries(headers)) {
      this.socket.write(`${key}: ${value}\r\n`);
    }
    this.socket.write('\r\n');
    this.socket.write(data);
    this.socket.write('\r\n');
  }
}

export async function downloadRecordingToMp4(options: DownloadRecordingOptions): Promise<string> {
  if (!ffmpegStatic) {
    throw new Error('ffmpeg-static is not available on this platform');
  }

  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  if (fs.existsSync(options.outputPath)) {
    return options.outputPath;
  }

  const session = new MediaSession(
    options.host,
    options.username || 'admin',
    options.hashedPassword,
    options.windowSize,
  );
  await session.start();

  const ffmpegProc = spawn(ffmpegStatic, [
    '-loglevel',
    'error',
    '-y',
    '-f',
    'mpegts',
    '-i',
    'pipe:0',
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    options.outputPath,
  ], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  const stderrChunks: Buffer[] = [];
  ffmpegProc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  let tsBuffer = Buffer.alloc(0);

  try {
    await session.streamRecording(options.userId, options.startTime, options.endTime, async (chunk) => {
      tsBuffer = Buffer.concat([tsBuffer, chunk]);
      while (tsBuffer.length >= 188) {
        const packet = tsBuffer.subarray(0, 188);
        tsBuffer = tsBuffer.subarray(188);
        if (!ffmpegProc.stdin.write(packet)) {
          await once(ffmpegProc.stdin, 'drain');
        }
      }
    });

    ffmpegProc.stdin.end();
    const [exitCode] = (await once(ffmpegProc, 'close')) as [number | null];
    if (exitCode !== 0) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      throw new Error(stderr || `ffmpeg exited with code ${exitCode}`);
    }

    return options.outputPath;
  } catch (error) {
    try {
      ffmpegProc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(options.outputPath, { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  } finally {
    await session.close();
  }
}

function parseDigestFields(value: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const chunk of value.split(',')) {
    const [rawKey, rawValue] = chunk.split('=', 2);
    if (!rawKey || rawValue === undefined) continue;
    fields[rawKey.trim()] = rawValue.trim().replace(/^"|"$/g, '');
  }
  return fields;
}

function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.split(/\r\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function parseStatusCode(statusLine: string): number {
  const normalized = statusLine.replace(/^HTTP ERROR 401/, '');
  const match = normalized.match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
  if (!match) {
    throw new Error(`Unable to parse recording-stream status line: ${statusLine}`);
  }
  return Number(match[1]);
}
