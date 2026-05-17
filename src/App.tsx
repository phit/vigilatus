type Camera = {
  id: string;
  name: string;
  status: 'live' | 'idle' | 'offline';
  stream: string;
  motion: string;
  battery?: string;
};

const cameras: Camera[] = [
  { id: 'front', name: 'Front Door', status: 'live', stream: 'Main stream', motion: 'Motion 2 min ago' },
  { id: 'driveway', name: 'Driveway', status: 'live', stream: 'Sub stream', motion: 'Motion today', battery: 'Mains' },
  { id: 'garage', name: 'Garage', status: 'idle', stream: 'Main stream', motion: 'No recent motion' },
  { id: 'backyard', name: 'Backyard', status: 'offline', stream: 'Awaiting camera', motion: 'Last clip 1h ago' },
];

const timelineMarks = ['Now', '5m', '10m', '15m', '20m', '30m'];

export function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">TapoStudio</p>
          <h1>Selected camera maximized, previews beside it, timeline below.</h1>
          <p className="lede">
            Built for mixed Tapo camera fleets on Windows and Linux, with local SD recordings ready for later playback support.
          </p>
        </div>

        <section className="panel selected-card">
          <div className="selected-header">
            <span className="live-pill">Live</span>
            <span className="muted">Front Door</span>
          </div>
          <div className="viewer-stage">
            <div className="viewer-overlay">
              <div>
                <strong>Front Door</strong>
                <p>1080p main stream</p>
              </div>
              <button type="button">Fullscreen</button>
            </div>
            <div className="camera-feed">Selected camera feed</div>
          </div>
        </section>

        <section className="panel timeline-panel">
          <div className="timeline-top">
            <strong>Playback</strong>
            <span className="muted">Local SD card aware</span>
          </div>
          <div className="scrub-track">
            <div className="scrub-handle" />
          </div>
          <div className="timeline-marks">
            {timelineMarks.map((mark) => (
              <span key={mark}>{mark}</span>
            ))}
          </div>
        </section>
      </aside>

      <main className="workspace">
        <section className="topbar panel">
          <div>
            <strong>Camera roster</strong>
            <p className="muted">Preview refresh every few seconds or realtime later.</p>
          </div>
          <div className="topbar-actions">
            <button type="button">Refresh previews</button>
            <button type="button" className="primary">Add camera</button>
          </div>
        </section>

        <section className="grid">
          {cameras.map((camera) => (
            <article key={camera.id} className="panel camera-card">
              <div className="camera-card-header">
                <div>
                  <h2>{camera.name}</h2>
                  <p>{camera.stream}</p>
                </div>
                <span className={`status status-${camera.status}`}>{camera.status}</span>
              </div>
              <div className="preview-box">Preview tile</div>
              <div className="camera-meta">
                <span>{camera.motion}</span>
                <span>{camera.battery ?? 'N/A'}</span>
              </div>
            </article>
          ))}
        </section>

        <section className="panel footer-note">
          <p>
            Next step: wire live streams through a Tapo adapter and add timeline scrubbing from recorded SD-card events.
          </p>
        </section>
      </main>
    </div>
  );
}