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

export function App() {
  const {
    cameras,
    selectedId,
    showPreviews,
    showTimeline,
    showHeader,
    previewPosition,
    playbackMode,
    playbackTime,
    recordings,
    recordingEvents,
    recordingsLoading,
    recordingsError,
    loadCameras,
    addCamera,
    updateCamera,
    removeCamera,
    selectCamera,
    startStream,
    stopStream,
    restartActiveStreams,
    setPreviewsVisible,
    setTimelineVisible,
    setHeaderVisible,
    setDebugOverlayVisible,
    setPreviewPosition,
    setVolume,
    loadRecordings,
    seekTo,
    goLive,
  } = useCameraStore();

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
    const offSetLanguage = window.vigilatus.ui.onSetLanguage((language) => {
      if (language === 'system') {
        const detected = navigator.language.split('-')[0] || 'en';
        i18n.changeLanguage(detected);
      } else {
        i18n.changeLanguage(language);
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
            {cameras.map((cam) => (
              <CameraPreview
                key={cam.config.id}
                camera={cam}
                isSelected={cam.config.id === selectedId}
                playbackMode={playbackMode}
                onSelect={() => selectCamera(cam.config.id)}
                onEdit={() => openEdit(cam.config)}
                onRemove={() => void handleRemove(cam.config.id)}
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
