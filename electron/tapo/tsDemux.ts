import type { Writable } from 'node:stream';
import type { RecordingAudioOptions } from './recordingAudio';

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

export class TsAudioReader {
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
