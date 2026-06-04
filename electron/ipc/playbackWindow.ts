export const MIN_PLAYBACK_WINDOW_MS = 15_000;
export const MAX_PLAYBACK_WINDOW_MS = 120_000;

export function normalizePlaybackWindow(
  startTime: number,
  endTime: number,
  requestedTime: number,
): { startTime: number; endTime: number } {
  const boundedRequestedTime = Math.max(startTime, Math.min(endTime, requestedTime));
  let normalizedStartTime = Math.max(
    startTime,
    Math.min(boundedRequestedTime, endTime - MIN_PLAYBACK_WINDOW_MS),
  );
  let normalizedEndTime = Math.min(endTime, normalizedStartTime + MAX_PLAYBACK_WINDOW_MS);

  if (normalizedEndTime - normalizedStartTime < MIN_PLAYBACK_WINDOW_MS) {
    normalizedStartTime = Math.max(startTime, endTime - MIN_PLAYBACK_WINDOW_MS);
    normalizedEndTime = endTime;
  }

  return { startTime: normalizedStartTime, endTime: normalizedEndTime };
}
