import { useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
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
  streamProtocol: 'rtsp',
};

export function AddCameraModal({ initial, onSave, onClose }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState<CameraConfig>(initial ?? { id: randomId(), name: '', ...DEFAULT });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const backdropPointerDownRef = useRef(false);

  const set = (field: keyof CameraConfig, value: string) => setForm((f) => ({ ...f, [field]: value }));

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.vigilatus.cameras.test({
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
    const shouldClose = e.button === 0 && backdropPointerDownRef.current && e.target === e.currentTarget;
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
      data-testid="add-camera-modal"
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
      onContextMenu={handleBackdropContextMenu}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{initial ? t('modal.editCamera') : t('modal.addCamera')}</h2>
          <button type="button" className="modal-close" onClick={onClose} data-testid="add-camera-close">
            ✕
          </button>
        </div>

        <p className="modal-hint">
          <Trans i18nKey="modal.hint" components={{ strong: <strong />, em: <em /> }} />
        </p>

        <form onSubmit={handleSubmit} className="modal-form">
          <label>
            {t('modal.cameraName')}
            <input
              required
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder={t('modal.cameraNamePlaceholder')}
            />
          </label>

          <label>
            {t('modal.ipAddress')}
            <input
              required
              value={form.host}
              onChange={(e) => set('host', e.target.value)}
              placeholder={t('modal.ipPlaceholder')}
            />
          </label>

          <div className="form-row">
            <label>
              {t('modal.apiUsername')}
              <input
                value={form.username}
                onChange={(e) => set('username', e.target.value)}
                placeholder={t('modal.apiUsernamePlaceholder')}
              />
            </label>
            <label>
              {t('modal.apiPassword')}
              <input
                type="password"
                required
                value={form.password}
                onChange={(e) => set('password', e.target.value)}
                placeholder={t('modal.apiPasswordPlaceholder')}
              />
            </label>
          </div>

          <button
            type="button"
            className="btn-secondary"
            onClick={() => setShowAdvanced((v) => !v)}
            data-testid="add-camera-toggle-advanced"
          >
            {showAdvanced ? '▲' : '▼'} {t('modal.streamSettings')}
          </button>

          {showAdvanced && (
            <div className="form-advanced">
              <label>
                {t('modal.streamProtocol')}
                <select
                  value={form.streamProtocol ?? 'rtsp'}
                  onChange={(e) => set('streamProtocol', e.target.value as 'rtsp' | 'http')}
                >
                  <option value="rtsp">{t('modal.protocolRtsp')}</option>
                  <option value="http">{t('modal.protocolHttp')}</option>
                </select>
              </label>
              <p className="modal-hint">{(form.streamProtocol ?? 'rtsp') === 'rtsp' ? t('modal.streamHint') : t('modal.httpStreamHint')}</p>
              {(form.streamProtocol ?? 'rtsp') === 'rtsp' && (
                <>
                  <label>
                    {t('modal.rtspUrl')}
                    <input
                      value={form.rtspUrl ?? ''}
                      onChange={(e) => set('rtspUrl', e.target.value)}
                      placeholder={t('modal.rtspUrlPlaceholder')}
                    />
                  </label>
                  <div className="form-row">
                    <label>
                      {t('modal.proxyUsername')}
                      <input
                        value={form.rtspUsername ?? ''}
                        onChange={(e) => set('rtspUsername', e.target.value)}
                        placeholder={t('modal.proxyUsernamePlaceholder')}
                      />
                    </label>
                    <label>
                      {t('modal.proxyPassword')}
                      <input
                        type="password"
                        value={form.rtspPassword ?? ''}
                        onChange={(e) => set('rtspPassword', e.target.value)}
                        placeholder={t('modal.proxyPasswordPlaceholder')}
                      />
                    </label>
                  </div>
                  <div className="form-row">
                    <label>
                      {t('modal.camAccountUsername')}
                      <input
                        value={form.streamUser}
                        onChange={(e) => set('streamUser', e.target.value)}
                        placeholder={t('modal.camAccountUsername')}
                      />
                    </label>
                    <label>
                      {t('modal.camAccountPassword')}
                      <input
                        type="password"
                        value={form.streamPassword}
                        onChange={(e) => set('streamPassword', e.target.value)}
                        placeholder={t('modal.camAccountPassword')}
                      />
                    </label>
                  </div>
                </>
              )}
            </div>
          )}

          <label>
            {t('modal.model')}
            <input
              value={form.model ?? ''}
              onChange={(e) => set('model', e.target.value)}
              placeholder={t('modal.modelPlaceholder')}
            />
          </label>

          {testResult && (
            <p className={`test-result${testResult.success ? ' test-ok' : ' test-fail'}`}>
              {testResult.success ? t('modal.testSuccess') : t('modal.testFail', { error: testResult.error })}
            </p>
          )}

          <div className="modal-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={handleTest}
              disabled={testing || !form.host || !form.password}
              data-testid="add-camera-test-connection"
            >
              {testing ? t('modal.testing') : t('modal.testConnection')}
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={!form.name || !form.host || !form.password}
              data-testid="add-camera-save"
            >
              {initial ? t('modal.saveChanges') : t('modal.addCameraBtn')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
