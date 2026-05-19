import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeTheme,
  powerMonitor,
  shell,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import * as configStore from './config/store';
import * as streamManager from './tapo/streamManager';
import { registerHandlers } from './ipc/handlers';
import { loadTestFixtures } from './testing/fixtures';

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const shouldOpenDevTools = process.env.TAPOSTUDIO_OPEN_DEVTOOLS === '1' || !isDevelopment;
const projectGithubUrl = 'https://github.com/phit/tapo-studio';
const automationUserDataDir = process.env.TAPOSTUDIO_USER_DATA_DIR?.trim();

if (automationUserDataDir) {
  app.setPath('userData', path.resolve(automationUserDataDir));
}

// Setup logging
let logPath: string | null = null;
function setupLogging(): void {
  try {
    logPath = path.join(app.getPath('userData'), 'tapostudio.log');
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

    console.log('=== TapoStudio Started ===');
    console.log('isDevelopment:', isDevelopment);
    console.log('app.isPackaged:', app.isPackaged);
    console.log('userData:', app.getPath('userData'));
  } catch (err) {
    console.error('Failed to setup logging:', err);
  }
}

type PreviewPosition = 'left' | 'right' | 'top' | 'bottom';

let mainWindow: BrowserWindow | null = null;
let aboutWindow: BrowserWindow | null = null;
let licensesWindow: BrowserWindow | null = null;
const uiDisplayState = {
  previews: true,
  timeline: true,
  header: false,
  previewPosition: 'right' as PreviewPosition,
  language: 'system',
};

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
    title: 'About Tapo Studio',
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
    title: 'Licenses and Credits',
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
      label: 'Add Camera',
      click: () => sendUiEvent('ui:openAddCamera'),
    },
    { type: 'separator' },
    {
      label: 'About Tapo Studio',
      click: () => openAboutWindow(),
    },
    { type: 'separator' },
    { role: 'quit' },
  ];

  const viewSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Previews',
      type: 'checkbox',
      checked: uiDisplayState.previews,
      click: (menuItem) => {
        uiDisplayState.previews = menuItem.checked;
        configStore.setUiDisplayPreferences({ previews: menuItem.checked });
        sendUiEvent('ui:setPreviewsVisible', menuItem.checked);
      },
    },
    {
      label: 'Timeline',
      type: 'checkbox',
      checked: uiDisplayState.timeline,
      click: (menuItem) => {
        uiDisplayState.timeline = menuItem.checked;
        configStore.setUiDisplayPreferences({ timeline: menuItem.checked });
        sendUiEvent('ui:setTimelineVisible', menuItem.checked);
      },
    },
    {
      label: 'Statusbar',
      type: 'checkbox',
      checked: uiDisplayState.header,
      click: (menuItem) => {
        uiDisplayState.header = menuItem.checked;
        configStore.setUiDisplayPreferences({ header: menuItem.checked });
        sendUiEvent('ui:setHeaderVisible', menuItem.checked);
      },
    },
    {
      label: 'Preview Position',
      submenu: [
        {
          label: 'Left',
          type: 'radio',
          checked: uiDisplayState.previewPosition === 'left',
          click: () => {
            uiDisplayState.previewPosition = 'left';
            configStore.setUiDisplayPreferences({ previewPosition: 'left' });
            sendUiEvent('ui:setPreviewPosition', 'left');
          },
        },
        {
          label: 'Right',
          type: 'radio',
          checked: uiDisplayState.previewPosition === 'right',
          click: () => {
            uiDisplayState.previewPosition = 'right';
            configStore.setUiDisplayPreferences({ previewPosition: 'right' });
            sendUiEvent('ui:setPreviewPosition', 'right');
          },
        },
        {
          label: 'Top',
          type: 'radio',
          checked: uiDisplayState.previewPosition === 'top',
          click: () => {
            uiDisplayState.previewPosition = 'top';
            configStore.setUiDisplayPreferences({ previewPosition: 'top' });
            sendUiEvent('ui:setPreviewPosition', 'top');
          },
        },
        {
          label: 'Bottom',
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
      label: 'Language',
      submenu: [
        {
          label: 'System default',
          type: 'radio',
          checked: uiDisplayState.language === 'system',
          click: () => {
            uiDisplayState.language = 'system';
            configStore.setUiDisplayPreferences({ language: 'system' });
            sendUiEvent('ui:setLanguage', 'system');
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
      label: 'About Tapo Studio',
      click: () => openAboutWindow(),
    },
    { type: 'separator' },
    {
      label: 'Licenses and Credits',
      click: () => openLicensesWindow(),
    },
    {
      label: 'Issues and Feedback',
      click: () => void shell.openExternal(projectGithubUrl + '/issues'),
    },
  ];

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[]) : []),
    { label: 'Tapo Studio', submenu: appSubmenu },
    { label: 'View', submenu: viewSubmenu },
    { role: 'help', submenu: helpSubmenu },
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
    title: 'TapoStudio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

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

ipcMain.handle('ui:showCameraContextMenu', (_e): Promise<string | null> => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return Promise.resolve(null);

  return new Promise((resolve) => {
    const menu = Menu.buildFromTemplate([
      { label: 'Edit', click: () => resolve('edit') },
      { type: 'separator' },
      { label: 'Remove', click: () => resolve('remove') },
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

  configStore.init(app.getPath('userData'));
  const persistedUiDisplay = configStore.getUiDisplayPreferences();
  uiDisplayState.previews = persistedUiDisplay.previews;
  uiDisplayState.timeline = persistedUiDisplay.timeline;
  uiDisplayState.header = persistedUiDisplay.header;
  uiDisplayState.previewPosition = persistedUiDisplay.previewPosition;
  uiDisplayState.language = persistedUiDisplay.language;

  setupLogging();

  try {
    await streamManager.init();
    // console.log('[main:streamManager] streamManager initialized successfully');
  } catch (err) {
    console.error('[main:streamManager] Failed to initialize streamManager:', err);
  }

  const testFixtures = loadTestFixtures();
  registerHandlers(testFixtures);
  setApplicationMenu();

  createWindow();

  powerMonitor.on('resume', () => {
    console.log('[main:powerMonitor] System resumed from sleep, invalidating streams');
    streamManager.stopAllStreams();
    sendUiEvent('streams:invalidated');
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => streamManager.cleanup());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
