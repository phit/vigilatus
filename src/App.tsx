// @refresh reset
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';
import { useCameraStore } from './store/cameras';
import { CameraViewer } from './components/CameraViewer';
import { CameraPreview } from './components/CameraPreview';
import { Timeline } from './components/Timeline';
import { AddCameraModal } from './components/AddCameraModal';
import type { CameraConfig, PreviewPosition } from './types';
import { createLogger } from './log';

const log = createLogger('App');

/** Per-camera exponential backoff state for auto-restart after stream death. */
const streamRestartBackoff = new Map<
  string,
  { attempt: number; delay: number; timer: ReturnType<typeof setTimeout> }
>();
const RESTART_INITIAL_DELAY_MS = 2_000;
const RESTART_MAX_DELAY_MS = 10 * 60 * 1000; // 10 minutes

function scheduleStreamRestart(cameraId: string, startStream: (id: string) => Promise<void>): void {
  const existing = streamRestartBackoff.get(cameraId);
  const delay = existing ? Math.min(existing.delay * 2, RESTART_MAX_DELAY_MS) : RESTART_INITIAL_DELAY_MS;
  const attempt = (existing?.attempt ?? 0) + 1;
  if (existing) clearTimeout(existing.timer);

  log.warn(`stream restart scheduled for ${cameraId}: attempt ${attempt} in ${(delay / 1000).toFixed(0)}s`);
  const timer = setTimeout(async () => {
    const state = useCameraStore.getState();
    const cam = state.cameras.find((c) => c.config.id === cameraId);
    // Only restart if the camera was live/connecting or failed during a previous
    // restart attempt (status 'error'). Skip if the user manually stopped it ('idle').
    if (!cam || cam.status === 'idle') {
      streamRestartBackoff.delete(cameraId);
      log.info(`stream restart stopped for ${cameraId}: camera is idle or missing`);
      return;
    }

    log.info(`stream restart attempt ${attempt} starting for ${cameraId}`);
    try {
      await startStream(cameraId);
    } catch (error) {
      log.warn(`stream restart attempt ${attempt} threw for ${cameraId}:`, (error as Error).message);
    }

    // Check whether the restart actually succeeded
    const after = useCameraStore.getState().cameras.find((c) => c.config.id === cameraId);
    if (after?.status === 'live') {
      streamRestartBackoff.delete(cameraId);
      log.info(`stream restart recovered ${cameraId} on attempt ${attempt}`);
    } else if (!after || after.status === 'idle') {
      streamRestartBackoff.delete(cameraId);
      log.info(`stream restart stopped for ${cameraId}: camera is idle or missing`);
    } else {
      // Restart failed — schedule another attempt with increased backoff
      scheduleStreamRestart(cameraId, startStream);
    }
  }, delay);
  streamRestartBackoff.set(cameraId, { attempt, delay, timer });
}

export function App() {
  // State slices — subscribe only to what App renders.
  const cameras = useCameraStore((s) => s.cameras);
  const selectedId = useCameraStore((s) => s.selectedId);
  const showPreviews = useCameraStore((s) => s.showPreviews);
  const showTimeline = useCameraStore((s) => s.showTimeline);
  const showHeader = useCameraStore((s) => s.showHeader);
  const previewPosition = useCameraStore((s) => s.previewPosition);
  const playbackMode = useCameraStore((s) => s.playbackMode);
  const playbackTime = useCameraStore((s) => s.playbackTime);
  const recordings = useCameraStore((s) => s.recordings);
  const recordingEvents = useCameraStore((s) => s.recordingEvents);
  const recordingsLoading = useCameraStore((s) => s.recordingsLoading);
  const recordingsError = useCameraStore((s) => s.recordingsError);

  // Actions — stable references, so selecting them never triggers re-renders.
  const loadCameras = useCameraStore((s) => s.loadCameras);
  const addCamera = useCameraStore((s) => s.addCamera);
  const updateCamera = useCameraStore((s) => s.updateCamera);
  const removeCamera = useCameraStore((s) => s.removeCamera);
  const moveCamera = useCameraStore((s) => s.moveCamera);
  const selectCamera = useCameraStore((s) => s.selectCamera);
  const startStream = useCameraStore((s) => s.startStream);
  const stopStream = useCameraStore((s) => s.stopStream);
  const restartActiveStreams = useCameraStore((s) => s.restartActiveStreams);
  const setPreviewsVisible = useCameraStore((s) => s.setPreviewsVisible);
  const setTimelineVisible = useCameraStore((s) => s.setTimelineVisible);
  const setHeaderVisible = useCameraStore((s) => s.setHeaderVisible);
  const setDebugOverlayVisible = useCameraStore((s) => s.setDebugOverlayVisible);
  const setPreviewPosition = useCameraStore((s) => s.setPreviewPosition);
  const setVolume = useCameraStore((s) => s.setVolume);
  const loadRecordings = useCameraStore((s) => s.loadRecordings);
  const seekTo = useCameraStore((s) => s.seekTo);
  const goLive = useCameraStore((s) => s.goLive);

  const { t } = useTranslation();
  const [showModal, setShowModal] = useState(false);
  const [editTarget, setEditTarget] = useState<CameraConfig | undefined>(undefined);

  const selectedCamera = cameras.find((c) => c.config.id === selectedId);
  const playbackEnabled = Boolean(selectedCamera);
  const timelineMessage = !selectedCamera
    ? t('timeline.selectCamera')
    : recordingsError
      ? t('timeline.queryFailed', { error: recordingsError })
      : recordingsLoading
        ? t('timeline.loading')
        : recordings.length > 0
          ? t('timeline.segmentsFound', { count: recordings.length })
          : t('timeline.noSegments');

  useEffect(() => {
    void loadCameras();
  }, []);

  useEffect(() => {
    const offOpenAdd = window.vigilatus.ui.onOpenAddCamera(() => {
      setEditTarget(undefined);
      setShowModal(true);
    });
    const offSetPreviewsVisible = window.vigilatus.ui.onSetPreviewsVisible((visible) => {
      setPreviewsVisible(visible);
    });
    const offSetTimelineVisible = window.vigilatus.ui.onSetTimelineVisible((visible) => {
      setTimelineVisible(visible);
    });
    const offSetHeaderVisible = window.vigilatus.ui.onSetHeaderVisible((visible) => {
      setHeaderVisible(visible);
    });
    const offSetDebugOverlayVisible = window.vigilatus.ui.onSetDebugOverlayVisible((visible) => {
      setDebugOverlayVisible(visible);
    });
    const offSetPreviewPosition = window.vigilatus.ui.onSetPreviewPosition((position: PreviewPosition) => {
      setPreviewPosition(position);
    });
    const offStreamsInvalidated = window.vigilatus.ui.onStreamsInvalidated(() => {
      restartActiveStreams();
    });
    const offStreamDied = window.vigilatus.ui.onStreamDied((cameraId) => {
      scheduleStreamRestart(cameraId, startStream);
    });
    const offSetLanguage = window.vigilatus.ui.onSetLanguage((language) => {
      if (language === 'system') {
        const detected = navigator.language.split('-')[0] || 'en';
        void i18n.changeLanguage(detected);
      } else {
        void i18n.changeLanguage(language);
      }
    });
    const offSetVolume = window.vigilatus.ui.onSetVolume((volume) => {
      setVolume(volume);
    });

    return () => {
      offOpenAdd();
      offSetPreviewsVisible();
      offSetTimelineVisible();
      offSetHeaderVisible();
      offSetDebugOverlayVisible();
      offSetPreviewPosition();
      offStreamsInvalidated();
      offStreamDied();
      offSetLanguage();
      offSetVolume();
    };
  }, [
    setPreviewsVisible,
    setTimelineVisible,
    setHeaderVisible,
    setDebugOverlayVisible,
    setPreviewPosition,
    setVolume,
    restartActiveStreams,
    startStream,
  ]);

  // Auto-select + start first camera on load
  useEffect(() => {
    if (!selectedId && cameras.length > 0) {
      selectCamera(cameras[0].config.id);
    }
  }, [cameras.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const openAdd = () => {
    setEditTarget(undefined);
    setShowModal(true);
  };
  const openEdit = (cfg: CameraConfig) => {
    setEditTarget(cfg);
    setShowModal(true);
  };

  const handleSave = async (cfg: CameraConfig) => {
    if (editTarget) {
      await updateCamera(cfg.id, cfg);
    } else {
      await addCamera(cfg);
    }
    setShowModal(false);
  };

  const handleRemove = async (id: string) => {
    if (confirm(t('app.confirmRemove'))) await removeCamera(id);
  };

  return (
    <div
      className={`app${showTimeline ? '' : ' app--no-timeline'}${showHeader ? '' : ' app--no-header'}`}
      data-testid="app-shell"
    >
      {/* ── Header ─────────────────────────────────────── */}
      {showHeader && (
        <header className="header">
          <div className="header-cam-info">
            {selectedCamera && (
              <>
                <button
                  type="button"
                  className="btn-icon"
                  title={selectedCamera.hlsUrl ? t('header.stopStream') : t('header.startStream')}
                  disabled={selectedCamera.status === 'connecting'}
                  onClick={() =>
                    selectedCamera.hlsUrl
                      ? stopStream(selectedCamera.config.id)
                      : startStream(selectedCamera.config.id)
                  }
                >
                  {selectedCamera.hlsUrl ? '⏹' : '▶'}
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  title={t('header.editCamera')}
                  onClick={() => openEdit(selectedCamera.config)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="btn-icon btn-icon--danger"
                  title={t('header.removeCamera')}
                  onClick={() => void handleRemove(selectedCamera.config.id)}
                >
                  ✕
                </button>
              </>
            )}
          </div>
        </header>
      )}

      {/* ── Workspace ──────────────────────────────────── */}
      <div
        className={`workspace${showPreviews && cameras.length > 0 ? ` workspace--previews-${previewPosition}` : ''}`}
      >
        {/* Main viewer */}
        <div
          className="viewer-wrap"
          data-testid="viewer-shell"
          onClick={() => {
            if (
              playbackMode === 'live' &&
              !selectedCamera?.hlsUrl &&
              selectedCamera &&
              selectedCamera.status !== 'connecting'
            ) {
              void startStream(selectedCamera.config.id);
            }
          }}
        >
          <CameraViewer camera={selectedCamera} playbackMode={playbackMode} />
        </div>

        {/* Preview strip */}
        {showPreviews && cameras.length > 0 && (
          <aside className="preview-strip" data-testid="preview-strip">
            {cameras.map((cam, idx) => (
              <CameraPreview
                key={cam.config.id}
                camera={cam}
                isSelected={cam.config.id === selectedId}
                isFirst={idx === 0}
                isLast={idx === cameras.length - 1}
                playbackMode={playbackMode}
                onSelect={() => selectCamera(cam.config.id)}
                onEdit={() => openEdit(cam.config)}
                onRemove={() => void handleRemove(cam.config.id)}
                onMoveUp={() => void moveCamera(cam.config.id, 'up')}
                onMoveDown={() => void moveCamera(cam.config.id, 'down')}
              />
            ))}
          </aside>
        )}

        {/* Empty state */}
        {cameras.length === 0 && (
          <div className="empty-state" data-testid="empty-state">
            <p>{t('app.noCameras')}</p>
            <button
              type="button"
              className="btn-primary"
              onClick={openAdd}
              data-testid="empty-state-add-camera"
            >
              {t('app.addFirstCamera')}
            </button>
          </div>
        )}
      </div>

      {/* ── Timeline ───────────────────────────────────── */}
      {showTimeline && (
        <Timeline
          data-testid="timeline"
          recordings={recordings}
          recordingEvents={recordingEvents}
          playbackMode={playbackMode}
          playbackTime={playbackTime}
          playbackEnabled={playbackEnabled}
          statusMessage={timelineMessage}
          selectedCameraId={selectedId}
          onSeek={(t) => void seekTo(t)}
          onGoLive={goLive}
          onLoadDate={(date) => {
            if (selectedId) void loadRecordings(selectedId, date);
          }}
        />
      )}

      {/* ── Add / edit modal ───────────────────────────── */}
      {showModal && (
        <AddCameraModal
          initial={editTarget}
          onSave={(cfg) => void handleSave(cfg)}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}
