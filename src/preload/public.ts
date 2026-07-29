import { contextBridge, ipcRenderer } from "electron";
import type { Rectangle } from "../core/types.js";
import {
  IPC,
  type HostChangedMessage,
} from "../shared/protocol.js";

/**
 * Panel-scoped API exposed by `@tools-qweer/electron-dock/preload`.
 *
 * Every operation is valid from a consumer-owned panel. Workspace layout,
 * splitter and drag authority remain private to Electron Dock's shell preload.
 */
export interface ElectronDockPreloadApi {
  getHostState(): Promise<HostChangedMessage | null>;
  onHostChanged(listener: (message: HostChangedMessage) => void): () => void;
  floatPanel(bounds?: Rectangle): Promise<unknown>;
  redockPanel(): Promise<unknown>;
  readPanelSnapshot(): Promise<unknown>;
}

/**
 * Creates the narrow, serializable renderer API used by Electron Dock.
 *
 * Calling this function does not expose anything globally. Consumers that
 * compose their own preload can merge the returned object into their existing
 * contextBridge contract.
 */
export function createElectronDockPreloadApi(): ElectronDockPreloadApi {
  return {
    getHostState(): Promise<HostChangedMessage | null> {
      return ipcRenderer.invoke(IPC.getHostState);
    },
    onHostChanged(
      listener: (message: HostChangedMessage) => void,
    ): () => void {
      return subscribe(IPC.hostChanged, listener);
    },
    floatPanel(bounds?: Rectangle): Promise<unknown> {
      return ipcRenderer.invoke(IPC.floatPanel, bounds);
    },
    redockPanel(): Promise<unknown> {
      return ipcRenderer.invoke(IPC.redockPanel);
    },
    readPanelSnapshot(): Promise<unknown> {
      return ipcRenderer.invoke(IPC.panelSnapshot);
    },
  };
}

/**
 * Convenience installer for a dedicated preload. It is intentionally explicit
 * so importing `@tools-qweer/electron-dock/preload` has no side effects.
 */
export function exposeElectronDockPreloadApi(
  globalName = "electronDock",
): ElectronDockPreloadApi {
  const api = createElectronDockPreloadApi();
  contextBridge.exposeInMainWorld(globalName, api);
  return api;
}

function subscribe<T>(
  channel: string,
  listener: (message: T) => void,
): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: unknown): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return;
    }
    listener(value as T);
  };
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}
