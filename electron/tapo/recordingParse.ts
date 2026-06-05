/**
 * Pure Tapo response-parsing helpers.
 *
 * These functions normalise the various firmware-shape response payloads into
 * the canonical `Recording` / `RecordingEvent` shapes. They are intentionally
 * dependency-free (type-only import of the shared types) and side-effect-free
 * so they can be imported and unit-tested without pulling in Electron, ffmpeg,
 * sockets, or any other runtime machinery.
 */

import type { Recording, RecordingEvent } from '../types';

export interface ApiResponse {
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

export function normalizeBase64(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = normalized.length % 4;
  if (remainder === 0) return normalized;
  return normalized + '='.repeat(4 - remainder);
}

export function extractRecordingsFromResponse(resp: ApiResponse): Recording[] {
  const toMsRange = (value: unknown): Recording | null => {
    if (!value || typeof value !== 'object') return null;

    const rec = value as {
      startTime?: unknown;
      endTime?: unknown;
      start_time?: unknown;
      end_time?: unknown;
    };

    const startRaw = rec.startTime ?? rec.start_time;
    const endRaw = rec.endTime ?? rec.end_time;
    if (typeof startRaw !== 'number' || typeof endRaw !== 'number') {
      return null;
    }

    // Camera APIs return seconds for playback windows; normalize to ms.
    const startMs = startRaw < 10_000_000_000 ? startRaw * 1000 : startRaw;
    const endMs = endRaw < 10_000_000_000 ? endRaw * 1000 : endRaw;

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return null;
    }

    return { startTime: startMs, endTime: endMs };
  };

  const collectRanges = (items: unknown[]): Recording[] => {
    const ranges: Recording[] = [];
    for (const item of items) {
      const direct = toMsRange(item);
      if (direct) {
        ranges.push(direct);
        continue;
      }

      if (item && typeof item === 'object') {
        for (const value of Object.values(item)) {
          const nested = toMsRange(value);
          if (nested) {
            ranges.push(nested);
          }
        }
      }
    }
    return ranges;
  };

  const sub = (resp.result?.responses ?? [])[0] as
    | {
        result?: {
          video?: { video_info?: Array<{ startTime?: number; endTime?: number }> };
          playback?: {
            search_video_results?: Array<Record<string, { startTime?: number; endTime?: number }>>;
            search_video_with_utc?: {
              search_video_results?: Array<Record<string, { startTime?: number; endTime?: number }>>;
            };
          };
          search_video_results?: Array<Record<string, { startTime?: number; endTime?: number }>>;
        };
      }
    | undefined;

  const topResult = (resp.result ?? {}) as {
    video?: { video_info?: Array<{ startTime?: number; endTime?: number }> };
    playback?: {
      search_video_results?: Array<Record<string, { startTime?: number; endTime?: number }>>;
      search_video_with_utc?: {
        search_video_results?: Array<Record<string, { startTime?: number; endTime?: number }>>;
      };
    };
    search_video_results?: Array<Record<string, { startTime?: number; endTime?: number }>>;
  };

  const byVideoInfo = [...(topResult.video?.video_info ?? []), ...(sub?.result?.video?.video_info ?? [])];
  const fromVideoInfo = collectRanges(byVideoInfo);

  if (fromVideoInfo.length > 0) return fromVideoInfo;

  const nestedSearch =
    topResult.playback?.search_video_results ??
    topResult.playback?.search_video_with_utc?.search_video_results ??
    topResult.search_video_results ??
    sub?.result?.playback?.search_video_results ??
    sub?.result?.playback?.search_video_with_utc?.search_video_results ??
    sub?.result?.search_video_results ??
    [];

  const flattened = collectRanges(nestedSearch);
  if (flattened.length > 0) {
    return flattened;
  }

  // Last-chance parse from top-level result object values when firmware omits expected wrappers.
  const fromTopLevelValues = collectRanges(Object.values(topResult));
  return fromTopLevelValues;
}

export function extractRecordingEventsFromResponse(
  resp: ApiResponse,
  timeCorrection: number,
): RecordingEvent[] {
  const parseAlarmType = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      return Number(value);
    }
    return undefined;
  };

  const toEvent = (value: unknown): RecordingEvent | null => {
    if (!value || typeof value !== 'object') return null;

    const event = value as {
      startTime?: unknown;
      endTime?: unknown;
      start_time?: unknown;
      end_time?: unknown;
      alarm_type?: unknown;
    };

    const startRaw = event.startTime ?? event.start_time;
    const endRaw = event.endTime ?? event.end_time;
    if (typeof startRaw !== 'number' || typeof endRaw !== 'number') {
      return null;
    }

    const startSec = startRaw < 10_000_000_000 ? startRaw + timeCorrection : Math.floor(startRaw / 1000);
    const endSec = endRaw < 10_000_000_000 ? endRaw + timeCorrection : Math.floor(endRaw / 1000);
    const startTime = startSec * 1000;
    const endTime = endSec * 1000;
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
      return null;
    }

    return {
      startTime,
      endTime,
      alarmType: parseAlarmType(event.alarm_type),
    };
  };

  const collectEvents = (items: unknown[]): RecordingEvent[] => {
    const events: RecordingEvent[] = [];
    for (const item of items) {
      const direct = toEvent(item);
      if (direct) {
        events.push(direct);
        continue;
      }

      if (item && typeof item === 'object') {
        for (const nestedValue of Object.values(item)) {
          const nested = toEvent(nestedValue);
          if (nested) {
            events.push(nested);
          }
        }
      }
    }
    return events;
  };

  const topResult = (resp.result ?? {}) as {
    playback?: { search_detection_list?: unknown[] };
  };
  const nestedResult = (
    resp.result.responses?.[0] as
      | {
          result?: { playback?: { search_detection_list?: unknown[] } };
        }
      | undefined
  )?.result;

  const candidates =
    topResult.playback?.search_detection_list ?? nestedResult?.playback?.search_detection_list ?? [];
  return collectEvents(candidates);
}

export function firstResponseErrorCode(resp: ApiResponse): number | undefined {
  const firstResponse = resp.result?.responses?.[0] as { error_code?: unknown } | undefined;
  return typeof firstResponse?.error_code === 'number' ? firstResponse.error_code : undefined;
}

export function extractUserIdFromResponse(resp: ApiResponse): number | null {
  const asNumber = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
    return null;
  };

  const direct = (resp.result as { user_id?: unknown }).user_id;
  const directNum = asNumber(direct);
  if (directNum != null) {
    return directNum;
  }

  const nested = (resp.result.responses?.[0] as { result?: { user_id?: unknown } } | undefined)?.result
    ?.user_id;
  const nestedNum = asNumber(nested);
  if (nestedNum != null) {
    return nestedNum;
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
    return systemUserId;
  }

  const systemId = asNumber(systemNested?.id);
  if (systemId != null) {
    return systemId;
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
    return multiResponseUserIdNum;
  }

  return null;
}
