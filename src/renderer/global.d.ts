import type {
  ElectronDockInternalPreloadApi,
} from "../preload/internal.js";

declare global {
  interface Window {
    electronDock: ElectronDockInternalPreloadApi;
    __electronDockReadSnapshot?: () => unknown;
    __electronDockMutateForSmoke?: () => void;
  }
}

export {};
