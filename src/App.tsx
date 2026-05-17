import { useEffect, useState } from 'react';
import { useCameraStore } from './store/cameras';
import { CameraViewer } from './components/CameraViewer';
import { CameraPreview } from './components/CameraPreview';
import { Timeline } from './components/Timeline';
import { AddCameraModal } from './components/AddCameraModal';
import type { CameraConfig } from './types';

export function App() {
  const {
    cameras,
    selectedId,
    showPreviews,
    playbackMode,
    playbackTime,
    recordings,
    loadCameras,
    addCamera,
    updateCamera,
    removeCamera,
    selectCamera,
    startStream,
    stopStream,
    togglePreviews,
    loadRecordings,
    seekTo,
    goLive,
  } = useCameraStore();

  const [showModal, setShowModal] = useState(false);
  const [editTarget, setEditTarget] = useState<CameraConfig | undefined>(undefined);

  const selectedCamera = cameras.find((c) => c.config.id === selectedId);
  const timelineMessage = !selectedCamera
    ? 'Select a camera to load recording availability.'
    : recordings.length > 0
    ? `${recordings.length} recording segment${recordings.length === 1 ? '' : 's'} found. Playback is not wired yet.`
    : 'No recording segments reported for the selected day, or recordings are unavailable.';

  useEffect(() => {
    void loadCameras();
  }, []);

  // Auto-select + start first camera on load
  useEffect(() => {
    if (!selectedId && cameras.length > 0) {
      selectCamera(cameras[0].config.id);
    }
  }, [cameras.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const openAdd = () => { setEditTarget(undefined); setShowModal(true); };
  const openEdit = (cfg: CameraConfig) => { setEditTarget(cfg); setShowModal(true); };

  const handleSave = async (cfg: CameraConfig) => {
    if (editTarget) {
      await updateCamera(cfg.id, cfg);
    } else {
      await addCamera(cfg);
    }
    setShowModal(false);
  };

  const handleRemove = async (id: string) => {
    if (confirm('Remove this camera?')) await removeCamera(id);
  };

  return (
    <div className="app">
      {/* ── Header ─────────────────────────────────────── */}
      <header className="header">
        <div className="header-brand">
          <span className="brand-dot" />
          TapoStudio
        </div>

        <div className="header-cam-info">
          {selectedCamera && (
            <>
              <span className="header-cam-name">{selectedCamera.config.name}</span>
              <span className={`badge badge-${playbackMode === 'playback' ? 'playback' : selectedCamera.status}`}>
                {playbackMode === 'playback' ? 'Playback' : selectedCamera.status}
              </span>
              <button
                type="button"
                className="btn-icon"
                title={`${selectedCamera.hlsUrl ? 'Stop' : 'Start'} stream`}
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
                title="Edit camera"
                onClick={() => openEdit(selectedCamera.config)}
              >
                ✎
              </button>
              <button
                type="button"
                className="btn-icon btn-icon--danger"
                title="Remove camera"
                onClick={() => void handleRemove(selectedCamera.config.id)}
              >
                ✕
              </button>
            </>
          )}
        </div>

        <div className="header-actions">
          <button type="button" className="btn-secondary" onClick={togglePreviews}>
            {showPreviews ? 'Hide' : 'Show'} previews
          </button>
          <button type="button" className="btn-primary" onClick={openAdd}>
            + Add camera
          </button>
        </div>
      </header>

      {/* ── Workspace ──────────────────────────────────── */}
      <div className="workspace">
        {/* Main viewer */}
        <div
          className="viewer-wrap"
          onClick={() => {
            if (!selectedCamera?.hlsUrl && selectedCamera) {
              void startStream(selectedCamera.config.id);
            }
          }}
        >
          <CameraViewer camera={selectedCamera} playbackMode={playbackMode} />
        </div>

        {/* Preview strip */}
        {showPreviews && cameras.length > 0 && (
          <aside className="preview-strip">
            {cameras.map((cam) => (
              <CameraPreview
                key={cam.config.id}
                camera={cam}
                isSelected={cam.config.id === selectedId}
                onSelect={() => selectCamera(cam.config.id)}
              />
            ))}
          </aside>
        )}

        {/* Empty state */}
        {cameras.length === 0 && (
          <div className="empty-state">
            <p>No cameras yet.</p>
            <button type="button" className="btn-primary" onClick={openAdd}>
              + Add your first camera
            </button>
          </div>
        )}
      </div>

      {/* ── Timeline ───────────────────────────────────── */}
      <Timeline
        recordings={recordings}
        playbackMode={playbackMode}
        playbackTime={playbackTime}
        playbackEnabled={false}
        statusMessage={timelineMessage}
        selectedCameraId={selectedId}
        onSeek={(t) => void seekTo(t)}
        onGoLive={goLive}
        onLoadDate={(date) => {
          if (selectedId) void loadRecordings(selectedId, date);
        }}
      />

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
