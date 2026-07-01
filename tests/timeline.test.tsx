import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Timeline } from '../src/components/Timeline';

function renderTimeline(onLoadDate: (date: string) => void) {
  return render(
    <Timeline
      recordings={[]}
      recordingEvents={[]}
      playbackMode="live"
      playbackTime={null}
      playbackEnabled
      onSeek={() => {}}
      onGoLive={() => {}}
      onLoadDate={onLoadDate}
      selectedCameraId="cam-1"
      data-testid="timeline"
    />,
  );
}

describe('Timeline day rollover', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T23:59:58'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('advances the selected date and reloads recordings when the day changes while open', () => {
    const onLoadDate = vi.fn();
    renderTimeline(onLoadDate);

    expect(onLoadDate).toHaveBeenLastCalledWith('20260701');
    expect(screen.getByText(/today/i)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(onLoadDate).toHaveBeenLastCalledWith('20260702');
    expect(screen.getByText(/today/i)).toBeInTheDocument();
  });
});
