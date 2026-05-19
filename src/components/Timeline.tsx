import { useCallback, useEffect, useRef, useState } from 'react';
import type { Recording, PlaybackMode } from '../types';

interface Props {
  recordings: Recording[];
  playbackMode: PlaybackMode;
  playbackTime: number | null;
  playbackEnabled: boolean;
  statusMessage?: string;
  /** Called when user scrubs to a specific time */
  onSeek(time: number): void;
  onGoLive(): void;
  /** Load recordings for a given YYYYMMDD date string */
  onLoadDate(date: string): void;
  selectedCameraId: string | null;
  'data-testid'?: string;
}

const WINDOW_HOURS = 24;

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function todayStr(): string {
  return toDateStr(new Date());
}

function shiftDate(dateStr: string, days: number): string {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(4, 6));
  const day = Number(dateStr.slice(6, 8));
  const d = new Date(year, month - 1, day);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

function formatDateDisplay(dateStr: string): string {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(4, 6));
  const day = Number(dateStr.slice(6, 8));
  return new Date(year, month - 1, day).toLocaleDateString();
}

/** Midnight (local) of the given YYYYMMDD date */
function dateStartMs(dateStr: string): number {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(4, 6));
  const day = Number(dateStr.slice(6, 8));
  return new Date(year, month - 1, day).getTime();
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function Timeline({
  recordings,
  playbackMode,
  playbackTime,
  playbackEnabled,
  statusMessage,
  onSeek,
  onGoLive,
  onLoadDate,
  selectedCameraId,
  'data-testid': testId,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const activePointerRef = useRef<number | null>(null);
  const dragTimeRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [dragPreviewTime, setDragPreviewTime] = useState<number | null>(null);
  const [selectedDate, setSelectedDate] = useState(todayStr);

  const isToday = selectedDate === todayStr();
  const windowStart = dateStartMs(selectedDate);
  const windowEnd = dateStartMs(selectedDate) + 24 * 60 * 60 * 1000;

  // Load recordings whenever camera or date changes
  useEffect(() => {
    if (!selectedCameraId) return;
    onLoadDate(selectedDate);
  }, [selectedCameraId, selectedDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset to today when camera changes
  useEffect(() => {
    setSelectedDate(todayStr());
  }, [selectedCameraId]);

  const goToPreviousDay = () => {
    setSelectedDate((d) => shiftDate(d, -1));
  };

  const goToNextDay = () => {
    setSelectedDate((d) => {
      const next = shiftDate(d, 1);
      return next <= todayStr() ? next : d;
    });
  };

  const goToToday = () => {
    setSelectedDate(todayStr());
  };

  const timeToPercent = useCallback(
    (t: number) => Math.max(0, Math.min(100, ((t - windowStart) / (windowEnd - windowStart)) * 100)),
    [windowStart, windowEnd],
  );

  const clientXToTime = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return windowEnd;
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return windowStart + pct * (windowEnd - windowStart);
    },
    [windowStart, windowEnd],
  );

  const handleTrackClick = (e: React.MouseEvent) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (dragging || !playbackEnabled) return;
    const t = clientXToTime(e.clientX);
    if (t >= Date.now() - 5000) { onGoLive(); return; }
    onSeek(t);
  };

  const beginDrag = (clientX: number) => {
    if (!playbackEnabled) return;
    const t = clientXToTime(clientX);
    dragTimeRef.current = t;
    setDragPreviewTime(t);
    suppressClickRef.current = true;
    setDragging(true);
  };

  const finalizeDrag = useCallback(() => {
    const t = dragTimeRef.current;
    dragTimeRef.current = null;
    activePointerRef.current = null;
    setDragPreviewTime(null);
    setDragging(false);
    if (!playbackEnabled || t == null) return;
    if (t >= Date.now() - 5000) {
      onGoLive();
      return;
    }
    onSeek(t);
  }, [onGoLive, onSeek, playbackEnabled]);

  useEffect(() => () => {
    activePointerRef.current = null;
  }, []);

  const handleTime = dragging && dragPreviewTime != null
    ? dragPreviewTime
    : playbackMode === 'playback' && playbackTime
    ? playbackTime
    : isToday ? Date.now() : windowEnd;
  const handlePos = timeToPercent(handleTime);

  // Time axis marks (every 4h)
  const marks: number[] = [];
  for (let h = 0; h <= WINDOW_HOURS; h += 4) {
    marks.push(windowStart + h * 60 * 60 * 1000);
  }

  return (
    <div className="timeline" data-testid={testId}>
      <div className="timeline-header">
        <span className="timeline-title">Timeline</span>
        <span className="timeline-date-nav">
          <button type="button" className="btn-date-nav" onClick={goToPreviousDay} title="Previous day">◀</button>
          <button
            type="button"
            className="timeline-date"
            onClick={goToToday}
            title="Go to today"
          >
            {formatDateDisplay(selectedDate)}{isToday ? ' (Today)' : ''}
          </button>
          <button type="button" className="btn-date-nav" onClick={goToNextDay} disabled={isToday} title="Next day">▶</button>
        </span>
        {playbackMode === 'playback' && (
          <span className="timeline-playback-time">
            {playbackTime ? formatTime(playbackTime) : '—'}
          </span>
        )}
        {statusMessage && <span className="timeline-status">{statusMessage}</span>}
        <button
          type="button"
          className={`btn-live${playbackMode === 'live' ? ' btn-live--active' : ''}`}
          onClick={onGoLive}
        >
          ● Live
        </button>
      </div>

      {/* Track */}
      <div
        ref={trackRef}
        className={`timeline-track${playbackEnabled ? '' : ' timeline-track--disabled'}`}
        onClick={handleTrackClick}
        onPointerDown={(e) => {
          if (!playbackEnabled) return;
          activePointerRef.current = e.pointerId;
          e.currentTarget.setPointerCapture(e.pointerId);
          e.preventDefault();
          beginDrag(e.clientX);
        }}
        onPointerMove={(e) => {
          if (!dragging || activePointerRef.current !== e.pointerId) return;
          const t = clientXToTime(e.clientX);
          dragTimeRef.current = t;
          setDragPreviewTime(t);
        }}
        onPointerUp={(e) => {
          if (activePointerRef.current !== e.pointerId) return;
          e.currentTarget.releasePointerCapture(e.pointerId);
          finalizeDrag();
        }}
        onPointerCancel={(e) => {
          if (activePointerRef.current !== e.pointerId) return;
          e.currentTarget.releasePointerCapture(e.pointerId);
          finalizeDrag();
        }}
        role="slider"
        aria-label="Timeline scrubber"
        aria-valuemin={windowStart}
        aria-valuemax={windowEnd}
        aria-valuenow={playbackTime ?? windowEnd}
      >
        {/* Recording segments */}
        {recordings.map((rec, i) => {
          const left = timeToPercent(rec.startTime);
          const width = timeToPercent(rec.endTime) - left;
          return (
            <div
              key={i}
              className="timeline-segment"
              style={{ left: `${left}%`, width: `${Math.max(0.3, width)}%` }}
              title={`${formatTime(rec.startTime)} – ${formatTime(rec.endTime)}`}
            />
          );
        })}

        {/* Current-time handle */}
        <div
          className={`timeline-handle${dragging ? ' timeline-handle--active' : ''}`}
          style={{ left: `${handlePos}%` }}
          onPointerDown={(e) => {
            if (!playbackEnabled) return;
            e.preventDefault();
            e.stopPropagation();
            activePointerRef.current = e.pointerId;
            trackRef.current?.setPointerCapture(e.pointerId);
            beginDrag(e.clientX);
          }}
        >
          <div className="timeline-needle" />
        </div>
      </div>

      {/* Time marks */}
      <div className="timeline-marks">
        {marks.map((t) => (
          <span key={t} style={{ left: `${timeToPercent(t)}%` }}>
            {formatTime(t)}
          </span>
        ))}
      </div>
    </div>
  );
}
