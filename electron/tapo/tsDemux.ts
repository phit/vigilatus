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

/**
 * Identify the video codec from the PAT/PMT of an MPEG-TS byte stream:
 * `'h264'` (stream_type 0x1B), `'hevc'` (0x24), another stream_type as
 * `'0xNN'`, or `null` if no PMT with a video stream was found.
 */
export function detectTsVideoCodec(data: Buffer): string | null {
  let pmtPid = -1;
  let offset = data.indexOf(0x47);
  while (offset >= 0 && offset + 188 <= data.length) {
    if (data[offset] !== 0x47) {
      offset = data.indexOf(0x47, offset + 1);
      continue;
    }
    const packet = data.subarray(offset, offset + 188);
    offset += 188;

    const payloadStart = (packet[1] & 0x40) !== 0;
    const pid = ((packet[1] & 0x1f) << 8) | packet[2];
    if (!payloadStart || (pid !== 0 && pid !== pmtPid)) continue;

    let pos = 4;
    if ((packet[3] & 0x20) !== 0) pos += 1 + packet[4];
    pos += 1 + (packet[pos] ?? 0); // pointer_field
    if (pos + 8 > 188) continue;
    const sectionLength = ((packet[pos + 1] & 0x0f) << 8) | packet[pos + 2];
    const end = Math.min(pos + 3 + sectionLength - 4, 188); // exclude CRC

    if (pid === 0) {
      for (let p = pos + 8; p + 4 <= end; p += 4) {
        const programNumber = packet.readUInt16BE(p);
        if (programNumber !== 0) {
          pmtPid = packet.readUInt16BE(p + 2) & 0x1fff;
          break;
        }
      }
      continue;
    }

    if (pos + 12 > 188) continue;
    const programInfoLength = packet.readUInt16BE(pos + 10) & 0x0fff;
    for (let p = pos + 12 + programInfoLength; p + 5 <= end;) {
      const streamType = packet[p];
      const infoLength = packet.readUInt16BE(p + 3) & 0x0fff;
      p += 5 + infoLength;
      if (streamType === 0x1b) return 'h264';
      if (streamType === 0x24) return 'hevc';
      // 0x02 = MPEG-2 video, 0x10 = MPEG-4 Part 2; Tapo audio uses 0x90/0x91.
      if (streamType === 0x02 || streamType === 0x10) return `0x${streamType.toString(16)}`;
    }
  }
  return null;
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
