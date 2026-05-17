import { useRef, useState } from 'react';
import type { CameraConfig } from '../types';

interface Props {
  initial?: CameraConfig;
  onSave(cfg: CameraConfig): void;
  onClose(): void;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const DEFAULT: Omit<CameraConfig, 'id' | 'name'> = {
  host: '',
  username: 'admin',
  password: '',
  streamUser: 'admin',
  streamPassword: '',
  rtspUrl: '',
  rtspUsername: '',
  rtspPassword: '',
};

export function AddCameraModal({ initial, onSave, onClose }: Props) {
  const [form, setForm] = useState<CameraConfig>(
    initial ?? { id: randomId(), name: '', ...DEFAULT },
  );
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const backdropPointerDownRef = useRef(false);

  const set = (field: keyof CameraConfig, value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.tapoStudio.cameras.test({
        host: form.host,
        username: form.username,
        password: form.password,
      });
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.host.trim()) return;
    const cfg = { ...form };
    if (!cfg.rtspUrl) {
      if (!cfg.streamPassword) cfg.streamPassword = cfg.password;
      if (!cfg.streamUser) cfg.streamUser = cfg.username;
    }
    onSave(cfg);
  };

  const handleBackdropMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    backdropPointerDownRef.current = e.button === 0 && e.target === e.currentTarget;
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const shouldClose =
      e.button === 0 && backdropPointerDownRef.current && e.target === e.currentTarget;
    backdropPointerDownRef.current = false;
    if (shouldClose) onClose();
  };

  const handleBackdropContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    backdropPointerDownRef.current = false;
    if (e.target === e.currentTarget) {
      e.preventDefault();
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
      onContextMenu={handleBackdropContextMenu}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{initial ? 'Edit Camera' : 'Add Camera'}</h2>
          <button type="button" className="modal-close" onClick={onClose}>✕</button>
        </div>

        <p className="modal-hint">
          Newer firmware: enable <strong>Third-Party Compatibility</strong> in Tapo app →{' '}
          <em>Me → Tapo Lab</em>. The API password is usually your Tapo / TP-Link account
          password. The <strong>Camera Account</strong> under Advanced Settings is separate and is
          only for direct RTSP streaming.
        </p>

        <form onSubmit={handleSubmit} className="modal-form">
          <label>
            Camera name
            <input
              required
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Front Door"
            />
          </label>

          <label>
            IP address
            <input
              required
              value={form.host}
              onChange={(e) => set('host', e.target.value)}
              placeholder="192.168.1.100"
            />
          </label>

          <div className="form-row">
            <label>
              Tapo API username
              <input value={form.username} onChange={(e) => set('username', e.target.value)} />
            </label>
            <label>
              Tapo API password
              <input
                type="password"
                required
                value={form.password}
                onChange={(e) => set('password', e.target.value)}
                placeholder="Usually your Tapo / TP-Link account password"
              />
            </label>
          </div>

          <button
            type="button"
            className="btn-secondary"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? '▲' : '▼'} Stream settings
          </button>

          {showAdvanced && (
            <div className="form-advanced">
              <p className="modal-hint">
                Use one of these stream options:
                set Camera Account credentials for direct camera RTSP, or point the app at your external RTSP proxy.
              </p>
              <label>
                External RTSP source URL (optional)
                <input
                  value={form.rtspUrl ?? ''}
                  onChange={(e) => set('rtspUrl', e.target.value)}
                  placeholder="rtsp://proxy.local:8554/front-door"
                />
              </label>
              <div className="form-row">
                <label>
                  Proxy RTSP username
                  <input
                    value={form.rtspUsername ?? ''}
                    onChange={(e) => set('rtspUsername', e.target.value)}
                    placeholder="viewer"
                  />
                </label>
                <label>
                  Proxy RTSP password
                  <input
                    type="password"
                    value={form.rtspPassword ?? ''}
                    onChange={(e) => set('rtspPassword', e.target.value)}
                    placeholder="optional"
                  />
                </label>
              </div>
              <div className="form-row">
                <label>
                  Camera Account username
                  <input
                    value={form.streamUser}
                    onChange={(e) => set('streamUser', e.target.value)}
                    placeholder="admin"
                  />
                </label>
                <label>
                  Camera Account password
                  <input
                    type="password"
                    value={form.streamPassword}
                    onChange={(e) => set('streamPassword', e.target.value)}
                    placeholder="Camera Account password"
                  />
                </label>
              </div>
            </div>
          )}

          <label>
            Model (optional)
            <input
              value={form.model ?? ''}
              onChange={(e) => set('model', e.target.value)}
              placeholder="C310, C200, TC70 …"
            />
          </label>

          {testResult && (
            <p className={`test-result${testResult.success ? ' test-ok' : ' test-fail'}`}>
              {testResult.success ? '✓ API connection successful' : `✗ ${testResult.error}`}
            </p>
          )}

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={handleTest} disabled={testing || !form.host || !form.password}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button type="submit" className="btn-primary" disabled={!form.name || !form.host || !form.password}>
              {initial ? 'Save changes' : 'Add camera'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
