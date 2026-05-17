/// <reference types="vite/client" />

declare global {
  interface Window {
    tapoStudio: {
      getPlatform(): Promise<NodeJS.Platform>;
    };
  }
}

export {};