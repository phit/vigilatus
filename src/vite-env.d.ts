/// <reference types="vite/client" />

import type { VigilatusApi } from '../electron/types';

declare global {
  interface Window {
    vigilatus: VigilatusApi;
  }
}

export {};
