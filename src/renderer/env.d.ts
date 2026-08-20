/// <reference types="vite/client" />

import type { SqlStudioApi } from '../preload/index';

declare global {
  interface Window {
    sqlStudio: SqlStudioApi;
  }
}

export {};
