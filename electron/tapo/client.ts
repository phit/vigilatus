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

import os from 'node:os';
import path from 'node:path';
import type { Recording, RecordingEvent } from '../types';
import {
  downloadRecordingToMp4,
  startRecordingDownloadToHls,
  type RecordingPlaybackJob,
} from './recordingDownloader';
import type { RecordingAudioOptions } from './recordingAudio';
import {
  type ApiResponse,
  extractRecordingEventsFromResponse,
  extractRecordingsFromResponse,
  firstResponseErrorCode,
} from './recordingParse';
import { TapoSession } from './tapoSession';
import { createLogger } from '../log';

const MAX_LOGIN_RETRIES = 2;
const PLAYBACK_PADDING_SECONDS = 5;
const DEFAULT_PLAYBACK_USER_IDS = [1, 0] as const;
const STALE_USER_ID_ERROR_CODES = new Set([-71103, -71105]);

interface TapoClientConfig {
  host: string;
  username: string;
  password: string;
}

// ---------------------------------------------------------------------------
// TapoClient
// ---------------------------------------------------------------------------

export class TapoClient {
  private static readonly userIdCache = new Map<string, number>();

  private readonly host: string;
  private readonly username: string;
  private readonly session: TapoSession;
  private cachedUserId?: number;

  constructor(cfg: TapoClientConfig) {
    this.host = cfg.host;
    this.username = cfg.username || 'admin';
    this.session = new TapoSession(cfg);

    const cachedUserId = TapoClient.userIdCache.get(this.userIdCacheKey());
    if (typeof cachedUserId === 'number') {
      this.cachedUserId = cachedUserId;
    }
  }

  private userIdCacheKey(): string {
    return `${this.host}\u0000${this.username}\u0000${this.session.hashedMd5}`;
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
    return this.session.testConnection();
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

    const directResp = await this.session.apiRequest({
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

    const nestedResp = await this.session.apiRequest({
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

    const resp = await this.session.apiRequest({
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
    const directRefreshedUserId = await this.maybeRefreshStaleUserId(resp, userId);
    if (directRefreshedUserId !== undefined) {
      return this.queryRecordingsForDate(date, directRefreshedUserId);
    }

    // pytapo-compatible shape used by several firmware variants.
    const legacyResp = await this.session.apiRequest({
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
    const legacyRefreshedUserId = await this.maybeRefreshStaleUserId(legacyResp, userId);
    if (legacyRefreshedUserId !== undefined) {
      return this.queryRecordingsForDate(date, legacyRefreshedUserId);
    }

    // Some firmware/timezone combinations return empty day results but work with UTC range search.
    const utcFallback = await this.searchRecordingsWithUtcRange(date, userId);
    return utcFallback;
  }

  private async searchDatesWithVideo(date: string): Promise<string[]> {
    const resp = await this.session.apiRequest({
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

    const encryptionMethod = this.session.passwordMethod ?? 'md5';
    const hashedPassword = this.session.getHashedPassword();
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

  private async getUserId(retryCount = 0): Promise<number> {
    if (retryCount === 0 && this.cachedUserId !== undefined) {
      return this.cachedUserId;
    }
    const resp = await this.session.apiRequest({
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
      this.session.clearSession();
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
      this.session.clearSession();
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
      const resp = await this.session.apiRequest({
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
      const resp = await this.session.apiRequest({
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

  /**
   * When a recordings query came back with a stale-user-id error code, resolve a
   * fresh playback user id to retry with. Returns the new id (only when it
   * differs from the one already tried) or undefined when no retry is warranted.
   */
  private async maybeRefreshStaleUserId(
    resp: ApiResponse,
    userId: number | undefined,
  ): Promise<number | undefined> {
    if (
      typeof userId !== 'number' ||
      !STALE_USER_ID_ERROR_CODES.has(firstResponseErrorCode(resp) ?? Number.NaN)
    ) {
      return undefined;
    }
    const refreshedUserId = await this.tryResolvePlaybackUserId(true);
    return typeof refreshedUserId === 'number' && refreshedUserId !== userId ? refreshedUserId : undefined;
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

      const resp = await this.session.apiRequest({
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
      const refreshedUserId = await this.maybeRefreshStaleUserId(resp, userId);
      if (refreshedUserId !== undefined) {
        return this.searchRecordingsWithUtcRange(date, refreshedUserId);
      }

      const legacyUtcResp = await this.session.apiRequest({
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
      if (legacyParsed.length === 0) {
        const refreshedUserId = await this.maybeRefreshStaleUserId(legacyUtcResp, userId);
        if (refreshedUserId !== undefined) {
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
}
