import { once } from 'node:events';
import crypto from 'node:crypto';
import net from 'node:net';
import { createLogger } from '../log';
import type { RecordingAudioOptions } from './recordingAudio';
import { TsAudioReader } from './tsDemux';
import { getHeader, parseDigestFields, parseHeaders, parseStatusCode } from './httpParse';

export type EncryptionMethod = 'md5' | 'sha256';

export interface MediaPart {
  mimetype: string;
  encrypted: boolean;
  headers: Record<string, string>;
  plaintext: Buffer;
  audioPayload?: Buffer;
  audioPayloadType?: RecordingAudioOptions['codec'];
  seq?: number;
  sessionId?: number;
  json?: Record<string, unknown>;
}

const DEFAULT_CLIENT_BOUNDARY = '--client-stream-boundary--';
const DEFAULT_DEVICE_BOUNDARY = '--device-stream-boundary--';
const NO_DATA_TIMEOUT_MS = 20_000;

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

export function hashMediaPassword(password: string, method: EncryptionMethod = 'md5'): string {
  if (method === 'sha256') {
    return crypto.createHash('sha256').update(password).digest('hex').toUpperCase();
  }
  return crypto.createHash('md5').update(password).digest('hex').toUpperCase();
}

export class MediaSession {
  private readonly socket: net.Socket;
  private readonly reader: BufferedSocketReader;
  private readonly clientBoundary = DEFAULT_CLIENT_BOUNDARY;
  private deviceBoundary = DEFAULT_DEVICE_BOUNDARY;
  private cipher: MediaCipher | null = null;
  private readonly windowSize: number;
  private readonly tsAudioReader = new TsAudioReader();

  constructor(
    private readonly host: string,
    private readonly username: string,
    private readonly hashedPassword: string,
    windowSize = 200,
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
    const authenticateHeader = getHeader(firstHeaders, 'www-authenticate');
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
    const keyExchange = getHeader(okHeaders, 'key-exchange', 'x-key-exchange', 'key_exchange');
    if (keyExchange) {
      this.cipher = new MediaCipher(keyExchange, this.hashedPassword);
    } else {
      // Some firmware variants serve plaintext media parts and omit key-exchange.
      this.cipher = null;
    }

    const contentType = getHeader(okHeaders, 'content-type') ?? '';
    const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
    if (boundaryMatch?.[1]) {
      this.deviceBoundary = boundaryMatch[1].trim();
    }
  }

  async close(): Promise<void> {
    this.socket.destroy();
  }

  async streamPreview(
    onPart: (part: MediaPart) => Promise<void>,
    options?: { quality?: string },
  ): Promise<void> {
    const payload = JSON.stringify({
      type: 'request',
      seq: crypto.randomInt(1000, 0x7fff),
      params: {
        preview: {
          channels: [0],
          resolutions: [options?.quality ?? 'HD'],
          audio: ['default'],
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
      let part: MediaPart;
      try {
        part = await this.readPart();
      } catch (error) {
        const msg = String((error as Error)?.message ?? error ?? '');
        if (msg.includes('Camera closed')) break;
        throw error;
      }

      if (part.sessionId !== undefined) sessionId = part.sessionId;

      if (
        part.seq !== undefined &&
        sessionId !== undefined &&
        part.seq > 0 &&
        part.seq % this.windowSize === 0
      ) {
        await this.sendAck(sessionId, this.windowSize * Math.floor(part.seq / this.windowSize));
      }

      if (part.mimetype === 'video/mp2t') {
        await onPart(part);
        continue;
      }

      if (part.mimetype !== 'application/json' || !part.json) continue;

      const params = (part.json.params ?? {}) as Record<string, unknown>;
      if (typeof params.session_id === 'number') sessionId = params.session_id;
      if (params.event_type === 'stream_status' && params.status === 'finished') break;
    }
  }

  async streamRecording(
    userId: number,
    startTime: number,
    endTime: number,
    onPart: (part: MediaPart) => Promise<void>,
  ): Promise<void> {
    const payload = JSON.stringify({
      type: 'request',
      seq: crypto.randomInt(1000, 0x7fff),
      params: {
        playback: {
          client_id: userId,
          channels: [0],
          scale: '1/1',
          start_time: String(startTime),
          end_time: String(endTime),
          event_type: [1, 2],
        },
        method: 'get',
      },
    });

    createLogger('streamRecording').info(
      `sending playback request:` +
        ` userId=${userId}` +
        ` start_time=${startTime} (${new Date(startTime * 1000).toISOString()})` +
        ` end_time=${endTime} (${new Date(endTime * 1000).toISOString()})`,
    );

    await this.writeMultipart(Buffer.from(payload, 'utf8'), {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload)),
      'X-Data-Window-Size': String(this.windowSize),
    });

    let sessionId: number | undefined;
    let receivedVideo = false;
    let receivedAnyPart = false;

    while (true) {
      let part: MediaPart;
      try {
        part = await this.readPart();
      } catch (error) {
        const msg = String((error as Error)?.message ?? error ?? '');
        if (
          msg.includes('Camera closed the recording stream unexpectedly') &&
          (receivedVideo || receivedAnyPart)
        ) {
          break;
        }
        throw error;
      }

      receivedAnyPart = true;
      if (part.sessionId !== undefined) {
        sessionId = part.sessionId;
      }

      if (
        part.seq !== undefined &&
        sessionId !== undefined &&
        part.seq > 0 &&
        part.seq % this.windowSize === 0
      ) {
        await this.sendAck(sessionId, this.windowSize * Math.floor(part.seq / this.windowSize));
      }

      if (part.mimetype === 'video/mp2t') {
        receivedVideo = true;
        await onPart(part);
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
    const payload = Buffer.from(
      JSON.stringify({
        type: 'notification',
        params: { event_type: 'stream_sequence' },
      }),
      'utf8',
    );

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
    const headerText = headerBlock
      .subarray(0, headerBlock.length - 4)
      .toString('utf8')
      .trim();
    const headers = parseHeaders(headerText);
    const mimetype = getHeader(headers, 'content-type') ?? 'application/octet-stream';
    const contentLength = Number(getHeader(headers, 'content-length') ?? '0');
    const encrypted = getHeader(headers, 'x-if-encrypt') === '1';
    const ciphertext = await this.reader.readExactly(contentLength, NO_DATA_TIMEOUT_MS);

    let plaintext = ciphertext;
    if (encrypted) {
      if (!this.cipher) {
        throw new Error('Recording stream is encrypted but camera did not provide key-exchange data');
      }
      plaintext = this.cipher.decrypt(ciphertext);
    }

    let json: Record<string, unknown> | undefined;
    let audioPayload: Buffer | undefined;
    let audioPayloadType: RecordingAudioOptions['codec'] | undefined;
    const seqHeader = getHeader(headers, 'x-data-sequence');
    const sessionHeader = getHeader(headers, 'x-session-id');
    let seq = seqHeader ? Number(seqHeader) : undefined;
    let sessionId = sessionHeader ? Number(sessionHeader) : undefined;

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
    } else if (mimetype === 'video/mp2t') {
      const extractedAudio = this.tsAudioReader.extractAudio(plaintext);
      if (extractedAudio) {
        audioPayload = extractedAudio.payload;
        audioPayloadType = extractedAudio.codec;
      }
    }

    return {
      mimetype,
      encrypted,
      headers,
      plaintext,
      audioPayload,
      audioPayloadType,
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
