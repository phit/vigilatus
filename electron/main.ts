import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import path from 'node:path';

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1680,
    height: 1024,
    minWidth: 1200,
    minHeight: 800,
    backgroundColor: '#0b1020',
    title: 'TapoStudio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDevelopment && process.env.VITE_DEV_SERVER_URL) {
    window.loadURL(process.env.VITE_DEV_SERVER_URL);
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';

  ipcMain.handle('app:get-platform', () => process.platform);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});