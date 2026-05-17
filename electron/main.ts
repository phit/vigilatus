import { app, BrowserWindow, nativeTheme } from 'electron';
import path from 'node:path';
import * as configStore from './config/store';
import * as streamManager from './tapo/streamManager';
import { registerHandlers } from './ipc/handlers';

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const shouldOpenDevTools = process.env.TAPOSTUDIO_OPEN_DEVTOOLS === '1';

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
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';

  configStore.init(app.getPath('userData'));
  await streamManager.init();
  registerHandlers();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => streamManager.cleanup());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});