declare module 'i18next-electron-fs-backend' {
  import type { BackendModule } from 'i18next';
  import type { IpcMain, IpcRenderer, BrowserWindow } from 'electron';

  interface I18nextElectronFsBackend extends BackendModule {
    mainBindings(ipcMain: IpcMain, browserWindow: BrowserWindow, fs: typeof import('fs')): void;
    clearMainBindings(ipcMain: IpcMain): void;
    preloadBindings(
      ipcRenderer: IpcRenderer,
      process: NodeJS.Process,
    ): {
      send(channel: string, data: unknown): void;
      onReceive(channel: string, callback: (data: unknown) => void): void;
      onLanguageChange(callback: (language: string) => void): void;
      clientOptions: {
        environment: string | undefined;
        platform: string;
        resourcesPath: string;
      };
    };
  }

  const backend: I18nextElectronFsBackend;
  export default backend;
  export const mainBindings: I18nextElectronFsBackend['mainBindings'];
  export const clearMainBindings: I18nextElectronFsBackend['clearMainBindings'];
  export const preloadBindings: I18nextElectronFsBackend['preloadBindings'];
}
