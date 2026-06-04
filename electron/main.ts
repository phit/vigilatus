import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type BrowserWindowConstructorOptions,
  type MenuItemConstructorOptions,
  nativeTheme,
  powerMonitor,
  screen,
  session,
  shell,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import util from 'node:util';
import { mainBindings, clearMainBindings } from 'i18next-electron-fs-backend';
import * as configStore from './config/store';
import * as streamManager from './tapo/streamManager';
import { registerHandlers } from './ipc/handlers';
import { IPC } from './ipc/channels';
import { loadTestFixtures } from './testing/fixtures';
import { t, setLanguage } from './i18n';
import { initAutoUpdater, checkForUpdates } from './autoUpdater';
import { PreviewPosition } from './types';
import { createLogger } from './log';

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const shouldOpenDevTools = process.env.VIGILATUS_OPEN_DEVTOOLS === '1' || !isDevelopment;
const projectGithubUrl = 'https://github.com/phit/tapo-studio';
const automationUserDataDir = process.env.VIGILATUS_USER_DATA_DIR?.trim();
const windowsAppUserModelId = 'link.phit.vigilatus';

if (process.platform === 'win32') {
  app.setAppUserModelId(windowsAppUserModelId);
}

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
let persistMainWindowStateTimer: NodeJS.Timeout | null = null;
const persistMainWindowStateDebounceMs = 1000;
const defaultMainWindowBounds = {
  width: 1680,
  height: 1024,
};
type WindowBounds = Pick<BrowserWindowConstructorOptions, 'x' | 'y' | 'width' | 'height'>;
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
    const timestamp = () => new Date().toISOString();

    const formatArgs = (args: unknown[]) =>
      args
        .map((arg) =>
          typeof arg === 'string'
            ? arg
            : util.inspect(arg, {
                depth: 6,
                breakLength: Infinity,
                maxArrayLength: 50,
                colors: false,
              }),
        )
        .join(' ');

    const patchConsoleMethod = (
      method: 'log' | 'info' | 'warn' | 'error' | 'debug',
      levelLabel?: string,
    ): void => {
      const original = console[method].bind(console);
      console[method] = (...args: unknown[]) => {
        const prefix = `[${timestamp()}]${levelLabel ? ` ${levelLabel}:` : ''}`;
        const rendered = formatArgs(args);
        logStream.write(`${prefix}${rendered ? ` ${rendered}` : ''}\n`);
        original(prefix, ...args);
      };
    };

    patchConsoleMethod('log');
    patchConsoleMethod('info', 'INFO');
    patchConsoleMethod('warn', 'WARN');
    patchConsoleMethod('error', 'ERROR');
    patchConsoleMethod('debug', 'DEBUG');

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
  sendUiEvent(IPC.ui.setPreviewsVisible, uiDisplayState.previews);
  sendUiEvent(IPC.ui.setTimelineVisible, uiDisplayState.timeline);
  sendUiEvent(IPC.ui.setHeaderVisible, uiDisplayState.header);
  sendUiEvent(IPC.ui.setPreviewPosition, uiDisplayState.previewPosition);
  sendUiEvent(IPC.ui.setLanguage, uiDisplayState.language);
  sendUiEvent(IPC.ui.setVolume, uiDisplayState.volume);
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

function getRestoredMainWindowBounds(): WindowBounds {
  const windowState = configStore.getWindowState();
  const { x: savedX, y: savedY, width, height } = windowState;

  if (width <= 0 || height <= 0) {
    return { ...defaultMainWindowBounds };
  }

  const savedBounds = {
    x: typeof savedX === 'number' ? savedX : 0,
    y: typeof savedY === 'number' ? savedY : 0,
    width,
    height,
  };
  const area = screen.getDisplayMatching(savedBounds).workArea;
  const restoredWidth = Math.min(width, area.width);
  const restoredHeight = Math.min(height, area.height);
  const hasSavedPosition = typeof savedX === 'number' && typeof savedY === 'number';
  const clampedX = hasSavedPosition
    ? Math.max(area.x, Math.min(savedX, area.x + area.width - restoredWidth))
    : area.x;
  const clampedY = hasSavedPosition
    ? Math.max(area.y, Math.min(savedY, area.y + area.height - restoredHeight))
    : area.y;
  const positionIsFullyInsideWorkArea =
    hasSavedPosition &&
    clampedX >= area.x &&
    clampedY >= area.y &&
    clampedX + restoredWidth <= area.x + area.width &&
    clampedY + restoredHeight <= area.y + area.height;

  if (positionIsFullyInsideWorkArea) {
    return {
      x: clampedX,
      y: clampedY,
      width: restoredWidth,
      height: restoredHeight,
    };
  }

  return {
    x: area.x + Math.floor((area.width - restoredWidth) / 2),
    y: area.y + Math.floor((area.height - restoredHeight) / 2),
    width: restoredWidth,
    height: restoredHeight,
  };
}

function persistMainWindowState(win: BrowserWindow): void {
  const bounds = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
  configStore.setWindowState({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized(),
  });
}

function schedulePersistMainWindowState(win: BrowserWindow): void {
  if (persistMainWindowStateTimer) {
    clearTimeout(persistMainWindowStateTimer);
  }

  persistMainWindowStateTimer = setTimeout(() => {
    persistMainWindowStateTimer = null;
    if (!win.isDestroyed()) {
      persistMainWindowState(win);
    }
  }, persistMainWindowStateDebounceMs);
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
      click: () => sendUiEvent(IPC.ui.openAddCamera),
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
        sendUiEvent(IPC.ui.setPreviewsVisible, menuItem.checked);
      },
    },
    {
      label: t('menu.timeline'),
      type: 'checkbox',
      checked: uiDisplayState.timeline,
      click: (menuItem) => {
        uiDisplayState.timeline = menuItem.checked;
        configStore.setUiDisplayPreferences({ timeline: menuItem.checked });
        sendUiEvent(IPC.ui.setTimelineVisible, menuItem.checked);
      },
    },
    {
      label: t('menu.statusbar'),
      type: 'checkbox',
      checked: uiDisplayState.header,
      click: (menuItem) => {
        uiDisplayState.header = menuItem.checked;
        configStore.setUiDisplayPreferences({ header: menuItem.checked });
        sendUiEvent(IPC.ui.setHeaderVisible, menuItem.checked);
      },
    },
    {
      label: t('menu.debugOverlay'),
      type: 'checkbox',
      checked: uiDisplayState.debugOverlay,
      click: (menuItem) => {
        uiDisplayState.debugOverlay = menuItem.checked;
        sendUiEvent(IPC.ui.setDebugOverlayVisible, menuItem.checked);
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
            sendUiEvent(IPC.ui.setPreviewPosition, 'left');
          },
        },
        {
          label: t('menu.right'),
          type: 'radio',
          checked: uiDisplayState.previewPosition === 'right',
          click: () => {
            uiDisplayState.previewPosition = 'right';
            configStore.setUiDisplayPreferences({ previewPosition: 'right' });
            sendUiEvent(IPC.ui.setPreviewPosition, 'right');
          },
        },
        {
          label: t('menu.top'),
          type: 'radio',
          checked: uiDisplayState.previewPosition === 'top',
          click: () => {
            uiDisplayState.previewPosition = 'top';
            configStore.setUiDisplayPreferences({ previewPosition: 'top' });
            sendUiEvent(IPC.ui.setPreviewPosition, 'top');
          },
        },
        {
          label: t('menu.bottom'),
          type: 'radio',
          checked: uiDisplayState.previewPosition === 'bottom',
          click: () => {
            uiDisplayState.previewPosition = 'bottom';
            configStore.setUiDisplayPreferences({ previewPosition: 'bottom' });
            sendUiEvent(IPC.ui.setPreviewPosition, 'bottom');
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
            sendUiEvent(IPC.ui.setLanguage, 'system');
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
            sendUiEvent(IPC.ui.setLanguage, 'en');
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
            sendUiEvent(IPC.ui.setLanguage, 'de');
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
  const restoredBounds = getRestoredMainWindowBounds();
  const persistedWindowState = configStore.getWindowState();
  let allowWindowStatePersistence = false;
  const win = new BrowserWindow({
    width: restoredBounds.width,
    height: restoredBounds.height,
    show: false,
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
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
    if (shouldOpenDevTools) {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  win.webContents.on('did-finish-load', () => {
    if (mainWindow === win) {
      applyUiDisplayStateToRenderer();
    }
  });

  win.once('ready-to-show', () => {
    win.show();

    if (
      typeof restoredBounds.x === 'number' &&
      typeof restoredBounds.y === 'number' &&
      typeof restoredBounds.width === 'number' &&
      typeof restoredBounds.height === 'number'
    ) {
      win.setBounds({
        x: restoredBounds.x,
        y: restoredBounds.y,
        width: restoredBounds.width,
        height: restoredBounds.height,
      });
    }

    if (persistedWindowState.isMaximized) {
      win.maximize();
    }

    setTimeout(() => {
      if (!win.isDestroyed()) {
        allowWindowStatePersistence = true;
      }
    }, 1000);
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  win.on('resize', () => {
    if (!allowWindowStatePersistence) return;
    schedulePersistMainWindowState(win);
  });

  win.on('move', () => {
    if (!allowWindowStatePersistence) return;
    schedulePersistMainWindowState(win);
  });

  win.on('maximize', () => {
    if (!allowWindowStatePersistence) return;
    schedulePersistMainWindowState(win);
  });

  win.on('unmaximize', () => {
    if (!allowWindowStatePersistence) return;
    schedulePersistMainWindowState(win);
  });

  win.on('close', () => {
    if (persistMainWindowStateTimer) {
      clearTimeout(persistMainWindowStateTimer);
      persistMainWindowStateTimer = null;
    }
    persistMainWindowState(win);
  });

  mainWindow = win;
}

ipcMain.handle(IPC.diagnostics.getRuntimeInfo, () => ({
  userData: app.getPath('userData'),
  logPath,
  isDevelopment,
  isPackaged: app.isPackaged,
}));

ipcMain.on(IPC.ui.saveVolume, (_e, volume: number) => {
  uiDisplayState.volume = volume;
  configStore.setUiDisplayPreferences({ volume });
});

ipcMain.handle(
  IPC.ui.showCameraContextMenu,
  (_e, isFirst: boolean, isLast: boolean): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return Promise.resolve(null);

    return new Promise((resolve) => {
      const menu = Menu.buildFromTemplate([
        { label: t('contextMenu.moveUp'), enabled: !isFirst, click: () => resolve('moveUp') },
        { label: t('contextMenu.moveDown'), enabled: !isLast, click: () => resolve('moveDown') },
        { type: 'separator' },
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
  },
);

void app.whenReady().then(async () => {
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
  } catch (err) {
    createLogger('main:streamManager').error('Failed to initialize streamManager:', err);
    const detail = err instanceof Error ? err.message : String(err);
    const body = t('startupError.body', { error: detail });
    const message = logPath ? `${body}\n\n${t('startupError.logHint', { logPath })}` : body;
    dialog.showErrorBox(t('startupError.title'), message);
    app.quit();
    return;
  }

  const testFixtures = loadTestFixtures();
  registerHandlers(testFixtures);
  setApplicationMenu();

  createWindow();
  initAutoUpdater();

  powerMonitor.on('resume', () => {
    createLogger('main:powerMonitor').info('System resumed from sleep, invalidating streams');
    streamManager.stopAllStreams();
    sendUiEvent(IPC.streams.invalidated);
  });

  streamManager.setOnStreamDied((cameraId) => {
    createLogger('main').info(`stream died for ${cameraId}, notifying renderer`);
    sendUiEvent(IPC.stream.died, cameraId);
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
