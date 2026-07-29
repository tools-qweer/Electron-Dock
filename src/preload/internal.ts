import { contextBridge, ipcRenderer } from "electron";
import {
  createElectronDockPreloadApi,
  type ElectronDockPreloadApi,
} from "./public.js";
import {
  IPC,
  type BeginPanelDragMessage,
  type DragPreviewMessage,
  type SetActivePanelMessage,
  type SetSplitRatioMessage,
  type WorkspaceStateMessage,
} from "../shared/protocol.js";

/**
 * Internal API used only by Electron Dock's bundled shell and overlay.
 *
 * It deliberately includes layout mutation and drag authority that is not
 * exported from `@tools-qweer/electron-dock/preload`.
 */
export interface ElectronDockInternalPreloadApi
  extends ElectronDockPreloadApi {
  getWorkspaceState(): Promise<WorkspaceStateMessage | null>;
  onWorkspaceState(
    listener: (message: WorkspaceStateMessage) => void,
  ): () => void;
  setActivePanel(message: SetActivePanelMessage): void;
  setSplitRatio(message: SetSplitRatioMessage): void;
  beginPanelDrag(message: BeginPanelDragMessage): void;
  onDragPreview(listener: (message: DragPreviewMessage) => void): () => void;
}

export function createElectronDockInternalPreloadApi():
  ElectronDockInternalPreloadApi {
  return {
    ...createElectronDockPreloadApi(),
    getWorkspaceState(): Promise<WorkspaceStateMessage | null> {
      return ipcRenderer.invoke(IPC.getWorkspaceState);
    },
    onWorkspaceState(
      listener: (message: WorkspaceStateMessage) => void,
    ): () => void {
      return subscribe(IPC.workspaceState, listener);
    },
    setActivePanel(message: SetActivePanelMessage): void {
      ipcRenderer.send(IPC.setActivePanel, message);
    },
    setSplitRatio(message: SetSplitRatioMessage): void {
      ipcRenderer.send(IPC.setSplitRatio, message);
    },
    beginPanelDrag(message: BeginPanelDragMessage): void {
      ipcRenderer.send(IPC.beginPanelDrag, message);
    },
    onDragPreview(
      listener: (message: DragPreviewMessage) => void,
    ): () => void {
      return subscribe(IPC.dragPreview, listener);
    },
  };
}

export function exposeElectronDockInternalPreloadApi(
  globalName = "electronDock",
): ElectronDockInternalPreloadApi {
  const api = createElectronDockInternalPreloadApi();
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
