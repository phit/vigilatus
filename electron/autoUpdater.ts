import { autoUpdater } from 'electron-updater';
import { dialog, BrowserWindow } from 'electron';
import { t } from './i18n';
import { createLogger } from './log';

const log = createLogger('autoUpdater');

let updateAvailableNotified = false;

export function initAutoUpdater(): void {
  // Portable builds and dev mode do not support auto-update
  if (!autoUpdater.isUpdaterActive()) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    log.info('Update available:', info.version);
    if (updateAvailableNotified) return;
    updateAvailableNotified = true;

    const win = BrowserWindow.getFocusedWindow();
    if (!win) return;

    void dialog.showMessageBox(win, {
      type: 'info',
      title: t('updater.title'),
      message: t('updater.available', { version: info.version }),
      detail: t('updater.downloading'),
      buttons: ['OK'],
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded:', info.version);

    const win = BrowserWindow.getFocusedWindow();
    if (!win) return;

    void dialog
      .showMessageBox(win, {
        type: 'info',
        title: t('updater.title'),
        message: t('updater.ready', { version: info.version }),
        buttons: [t('updater.restartNow'), t('updater.later')],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on('error', (err) => {
    log.error('Error:', err);
  });

  // Check for updates after a short delay so the window can finish loading
  setTimeout(() => {
    void autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      log.error('Check failed:', err);
    });
  }, 5_000);
}

export function checkForUpdates(): void {
  const showNoUpdates = () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      void dialog.showMessageBox(win, {
        type: 'info',
        title: t('updater.title'),
        message: t('updater.noUpdates'),
        buttons: ['OK'],
      });
    }
  };

  const onNotAvailable = () => {
    autoUpdater.off('update-not-available', onNotAvailable);
    showNoUpdates();
  };
  autoUpdater.on('update-not-available', onNotAvailable);

  void autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    autoUpdater.off('update-not-available', onNotAvailable);
    log.error('Manual check failed:', err);
    showNoUpdates();
  });
}
