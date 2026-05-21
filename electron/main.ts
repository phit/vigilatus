import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeTheme,
  powerMonitor,
  session,
  shell,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { mainBindings, clearMainBindings } from 'i18next-electron-fs-backend';
import * as configStore from './config/store';
import * as streamManager from './tapo/streamManager';
import { registerHandlers } from './ipc/handlers';
import { loadTestFixtures } from './testing/fixtures';
import { t, setLanguage } from './i18n';
import { initAutoUpdater, checkForUpdates } from './autoUpdater';
import { PreviewPosition } from './types';

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const shouldOpenDevTools = process.env.VIGILATUS_OPEN_DEVTOOLS === '1' || !isDevelopment;
const projectGithubUrl = 'https://github.com/phit/tapo-studio';
const automationUserDataDir = process.env.VIGILATUS_USER_DATA_DIR?.trim();

const uiDisplayState = {
  previews: true,
  timeline: true,
  header: false,
  previewPosition: 'right' as PreviewPosition,
  language: 'system',
  debugOverlay: false,
  volume: 0,
};

let mainWindow: BrowserWindow | null = null;
let aboutWindow: BrowserWindow | null = null;
let licensesWindow: BrowserWindow | null = null;
let logPath: string | null = null;
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// user data dir
if (automationUserDataDir) {
  app.setPath('userData', path.resolve(automationUserDataDir));
}

// logging
function setupLogging(): void {
  try {
    logPath = path.join(app.getPath('userData'), 'vigilatus.log');
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const originalLog = console.log;
    const originalError = console.error;
    const timestamp = () => new Date().toISOString();

    console.log = (...args: unknown[]) => {
      const msg = `[${timestamp()}] ${args.join(' ')}\n`;
      logStream.write(msg);
      originalLog(...args);
    };

    console.error = (...args: unknown[]) => {
      const msg = `[${timestamp()}] ERROR: ${args.join(' ')}\n`;
      logStream.write(msg);
      originalError(...args);
    };

    console.log('=== Vigilatus Started ===');
    console.log('isDevelopment:', isDevelopment);
    console.log('app.isPackaged:', app.isPackaged);
    console.log('userData:', app.getPath('userData'));
  } catch (err) {
    console.error('Failed to setup logging:', err);
  }
}

function sendUiEvent(channel: string, ...args: unknown[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, ...args);
}

function applyUiDisplayStateToRenderer(): void {
  sendUiEvent('ui:setPreviewsVisible', uiDisplayState.previews);
  sendUiEvent('ui:setTimelineVisible', uiDisplayState.timeline);
  sendUiEvent('ui:setHeaderVisible', uiDisplayState.header);
  sendUiEvent('ui:setPreviewPosition', uiDisplayState.previewPosition);
  sendUiEvent('ui:setLanguage', uiDisplayState.language);
  sendUiEvent('ui:setVolume', uiDisplayState.volume);
}

function wireExternalLinks(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (/^https?:\/\//i.test(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
}

function loadDialogPage(win: BrowserWindow, fileName: string, query: Record<string, string>): void {
  if (isDevelopment && process.env.VITE_DEV_SERVER_URL) {
    const baseUrl = process.env.VITE_DEV_SERVER_URL.replace(/\/$/, '');
    const search = new URLSearchParams(query).toString();
    void win.loadURL(`${baseUrl}/system/${fileName}?${search}`);
    return;
  }

  void win.loadFile(path.join(__dirname, '../renderer/system', fileName), { query });
}

function openAboutWindow(): void {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.focus();
    return;
  }

  aboutWindow = new BrowserWindow({
    width: 620,
    height: 420,
    minWidth: 520,
    minHeight: 360,
    title: t('menu.about'),
    autoHideMenuBar: true,
    backgroundColor: '#0a1020',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  aboutWindow.on('closed', () => {
    aboutWindow = null;
  });

  wireExternalLinks(aboutWindow);
  loadDialogPage(aboutWindow, 'about.html', {
    version: app.getVersion(),
    github: projectGithubUrl,
  });
}

function openLicensesWindow(): void {
  if (licensesWindow && !licensesWindow.isDestroyed()) {
    licensesWindow.focus();
    return;
  }

  licensesWindow = new BrowserWindow({
    width: 780,
    height: 680,
    minWidth: 640,
    minHeight: 480,
    title: t('menu.licensesAndCredits'),
    autoHideMenuBar: true,
    backgroundColor: '#0a1020',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  licensesWindow.on('closed', () => {
    licensesWindow = null;
  });

  wireExternalLinks(licensesWindow);
  loadDialogPage(licensesWindow, 'licenses.html', {
    version: app.getVersion(),
  });
}

function setApplicationMenu(): void {
  const appSubmenu: MenuItemConstructorOptions[] = [
    {
      label: t('menu.addCamera'),
      click: () => sendUiEvent('ui:openAddCamera'),
    },
    { type: 'separator' },
    {
      label: t('menu.about'),
      click: () => openAboutWindow(),
    },
    { type: 'separator' },
    { role: 'quit' },
  ];

  const viewSubmenu: MenuItemConstructorOptions[] = [
    {
      label: t('menu.previews'),
      type: 'checkbox',
      checked: uiDisplayState.previews,
      click: (menuItem) => {
        uiDisplayState.previews = menuItem.checked;
        configStore.setUiDisplayPreferences({ previews: menuItem.checked });
        sendUiEvent('ui:setPreviewsVisible', menuItem.checked);
      },
    },
    {
      label: t('menu.timeline'),
      type: 'checkbox',
      checked: uiDisplayState.timeline,
      click: (menuItem) => {
        uiDisplayState.timeline = menuItem.checked;
        configStore.setUiDisplayPreferences({ timeline: menuItem.checked });
        sendUiEvent('ui:setTimelineVisible', menuItem.checked);
      },
    },
    {
      label: t('menu.statusbar'),
      type: 'checkbox',
      checked: uiDisplayState.header,
      click: (menuItem) => {
        uiDisplayState.header = menuItem.checked;
        configStore.setUiDisplayPreferences({ header: menuItem.checked });
        sendUiEvent('ui:setHeaderVisible', menuItem.checked);
      },
    },
    {
      label: t('menu.debugOverlay'),
      type: 'checkbox',
      checked: uiDisplayState.debugOverlay,
      click: (menuItem) => {
        uiDisplayState.debugOverlay = menuItem.checked;
        sendUiEvent('ui:setDebugOverlayVisible', menuItem.checked);
      },
    },
    {
      label: t('menu.previewPosition'),
      submenu: [
        {
          label: t('menu.left'),
          type: 'radio',
          checked: uiDisplayState.previewPosition === 'left',
          click: () => {
            uiDisplayState.previewPosition = 'left';
            configStore.setUiDisplayPreferences({ previewPosition: 'left' });
            sendUiEvent('ui:setPreviewPosition', 'left');
          },
        },
        {
          label: t('menu.right'),
          type: 'radio',
          checked: uiDisplayState.previewPosition === 'right',
          click: () => {
            uiDisplayState.previewPosition = 'right';
            configStore.setUiDisplayPreferences({ previewPosition: 'right' });
            sendUiEvent('ui:setPreviewPosition', 'right');
          },
        },
        {
          label: t('menu.top'),
          type: 'radio',
          checked: uiDisplayState.previewPosition === 'top',
          click: () => {
            uiDisplayState.previewPosition = 'top';
            configStore.setUiDisplayPreferences({ previewPosition: 'top' });
            sendUiEvent('ui:setPreviewPosition', 'top');
          },
        },
        {
          label: t('menu.bottom'),
          type: 'radio',
          checked: uiDisplayState.previewPosition === 'bottom',
          click: () => {
            uiDisplayState.previewPosition = 'bottom';
            configStore.setUiDisplayPreferences({ previewPosition: 'bottom' });
            sendUiEvent('ui:setPreviewPosition', 'bottom');
          },
        },
      ],
    },
    { type: 'separator' },
    {
      label: t('menu.language'),
      submenu: [
        {
          label: t('menu.systemDefault'),
          type: 'radio',
          checked: uiDisplayState.language === 'system',
          click: () => {
            uiDisplayState.language = 'system';
            configStore.setUiDisplayPreferences({ language: 'system' });
            sendUiEvent('ui:setLanguage', 'system');
            setLanguage('system');
            setApplicationMenu();
          },
        },
        {
          label: 'English',
          type: 'radio',
          checked: uiDisplayState.language === 'en',
          click: () => {
            uiDisplayState.language = 'en';
            configStore.setUiDisplayPreferences({ language: 'en' });
            sendUiEvent('ui:setLanguage', 'en');
            setLanguage('en');
            setApplicationMenu();
          },
        },
        {
          label: 'Deutsch',
          type: 'radio',
          checked: uiDisplayState.language === 'de',
          click: () => {
            uiDisplayState.language = 'de';
            configStore.setUiDisplayPreferences({ language: 'de' });
            sendUiEvent('ui:setLanguage', 'de');
            setLanguage('de');
            setApplicationMenu();
          },
        },
      ],
    },
    { type: 'separator' },
    { role: 'reload' },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
  ];

  const helpSubmenu: MenuItemConstructorOptions[] = [
    {
      label: t('menu.about'),
      click: () => openAboutWindow(),
    },
    { type: 'separator' },
    {
      label: t('menu.checkForUpdates'),
      click: () => checkForUpdates(),
    },
    { type: 'separator' },
    {
      label: t('menu.licensesAndCredits'),
      click: () => openLicensesWindow(),
    },
    {
      label: t('menu.issuesAndFeedback'),
      click: () => void shell.openExternal(projectGithubUrl + '/issues'),
    },
  ];

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[]) : []),
    { label: t('menu.app'), submenu: appSubmenu },
    { label: t('menu.view'), submenu: viewSubmenu },
    { label: t('menu.help'), submenu: helpSubmenu },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1680,
    height: 1024,
    minWidth: 1200,
    minHeight: 800,
    backgroundColor: '#070b16',
    title: 'Vigilatus',
    icon: path.join(__dirname, '..', 'renderer', 'logo.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
    },
  });

  wireExternalLinks(win);
  mainBindings(ipcMain, win, fs);

  if (isDevelopment && process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    if (shouldOpenDevTools) {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  win.webContents.on('did-finish-load', () => {
    if (mainWindow === win) {
      applyUiDisplayStateToRenderer();
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  mainWindow = win;
}

ipcMain.handle('diagnostics:getRuntimeInfo', () => ({
  userData: app.getPath('userData'),
  logPath,
  isDevelopment,
  isPackaged: app.isPackaged,
}));

ipcMain.on('ui:saveVolume', (_e, volume: number) => {
  uiDisplayState.volume = volume;
  configStore.setUiDisplayPreferences({ volume });
});

ipcMain.handle('ui:showCameraContextMenu', (_e): Promise<string | null> => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return Promise.resolve(null);

  return new Promise((resolve) => {
    const menu = Menu.buildFromTemplate([
      { label: t('contextMenu.edit'), click: () => resolve('edit') },
      { type: 'separator' },
      { label: t('contextMenu.remove'), click: () => resolve('remove') },
    ]);
    menu.once('menu-will-close', () => {
      // Resolve null if nothing was clicked (menu dismissed)
      setTimeout(() => resolve(null), 50);
    });
    menu.popup({ window: win });
  });
});

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';

  // Content Security Policy (relaxed in dev for Vite HMR inline scripts)
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const scriptSrc = isDevelopment ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'";
    const connectSrc = isDevelopment
      ? `connect-src 'self' http://127.0.0.1:* ws://localhost:*`
      : "connect-src 'self' http://127.0.0.1:*";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            scriptSrc,
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "media-src 'self' http://127.0.0.1:* blob:",
            connectSrc,
            "worker-src 'self' blob:",
            "object-src 'none'",
            "base-uri 'self'",
          ].join('; '),
        ],
      },
    });
  });

  // Deny all permission requests except fullscreen
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'fullscreen');
  });

  configStore.init(app.getPath('userData'));
  const persistedUiDisplay = configStore.getUiDisplayPreferences();
  uiDisplayState.previews = persistedUiDisplay.previews;
  uiDisplayState.timeline = persistedUiDisplay.timeline;
  uiDisplayState.header = persistedUiDisplay.header;
  uiDisplayState.previewPosition = persistedUiDisplay.previewPosition;
  uiDisplayState.language = persistedUiDisplay.language;
  uiDisplayState.volume = persistedUiDisplay.volume;
  setLanguage(uiDisplayState.language);

  setupLogging();

  try {
    await streamManager.init();
    // console.log('[main:streamManager] streamManager initialized successfully');
  } catch (err) {
    console.error('[main:streamManager] Failed to initialize streamManager:', err);
    // TODO: show error dialog and abort launch
  }

  const testFixtures = loadTestFixtures();
  registerHandlers(testFixtures);
  setApplicationMenu();

  createWindow();
  initAutoUpdater();

  powerMonitor.on('resume', () => {
    console.log('[main:powerMonitor] System resumed from sleep, invalidating streams');
    streamManager.stopAllStreams();
    sendUiEvent('streams:invalidated');
  });

  streamManager.setOnStreamDied((cameraId) => {
    console.info(`[main] stream died for ${cameraId}, notifying renderer`);
    sendUiEvent('stream:died', cameraId);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  streamManager.cleanup();
  clearMainBindings(ipcMain);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
