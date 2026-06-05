import { describe, expect, it } from 'vitest';
import {
  type ApiResponse,
  extractRecordingEventsFromResponse,
  extractRecordingsFromResponse,
  extractUserIdFromResponse,
  firstResponseErrorCode,
  normalizeBase64,
} from '../electron/tapo/recordingParse';

/** Wraps a `result` payload in the minimal ApiResponse envelope the parsers expect. */
function resp(result: Record<string, unknown>): ApiResponse {
  return { error_code: 0, result } as ApiResponse;
}

describe('extractRecordingsFromResponse', () => {
  it('reads top-level result.video.video_info[] and normalises seconds to ms', () => {
    // 1000s -> 1_000_000ms, 2000s -> 2_000_000ms (both < 10e9 so treated as seconds).
    const out = extractRecordingsFromResponse(
      resp({ video: { video_info: [{ startTime: 1000, endTime: 2000 }] } }),
    );
    expect(out).toEqual([{ startTime: 1_000_000, endTime: 2_000_000 }]);
  });

  it('reads nested responses[0].result.video.video_info[]', () => {
    const out = extractRecordingsFromResponse(
      resp({
        responses: [
          { method: 'm', error_code: 0, result: { video: { video_info: [{ startTime: 5, endTime: 9 }] } } },
        ],
      }),
    );
    // 5s -> 5000ms, 9s -> 9000ms.
    expect(out).toEqual([{ startTime: 5000, endTime: 9000 }]);
  });

  it('keeps values >= 10_000_000_000 as ms (no x1000) and treats the boundary as ms', () => {
    const start = 10_000_000_000; // exactly the boundary: NOT < boundary, kept as ms.
    const end = 10_000_001_000;
    const out = extractRecordingsFromResponse(
      resp({ video: { video_info: [{ startTime: start, endTime: end }] } }),
    );
    expect(out).toEqual([{ startTime: start, endTime: end }]);
  });

  it('accepts snake_case start_time/end_time keys', () => {
    const out = extractRecordingsFromResponse(
      resp({ video: { video_info: [{ start_time: 1000, end_time: 2000 }] } }),
    );
    expect(out).toEqual([{ startTime: 1_000_000, endTime: 2_000_000 }]);
  });

  it('reads playback.search_video_results[] with records nested one object level deep', () => {
    // Each entry is an object whose VALUE is the range (the collectRanges inner-object walk).
    const out = extractRecordingsFromResponse(
      resp({
        playback: {
          search_video_results: [{ '0': { startTime: 1000, endTime: 2000 } }],
        },
      }),
    );
    expect(out).toEqual([{ startTime: 1_000_000, endTime: 2_000_000 }]);
  });

  it('reads playback.search_video_with_utc.search_video_results[]', () => {
    const out = extractRecordingsFromResponse(
      resp({
        playback: {
          search_video_with_utc: {
            search_video_results: [{ '0': { startTime: 1000, endTime: 2000 } }],
          },
        },
      }),
    );
    expect(out).toEqual([{ startTime: 1_000_000, endTime: 2_000_000 }]);
  });

  it('reads top-level result.search_video_results[]', () => {
    const out = extractRecordingsFromResponse(
      resp({ search_video_results: [{ '0': { startTime: 1000, endTime: 2000 } }] }),
    );
    expect(out).toEqual([{ startTime: 1_000_000, endTime: 2_000_000 }]);
  });

  it('reads nested responses[0].result.playback.search_video_results[]', () => {
    const out = extractRecordingsFromResponse(
      resp({
        responses: [
          {
            method: 'm',
            error_code: 0,
            result: { playback: { search_video_results: [{ '0': { startTime: 1000, endTime: 2000 } }] } },
          },
        ],
      }),
    );
    expect(out).toEqual([{ startTime: 1_000_000, endTime: 2_000_000 }]);
  });

  it('reads nested responses[0].result.playback.search_video_with_utc.search_video_results[]', () => {
    const out = extractRecordingsFromResponse(
      resp({
        responses: [
          {
            method: 'm',
            error_code: 0,
            result: {
              playback: {
                search_video_with_utc: {
                  search_video_results: [{ '0': { startTime: 1000, endTime: 2000 } }],
                },
              },
            },
          },
        ],
      }),
    );
    expect(out).toEqual([{ startTime: 1_000_000, endTime: 2_000_000 }]);
  });

  it('reads nested responses[0].result.search_video_results[]', () => {
    const out = extractRecordingsFromResponse(
      resp({
        responses: [
          {
            method: 'm',
            error_code: 0,
            result: { search_video_results: [{ '0': { startTime: 1000, endTime: 2000 } }] },
          },
        ],
      }),
    );
    expect(out).toEqual([{ startTime: 1_000_000, endTime: 2_000_000 }]);
  });

  it('collects a directly-shaped range item (no inner-object wrapper)', () => {
    const out = extractRecordingsFromResponse(
      resp({ search_video_results: [{ startTime: 1000, endTime: 2000 }] }),
    );
    expect(out).toEqual([{ startTime: 1_000_000, endTime: 2_000_000 }]);
  });

  it('falls back to walking top-level result object values when wrappers are absent', () => {
    // No video_info / search_video_results: last-chance parse over Object.values(topResult).
    const out = extractRecordingsFromResponse(resp({ some_window: { startTime: 1000, endTime: 2000 } }));
    expect(out).toEqual([{ startTime: 1_000_000, endTime: 2_000_000 }]);
  });

  it('rejects degenerate ranges where endMs <= startMs', () => {
    const equal = extractRecordingsFromResponse(
      resp({ video: { video_info: [{ startTime: 1000, endTime: 1000 }] } }),
    );
    const inverted = extractRecordingsFromResponse(
      resp({ video: { video_info: [{ startTime: 2000, endTime: 1000 }] } }),
    );
    expect(equal).toEqual([]);
    expect(inverted).toEqual([]);
  });

  it('rejects entries with non-numeric or missing start/end fields', () => {
    const out = extractRecordingsFromResponse(
      resp({
        video: {
          video_info: [{ startTime: '1000', endTime: 2000 }, { startTime: 1000 }, {}],
        },
      }),
    );
    expect(out).toEqual([]);
  });

  it('returns [] for an empty or malformed response', () => {
    expect(extractRecordingsFromResponse(resp({}))).toEqual([]);
    expect(extractRecordingsFromResponse(resp({ video: {} }))).toEqual([]);
    expect(extractRecordingsFromResponse(resp({ playback: {} }))).toEqual([]);
  });
});

describe('extractRecordingEventsFromResponse', () => {
  it('reads top-level playback.search_detection_list[] direct items', () => {
    // seconds-form: startRaw < 10e9 so startSec = startRaw + timeCorrection, then *1000.
    const out = extractRecordingEventsFromResponse(
      resp({ playback: { search_detection_list: [{ startTime: 1000, endTime: 2000, alarm_type: 1 }] } }),
      10,
    );
    expect(out).toEqual([{ startTime: (1000 + 10) * 1000, endTime: (2000 + 10) * 1000, alarmType: 1 }]);
  });

  it('reads nested responses[0].result.playback.search_detection_list[]', () => {
    const out = extractRecordingEventsFromResponse(
      resp({
        responses: [
          {
            method: 'm',
            error_code: 0,
            result: { playback: { search_detection_list: [{ startTime: 100, endTime: 200 }] } },
          },
        ],
      }),
      0,
    );
    expect(out).toEqual([{ startTime: 100_000, endTime: 200_000, alarmType: undefined }]);
  });

  it('collects events nested one object level deep', () => {
    const out = extractRecordingEventsFromResponse(
      resp({ playback: { search_detection_list: [{ '0': { startTime: 100, endTime: 200 } }] } }),
      0,
    );
    expect(out).toEqual([{ startTime: 100_000, endTime: 200_000, alarmType: undefined }]);
  });

  it('coerces alarm_type from number, numeric string, and rejects non-numeric', () => {
    const out = extractRecordingEventsFromResponse(
      resp({
        playback: {
          search_detection_list: [
            { startTime: 1, endTime: 2, alarm_type: 3 },
            { startTime: 1, endTime: 2, alarm_type: '4' },
            { startTime: 1, endTime: 2, alarm_type: 'motion' },
          ],
        },
      }),
      0,
    );
    expect(out.map((e) => e.alarmType)).toEqual([3, 4, undefined]);
  });

  it('applies timeCorrection to seconds-form timestamps but not to ms-form', () => {
    const corr = 25;
    const out = extractRecordingEventsFromResponse(
      resp({
        playback: {
          search_detection_list: [
            // seconds-form (< 10e9): start = (5 + 25) * 1000, end = (9 + 25) * 1000
            { startTime: 5, endTime: 9 },
            // ms-form (>= 10e9): startSec = floor(start/1000), corr NOT applied
            { startTime: 10_000_005_000, endTime: 10_000_009_000 },
          ],
        },
      }),
      corr,
    );
    expect(out).toEqual([
      { startTime: (5 + corr) * 1000, endTime: (9 + corr) * 1000, alarmType: undefined },
      {
        startTime: Math.floor(10_000_005_000 / 1000) * 1000,
        endTime: Math.floor(10_000_009_000 / 1000) * 1000,
        alarmType: undefined,
      },
    ]);
  });

  it('rejects events where end <= start', () => {
    const out = extractRecordingEventsFromResponse(
      resp({
        playback: {
          search_detection_list: [
            { startTime: 100, endTime: 100 },
            { startTime: 200, endTime: 100 },
          ],
        },
      }),
      0,
    );
    expect(out).toEqual([]);
  });

  it('returns [] for an empty response', () => {
    expect(extractRecordingEventsFromResponse(resp({}), 0)).toEqual([]);
    expect(extractRecordingEventsFromResponse(resp({ playback: {} }), 0)).toEqual([]);
  });
});

describe('normalizeBase64', () => {
  it('replaces URL-safe characters - -> + and _ -> /', () => {
    // 'ab-_' has length 4 (remainder 0) so no padding added; only char substitution.
    expect(normalizeBase64('ab-_')).toBe('ab+/');
  });

  it('leaves input unchanged when length is already a multiple of 4 (remainder 0)', () => {
    expect(normalizeBase64('abcd')).toBe('abcd');
  });

  it('pads with two = when length % 4 === 2', () => {
    expect(normalizeBase64('ab')).toBe('ab==');
  });

  it('pads with one = when length % 4 === 3', () => {
    expect(normalizeBase64('abc')).toBe('abc=');
  });

  it('substitutes and pads together', () => {
    // 'a-c' length 3 -> '+' for none, '-' -> '+', remainder 3 -> one '='.
    expect(normalizeBase64('a-c')).toBe('a+c=');
  });
});

describe('firstResponseErrorCode', () => {
  it('returns the numeric error_code of the first response', () => {
    expect(
      firstResponseErrorCode(resp({ responses: [{ method: 'm', error_code: -40401, result: {} }] })),
    ).toBe(-40401);
  });

  it('returns undefined when responses is missing', () => {
    expect(firstResponseErrorCode(resp({}))).toBeUndefined();
  });

  it('returns undefined when error_code is not a number', () => {
    expect(
      firstResponseErrorCode(
        resp({ responses: [{ method: 'm', error_code: 'oops' as unknown as number, result: {} }] }),
      ),
    ).toBeUndefined();
  });
});

describe('extractUserIdFromResponse', () => {
  it('reads a direct result.user_id', () => {
    expect(extractUserIdFromResponse(resp({ user_id: 42 }))).toBe(42);
  });

  it('reads nested responses[0].result.user_id', () => {
    expect(
      extractUserIdFromResponse(
        resp({ responses: [{ method: 'm', error_code: 0, result: { user_id: 7 } }] }),
      ),
    ).toBe(7);
  });

  it('reads responses[0].result.system.get_user_id.user_id', () => {
    expect(
      extractUserIdFromResponse(
        resp({
          responses: [{ method: 'm', error_code: 0, result: { system: { get_user_id: { user_id: 13 } } } }],
        }),
      ),
    ).toBe(13);
  });

  it('reads responses[0].result.system.get_user_id.id', () => {
    expect(
      extractUserIdFromResponse(
        resp({
          responses: [{ method: 'm', error_code: 0, result: { system: { get_user_id: { id: 99 } } } }],
        }),
      ),
    ).toBe(99);
  });

  it('coerces a numeric-string user_id', () => {
    expect(
      extractUserIdFromResponse(
        resp({ responses: [{ method: 'm', error_code: 0, result: { user_id: '21' } }] }),
      ),
    ).toBe(21);
  });

  it('returns null when no ladder branch matches', () => {
    expect(extractUserIdFromResponse(resp({}))).toBeNull();
    expect(extractUserIdFromResponse(resp({ user_id: 'not-a-number' }))).toBeNull();
    expect(
      extractUserIdFromResponse(
        resp({ responses: [{ method: 'm', error_code: 0, result: { system: { get_user_id: {} } } }] }),
      ),
    ).toBeNull();
  });
});
