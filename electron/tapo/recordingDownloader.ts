import { once } from 'node:events';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { ffmpegBinaryPath } from './ffmpegPath';
import { createLogger } from '../log';

type EncryptionMethod = 'md5' | 'sha256';

export interface RecordingAudioOptions {
  codec: 'pcma' | 'pcmu';
  sampleRate: number;
}

interface DownloadRecordingOptions {
  host: string;
  username: string;
  hashedPassword: string;
  encryptionMethod: EncryptionMethod;
  userId: number;
  startTime: number;
  endTime: number;
  outputPath: string;
  audio?: RecordingAudioOptions;
  windowSize?: number;
}

interface RecordingPlaybackStreamOptions extends Omit<DownloadRecordingOptions, 'outputPath'> {
  outputDir: string;
  /** Seconds to skip at the start of the TS stream (workaround for cameras that ignore start_time on current-day recordings). */
  seekOffsetSec?: number;
}

export interface RecordingPlaybackJob {
  assetPath: string;
  ready: Promise<string>;
  completed: Promise<string>;
  cancel(): void;
}

interface MediaPart {
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
const PLAYBACK_READY_TIMEOUT_MS = 60_000;
const MIN_PLAYBACK_READY_BYTES = 256_000;
const MIN_PLAYBACK_GROWTH_BYTES = 50_000;
const FALLBACK_WINDOW_SIZE = 50;

class PesPacketReader {
  private payload: Buffer | null = null;
  private size = 0;

  constructor(private readonly streamType: number) {}

  setBuffer(size: number, buffer: Buffer): void {
    if (size === 0) {
      this.payload = null;
      this.size = 0;
      return;
    }

    this.size = size;
    this.payload = Buffer.from(buffer);
  }

  appendBuffer(buffer: Buffer): void {
    this.payload = this.payload ? Buffer.concat([this.payload, buffer]) : Buffer.from(buffer);
  }

  takeAudioPacket(): { codec: RecordingAudioOptions['codec']; payload: Buffer } | null {
    if (!this.payload) {
      return null;
    }

    const left = this.size - this.payload.length;
    if (left > 0) {
      return null;
    }

    if (left < 0) {
      this.payload = null;
      return null;
    }

    const optionalSize = this.payload[2] ?? 0;
    const audioPayload = Buffer.from(this.payload.subarray(3 + optionalSize));
    this.payload = null;

    if (this.streamType === 0x90) {
      return { codec: 'pcma', payload: audioPayload };
    }
    if (this.streamType === 0x91) {
      return { codec: 'pcmu', payload: audioPayload };
    }

    return null;
  }
}

class TsAudioReader {
  private buffer = Buffer.alloc(0);
  private pmtPid = 0;
  private pesReaders = new Map<number, PesPacketReader>();

  extractAudio(chunk: Buffer): { codec: RecordingAudioOptions['codec']; payload: Buffer } | null {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    let codec: RecordingAudioOptions['codec'] | null = null;
    const payloads: Buffer[] = [];

    while (this.buffer.length >= 188) {
      if (this.buffer[0] !== 0x47) {
        const syncIndex = this.buffer.indexOf(0x47, 1);
        if (syncIndex === -1) {
          this.buffer = Buffer.alloc(0);
          break;
        }
        this.buffer = this.buffer.subarray(syncIndex);
        continue;
      }

      const packet = this.buffer.subarray(0, 188);
      this.buffer = this.buffer.subarray(188);
      const extracted = this.processPacket(packet);
      if (!extracted) {
        continue;
      }
      if (codec === null) {
        codec = extracted.codec;
      }
      if (extracted.codec === codec) {
        payloads.push(extracted.payload);
      }
    }

    if (!codec || payloads.length === 0) {
      return null;
    }

    return { codec, payload: Buffer.concat(payloads) };
  }

  private processPacket(packet: Buffer): { codec: RecordingAudioOptions['codec']; payload: Buffer } | null {
    let offset = 1;
    const pid = ((packet[offset] & 0x1f) << 8) | packet[offset + 1];
    offset += 2;
    const flags = packet[offset];
    offset += 1;

    if (pid === 0x1fff) {
      return null;
    }

    if ((flags & 0x20) !== 0) {
      const adaptationLength = packet[offset] ?? 0;
      offset += 1 + adaptationLength;
      if (offset >= 188) {
        return null;
      }
    }

    const payload = packet.subarray(offset);
    if (pid === 0) {
      this.readPat(payload);
      return null;
    }

    if (pid === this.pmtPid) {
      this.readPmt(payload);
      return null;
    }

    const reader = this.pesReaders.get(pid);
    if (!reader) {
      return null;
    }

    if ((payload[0] ?? -1) === 0 && (payload[1] ?? -1) === 0 && (payload[2] ?? -1) === 1) {
      const size = payload.readUInt16BE(4);
      reader.setBuffer(size, payload.subarray(6));
    } else {
      reader.appendBuffer(payload);
    }

    return reader.takeAudioPacket();
  }

  private readPat(payload: Buffer): void {
    let offset = (payload[0] ?? 0) + 1;
    offset += 1;
    const sectionLength = payload.readUInt16BE(offset) & 0x03ff;
    offset += 2;
    const end = offset + sectionLength;
    offset += 5;

    while (offset + 4 <= end - 4) {
      const programNumber = payload.readUInt16BE(offset);
      offset += 2;
      const programPid = payload.readUInt16BE(offset) & 0x1fff;
      offset += 2;
      if (programNumber !== 0) {
        this.pmtPid = programPid;
      }
    }
  }

  private readPmt(payload: Buffer): void {
    let offset = (payload[0] ?? 0) + 1;
    offset += 1;
    const sectionLength = payload.readUInt16BE(offset) & 0x03ff;
    offset += 2;
    const end = offset + sectionLength;
    offset += 5;
    offset += 2;
    const programInfoLength = payload.readUInt16BE(offset) & 0x03ff;
    offset += 2 + programInfoLength;

    this.pesReaders.clear();
    while (offset + 5 <= end - 4) {
      const streamType = payload[offset];
      offset += 1;
      const elementaryPid = payload.readUInt16BE(offset) & 0x1fff;
      offset += 2;
      const infoLength = payload.readUInt16BE(offset) & 0x03ff;
      offset += 2 + infoLength;

      if (streamType === 0x90 || streamType === 0x91) {
        this.pesReaders.set(elementaryPid, new PesPacketReader(streamType));
      }
    }
  }
}

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

export async function downloadRecordingToMp4(options: DownloadRecordingOptions): Promise<string> {
  const log = createLogger(`recording:dl:${options.host}:${options.startTime}-${options.endTime}`);
  const retryWindowSizes = buildRetryWindowSizes(options.windowSize);
  log.info(`starting download, windowSizes=${retryWindowSizes.join(',')}`);

  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  const partialOutputPath = `${options.outputPath}.part`;
  if (fs.existsSync(options.outputPath)) {
    const existingSize = fs.statSync(options.outputPath).size;
    if (existingSize > 0) {
      log.info(`file already exists, returning cached`);
      return options.outputPath;
    }

    fs.rmSync(options.outputPath, { force: true });
    log.warn(`removed zero-byte cached file before retrying download`);
  }

  if (fs.existsSync(partialOutputPath)) {
    fs.rmSync(partialOutputPath, { force: true });
    log.warn(`removed stale partial download before retrying`);
  }

  let lastError: unknown = null;

  for (let attemptIndex = 0; attemptIndex < retryWindowSizes.length; attemptIndex += 1) {
    const windowSize = retryWindowSizes[attemptIndex];
    const session = new MediaSession(
      options.host,
      options.username || 'admin',
      options.hashedPassword,
      windowSize,
    );
    log.info(
      `connecting to media session (attempt ${attemptIndex + 1}/${retryWindowSizes.length}, windowSize=${windowSize})...`,
    );
    await session.start();
    log.info(`media session connected, starting stream...`);

    const ffmpegProc = spawn(ffmpegBinaryPath, buildDownloadFfmpegArgs(partialOutputPath, options.audio), {
      stdio: options.audio ? ['pipe', 'ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'],
    });
    const ffmpegStdin = ffmpegProc.stdin!;
    const audioInput = options.audio ? (ffmpegProc.stdio[3] as Writable | undefined) : undefined;
    const ffmpegStderr = ffmpegProc.stderr!;
    if (!ffmpegStdin) {
      throw new Error('ffmpeg stdin is not available for recording download');
    }

    // Absorb EPIPE errors (ffmpeg may exit while we still write)
    ffmpegStdin.on('error', () => {});
    audioInput?.on('error', () => {});

    const stderrChunks: Buffer[] = [];
    ffmpegStderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    let tsBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let totalDataChunks = 0;
    let totalBytes = 0;

    try {
      log.info(`starting media stream for userId=${options.userId}`);
      await session.streamRecording(options.userId, options.startTime, options.endTime, async (part) => {
        totalDataChunks++;
        totalBytes += part.plaintext.length;
        if (totalDataChunks % 50 === 0) {
          log.info(`received ${totalDataChunks} chunks, ${totalBytes} bytes`);
        }
        tsBuffer = await writeAlignedTsPackets(tsBuffer, part.plaintext, ffmpegStdin);
        if (audioInput && !audioInput.destroyed && part.audioPayload) {
          audioInput.write(part.audioPayload);
        }
      });

      log.info(`media stream ended, received ${totalDataChunks} chunks (${totalBytes} bytes)`);
      if (audioInput && !audioInput.destroyed) {
        audioInput.end();
      }
      ffmpegStdin.end();
      log.info(`waiting for ffmpeg to finish...`);
      const [exitCode] = (await once(ffmpegProc, 'close')) as [number | null];
      if (exitCode !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        throw new Error(stderr || `ffmpeg exited with code ${exitCode}`);
      }

      const partialStats = fs.statSync(partialOutputPath);
      if (partialStats.size <= 0) {
        throw new Error('ffmpeg created an empty recording file');
      }

      fs.renameSync(partialOutputPath, options.outputPath);

      log.info(`successfully saved to ${options.outputPath}`);
      return options.outputPath;
    } catch (error) {
      lastError = error;
      const msg = (error as Error)?.message ?? String(error);
      log.error(`failed: ${msg}, received ${totalDataChunks} chunks before error`);
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
      try {
        fs.rmSync(partialOutputPath, { force: true });
      } catch {
        /* ignore */
      }
      if (!isRetryableRecordingStreamError(msg) || attemptIndex >= retryWindowSizes.length - 1) {
        throw error;
      }
      log.warn(`retrying download with smaller window after retryable stream failure`);
    } finally {
      await session.close();
      log.info(`media session closed`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Unable to download recording stream');
}

export async function startRecordingDownloadToHls(
  options: RecordingPlaybackStreamOptions,
): Promise<RecordingPlaybackJob> {
  const log = createLogger(`recording:hls:${options.host}:${options.startTime}-${options.endTime}`);
  const assetPath = path.join(options.outputDir, 'stream.mp4');

  fs.rmSync(options.outputDir, { recursive: true, force: true });
  fs.mkdirSync(options.outputDir, { recursive: true });

  let cancelled = false;
  let activeFfmpegProc: ReturnType<typeof spawn> | null = null;
  let activeSession: MediaSession | null = null;

  const closeActiveSession = async () => {
    const sessionToClose = activeSession;
    activeSession = null;
    if (!sessionToClose) {
      return;
    }
    try {
      await sessionToClose.close();
    } catch {
      /* ignore */
    }
  };

  const stopActiveFfmpeg = () => {
    const ffmpegToKill = activeFfmpegProc;
    activeFfmpegProc = null;
    if (!ffmpegToKill) {
      return;
    }
    try {
      if (!ffmpegToKill.killed) {
        ffmpegToKill.kill('SIGKILL');
      }
    } catch {
      /* ignore */
    }
  };

  const retryWindowSizes = buildRetryWindowSizes(options.windowSize);

  const runAttempt = async (withAudio: boolean, windowSize: number): Promise<void> => {
    const session = new MediaSession(
      options.host,
      options.username || 'admin',
      options.hashedPassword,
      windowSize,
    );
    activeSession = session;
    await session.start();

    const ffmpegArgs = buildPlaybackFfmpegArgs(
      assetPath,
      withAudio ? options.audio : undefined,
      options.seekOffsetSec,
    );

    const ffmpegProc = spawn(ffmpegBinaryPath, ffmpegArgs, {
      stdio: withAudio && options.audio ? ['pipe', 'ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'],
    });

    activeFfmpegProc = ffmpegProc;
    const ffmpegStdin = ffmpegProc.stdin!;
    const audioInput = withAudio && options.audio ? (ffmpegProc.stdio[3] as Writable | undefined) : undefined;
    const ffmpegStderr = ffmpegProc.stderr!;
    if (!ffmpegStdin) {
      throw new Error('ffmpeg stdin is not available for recording playback');
    }

    // Absorb EPIPE errors (ffmpeg may exit while we still write)
    ffmpegStdin.on('error', () => {});
    audioInput?.on('error', () => {});

    const stderrChunks: Buffer[] = [];
    ffmpegStderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    let tsBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let receivedAudioData = false;

    try {
      await session.streamRecording(options.userId, options.startTime, options.endTime, async (part) => {
        if (ffmpegProc.exitCode !== null || ffmpegStdin.destroyed) {
          throw new Error('ffmpeg exited early during progressive playback');
        }

        tsBuffer = await writeAlignedTsPackets(tsBuffer, part.plaintext, ffmpegStdin);
        if (audioInput && !audioInput.destroyed && part.audioPayload) {
          receivedAudioData = true;
          audioInput.write(part.audioPayload);
        }
      });

      if (tsBuffer.length >= 188 && !ffmpegStdin.destroyed) {
        tsBuffer = await writeAlignedTsPackets(tsBuffer, Buffer.alloc(0), ffmpegStdin);
      }

      if (audioInput && !audioInput.destroyed) {
        if (!receivedAudioData && withAudio) {
          log.warn(`no audio data received, closing audio pipe`);
        }
        audioInput.end();
      }
      if (!ffmpegStdin.destroyed) {
        ffmpegStdin.end();
      }

      const [exitCode] = (await once(ffmpegProc, 'close')) as [number | null];
      if (cancelled) {
        throw new Error('Recording playback cancelled');
      }
      if (exitCode !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        throw new Error(stderr || `ffmpeg exited with code ${exitCode}`);
      }

      if (!fs.existsSync(assetPath)) {
        log.error(`output file NOT created: ${assetPath}`);
      }
    } finally {
      stopActiveFfmpeg();
      await closeActiveSession();
    }
  };

  const runAttemptWithRetry = async (withAudio: boolean): Promise<void> => {
    let lastError: unknown = null;

    for (let attemptIndex = 0; attemptIndex < retryWindowSizes.length; attemptIndex += 1) {
      const windowSize = retryWindowSizes[attemptIndex];
      try {
        await runAttempt(withAudio, windowSize);
        return;
      } catch (error) {
        lastError = error;
        const message = (error as Error)?.message ?? String(error);
        try {
          fs.rmSync(assetPath, { force: true });
        } catch {
          /* ignore */
        }
        if (!isRetryableRecordingStreamError(message) || attemptIndex >= retryWindowSizes.length - 1) {
          throw error;
        }
        log.warn(`retrying progressive playback with smaller window after retryable stream failure`);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Unable to start recording playback stream');
  };

  const ready = waitForPlaybackFileReady(assetPath, PLAYBACK_READY_TIMEOUT_MS, log);

  const completed = (async () => {
    try {
      try {
        await runAttemptWithRetry(true);
      } catch (error) {
        if (cancelled) {
          throw error;
        }

        const message = (error as Error)?.message ?? String(error);
        log.warn(`audio+video playback failed: ${message}, falling back to video-only`);
        try {
          fs.rmSync(assetPath, { force: true });
        } catch {
          /* ignore */
        }

        try {
          await runAttemptWithRetry(false);
        } catch {
          log.warn(`video-only playback also failed, using audio+video error`);
          throw error;
        }
      }

      return assetPath;
    } catch (error) {
      const msg = (error as Error)?.message ?? String(error);
      log.error(`failed: ${msg}`);
      throw error;
    } finally {
      stopActiveFfmpeg();
      await closeActiveSession();
    }
  })();

  completed.catch(() => {
    if (!cancelled) {
      try {
        fs.rmSync(options.outputDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  return {
    assetPath,
    ready,
    completed,
    cancel() {
      cancelled = true;
      try {
        const stdin = activeFfmpegProc?.stdin;
        if (stdin && !stdin.destroyed) {
          stdin.destroy();
        }
      } catch {
        /* ignore */
      }
      stopActiveFfmpeg();
      void closeActiveSession();
    },
  };
}

function waitForPlaybackFileReady(
  filePath: string,
  timeoutMs: number,
  log: ReturnType<typeof createLogger>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let lastSize = 0;
    let lastCheckTime = start;
    let checkCount = 0;

    const check = () => {
      checkCount++;
      try {
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          const currentSize = stats.size;
          const currentTime = Date.now();
          const isGrowing = currentSize > lastSize;

          // Resolve if we hit the main threshold
          if (currentSize >= MIN_PLAYBACK_READY_BYTES) {
            log.info(`playback file is ready (${currentSize} bytes)`);
            resolve(filePath);
            return;
          }

          // Or if file exists, has some data, and is actively growing
          if (currentSize >= MIN_PLAYBACK_GROWTH_BYTES && isGrowing && currentTime - lastCheckTime >= 400) {
            log.info(`playback file is growing (${currentSize} bytes), starting playback`);
            resolve(filePath);
            return;
          }

          lastSize = currentSize;
          if (isGrowing) {
            lastCheckTime = currentTime;
          }
        }
      } catch (e) {
        log.error(`file check error: ${(e as Error)?.message}`);
      }

      if (Date.now() - start >= timeoutMs) {
        log.error(`file check timed out after ${checkCount} checks, ${Date.now() - start}ms`);
        reject(new Error('Timed out waiting for recording playback to become ready'));
        return;
      }

      setTimeout(check, 200);
    };

    check();
  });
}

export function buildDownloadFfmpegArgs(outputPath: string, audio?: RecordingAudioOptions): string[] {
  const args = ['-loglevel', 'error', '-y'];

  args.push('-f', 'mpegts', '-i', 'pipe:0');

  if (audio) {
    args.push(
      '-analyzeduration',
      '0',
      '-probesize',
      '32',
      '-f',
      audio.codec === 'pcmu' ? 'mulaw' : 'alaw',
      '-ar',
      String(audio.sampleRate),
      '-ac',
      '1',
      '-i',
      'pipe:3',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
    );
  } else {
    args.push('-c', 'copy');
  }

  args.push('-movflags', '+faststart', outputPath);
  return args;
}

export function buildPlaybackFfmpegArgs(
  outputPath: string,
  audio?: RecordingAudioOptions,
  seekOffsetSec?: number,
): string[] {
  const args = [
    '-loglevel',
    'error',
    '-y',
    '-fflags',
    '+genpts+discardcorrupt',
    '-err_detect',
    'ignore_err',
    '-analyzeduration',
    '1000000',
    '-probesize',
    '1000000',
  ];

  if (typeof seekOffsetSec === 'number' && seekOffsetSec > 0) {
    args.push('-ss', String(seekOffsetSec));
  }

  args.push('-f', 'mpegts', '-i', 'pipe:0');

  if (audio) {
    args.push(
      '-analyzeduration',
      '0',
      '-probesize',
      '32',
      '-f',
      audio.codec === 'pcmu' ? 'mulaw' : 'alaw',
      '-ar',
      String(audio.sampleRate),
      '-ac',
      '1',
      '-i',
      'pipe:3',
    );
  }

  args.push(
    '-map',
    '0:v:0',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '50',
    '-sc_threshold',
    '0',
  );

  if (audio) {
    args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k');
  }

  args.push('-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', outputPath);
  return args;
}

export function buildRetryWindowSizes(windowSize?: number): number[] {
  const values = new Set<number>();
  values.add(
    typeof windowSize === 'number' && Number.isFinite(windowSize) && windowSize > 0 ? windowSize : 200,
  );
  values.add(FALLBACK_WINDOW_SIZE);
  return Array.from(values);
}

function isRetryableRecordingStreamError(message: string): boolean {
  return (
    message.includes('Camera closed the recording stream unexpectedly') ||
    message.includes('Timed out waiting for recording data from camera') ||
    message.includes('ffmpeg created an empty recording file')
  );
}

export async function writeAlignedTsPackets(
  buffer: Buffer,
  chunk: Buffer,
  writable: Writable,
): Promise<Buffer> {
  let nextBuffer = chunk.length > 0 ? Buffer.concat([buffer, chunk]) : buffer;

  while (nextBuffer.length >= 188 && nextBuffer[0] !== 0x47) {
    const syncIndex = nextBuffer.indexOf(0x47, 1);
    if (syncIndex === -1) {
      return Buffer.alloc(0);
    }
    nextBuffer = nextBuffer.subarray(syncIndex);
  }

  while (nextBuffer.length >= 188) {
    if (writable.destroyed) break;
    const packet = nextBuffer.subarray(0, 188);
    nextBuffer = nextBuffer.subarray(188);
    writable.write(packet);
  }

  return nextBuffer;
}

export function parseDigestFields(value: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const regex = /(\w+)=("[^"]*"|[^,\s]+)/g;
  for (const match of value.matchAll(regex)) {
    const rawKey = match[1];
    const rawValue = match[2];
    fields[rawKey.trim()] = rawValue.trim().replace(/^"|"$/g, '');
  }
  return fields;
}

export function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.split(/\r\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

export function getHeader(headers: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = headers[name.toLowerCase()];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function parseStatusCode(statusLine: string): number {
  const normalized = statusLine.replace(/^HTTP ERROR 401/, '');
  const match = normalized.match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
  if (!match) {
    throw new Error(`Unable to parse recording-stream status line: ${statusLine}`);
  }
  return Number(match[1]);
}
