import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('tapoStudio', {
  getPlatform: () => ipcRenderer.invoke('app:get-platform') as Promise<NodeJS.Platform>,
});