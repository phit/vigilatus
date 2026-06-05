import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, parse, addDays, startOfDay, isToday as isDateToday } from 'date-fns';
import type { Recording, RecordingEvent, PlaybackMode } from '../types';

interface Props {
  recordings: Recording[];
  recordingEvents: RecordingEvent[];
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

const DATE_FMT = 'yyyyMMdd';

function toDateStr(d: Date): string {
  return format(d, DATE_FMT);
}

function todayStr(): string {
  return toDateStr(new Date());
}

function nowMs(): number {
  return Date.now();
}

function parseDate(dateStr: string): Date {
  return parse(dateStr, DATE_FMT, new Date());
}

function shiftDate(dateStr: string, days: number): string {
  return toDateStr(addDays(parseDate(dateStr), days));
}

function formatDateDisplay(dateStr: string): string {
  return format(parseDate(dateStr), 'PP');
}

function dateStartMs(dateStr: string): number {
  return startOfDay(parseDate(dateStr)).getTime();
}

function formatTime(ts: number): string {
  return format(ts, 'HH:mm');
}

export function Timeline({
  recordings,
  recordingEvents,
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
  const { t } = useTranslation();
  const activePointerRef = useRef<number | null>(null);
  const dragTimeRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [dragPreviewTime, setDragPreviewTime] = useState<number | null>(null);
  const [selectedDate, setSelectedDate] = useState(todayStr);
  const [now, setNow] = useState(nowMs);
  const [prevCameraId, setPrevCameraId] = useState(selectedCameraId);

  // Reset to today when the camera changes. Done during render (the React
  // "adjust state on prop change" pattern) so the load effect below runs once
  // with the new date — and avoids a synchronous setState inside an effect.
  if (selectedCameraId !== prevCameraId) {
    setPrevCameraId(selectedCameraId);
    setSelectedDate(toDateStr(new Date(now)));
  }

  const isToday = isDateToday(parseDate(selectedDate));
  const windowStart = dateStartMs(selectedDate);
  const windowEnd = windowStart + 24 * 60 * 60 * 1000;

  // Load recordings whenever camera or date changes
  useEffect(() => {
    if (!selectedCameraId) return;
    onLoadDate(selectedDate);
  }, [selectedCameraId, selectedDate, onLoadDate]);

  // Keep a current-time value in state (instead of calling Date.now() during
  // render) so the live "now" handle advances and the camera-change reset above
  // always resolves to the real current day.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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
    if (t >= Date.now() - 5000) {
      onGoLive();
      return;
    }
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

  useEffect(
    () => () => {
      activePointerRef.current = null;
    },
    [],
  );

  const handleTime =
    dragging && dragPreviewTime != null
      ? dragPreviewTime
      : playbackMode === 'playback' && playbackTime
        ? playbackTime
        : isToday
          ? now
          : windowEnd;
  const handlePos = timeToPercent(handleTime);
  const showHandleTime = dragging || playbackMode === 'playback';
  const handleTimeLabel = formatTime(handleTime);

  // Time axis marks (every 4h)
  const marks: number[] = [];
  for (let h = 0; h <= 24; h += 4) {
    marks.push(windowStart + h * 60 * 60 * 1000);
  }

  const formatEventTitle = (event: RecordingEvent): string => {
    const range = `${formatTime(event.startTime)} – ${formatTime(event.endTime)}`;
    if (typeof event.alarmType === 'number') {
      return `${t('timeline.activity')} (${event.alarmType}) ${range}`;
    }
    return `${t('timeline.activity')} ${range}`;
  };

  return (
    <div className="timeline" data-testid={testId}>
      <div className="timeline-header">
        <span className="timeline-title">{t('timeline.title')}</span>
        <span className="timeline-date-nav">
          <button
            type="button"
            className="btn-date-nav"
            onClick={goToPreviousDay}
            title={t('timeline.previousDay')}
          >
            ◀
          </button>
          <button type="button" className="timeline-date" onClick={goToToday} title={t('timeline.goToToday')}>
            {formatDateDisplay(selectedDate)}
            {isToday ? ` ${t('timeline.today')}` : ''}
          </button>
          <button
            type="button"
            className="btn-date-nav"
            onClick={goToNextDay}
            disabled={isToday}
            title={t('timeline.nextDay')}
          >
            ▶
          </button>
        </span>
        {playbackMode === 'playback' && (
          <span className="timeline-playback-time">{playbackTime ? formatTime(playbackTime) : '—'}</span>
        )}
        {statusMessage && <span className="timeline-status">{statusMessage}</span>}
        <button
          type="button"
          className={`btn-live${playbackMode === 'live' ? ' btn-live--active' : ''}`}
          onClick={onGoLive}
        >
          {t('timeline.live')}
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
        aria-label={t('timeline.scrubber')}
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

        {/* Detection highlights */}
        {recordingEvents.map((event, i) => {
          const left = timeToPercent(event.startTime);
          const width = timeToPercent(event.endTime) - left;
          return (
            <div
              key={`${event.startTime}-${event.endTime}-${event.alarmType ?? 'unknown'}-${i}`}
              className={`timeline-event${typeof event.alarmType === 'number' ? ` timeline-event--alarm-${event.alarmType}` : ''}`}
              style={{ left: `${left}%`, width: `${Math.max(0.25, width)}%` }}
              title={formatEventTitle(event)}
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
          {showHandleTime && <div className="timeline-handle-time">{handleTimeLabel}</div>}
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
