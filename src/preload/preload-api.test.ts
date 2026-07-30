import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async () => null),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: electronMocks.exposeInMainWorld,
  },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
    send: electronMocks.send,
  },
}));

import {
  createElectronDockInternalPreloadApi,
} from "./internal.js";
import {
  createElectronDockPreloadApi,
} from "./public.js";
import { IPC } from "../shared/protocol.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Electron Dock preload API boundaries", () => {
  it("exposes only panel-valid operations from the public preload", async () => {
    const api = createElectronDockPreloadApi();

    expect(Object.keys(api).sort()).toEqual([
      "floatPanel",
      "getHostState",
      "getPanelState",
      "onHostChanged",
      "onPanelStateChanged",
      "redockPanel",
    ]);

    await api.getHostState();
    await api.getPanelState();
    await api.floatPanel({ x: 1, y: 2, width: 320, height: 240 });
    await api.redockPanel();

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      1,
      IPC.getHostState,
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      2,
      IPC.getPanelState,
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      3,
      IPC.floatPanel,
      { x: 1, y: 2, width: 320, height: 240 },
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(4, IPC.redockPanel);
  });

  it("keeps workspace, resize and drag authority in the internal preload", () => {
    const api = createElectronDockInternalPreloadApi();

    expect(Object.keys(api).sort()).toEqual([
      "beginPanelDrag",
      "floatPanel",
      "getHostState",
      "getPanelState",
      "getWorkspaceState",
      "onDragPreview",
      "onHostChanged",
      "onPanelStateChanged",
      "onWorkspaceState",
      "readPanelSnapshot",
      "redockPanel",
      "reorderTab",
      "setActivePanel",
      "setSplitRatio",
    ]);

    api.setActivePanel({ tabsNodeId: "tabs-1", panelId: "panel-1" });
    api.reorderTab({
      tabsNodeId: "tabs-1",
      panelId: "panel-1",
      targetIndex: 0,
    });
    api.setSplitRatio({ splitNodeId: "split-1", ratio: 0.4 });
    api.beginPanelDrag({
      panelId: "panel-1",
      anchor: { x: 10, y: 12 },
    });
    void api.readPanelSnapshot();

    expect(electronMocks.send).toHaveBeenNthCalledWith(
      1,
      IPC.setActivePanel,
      { tabsNodeId: "tabs-1", panelId: "panel-1" },
    );
    expect(electronMocks.send).toHaveBeenNthCalledWith(
      2,
      IPC.reorderTab,
      {
        tabsNodeId: "tabs-1",
        panelId: "panel-1",
        targetIndex: 0,
      },
    );
    expect(electronMocks.send).toHaveBeenNthCalledWith(
      3,
      IPC.setSplitRatio,
      { splitNodeId: "split-1", ratio: 0.4 },
    );
    expect(electronMocks.send).toHaveBeenNthCalledWith(
      4,
      IPC.beginPanelDrag,
      { panelId: "panel-1", anchor: { x: 10, y: 12 } },
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith(IPC.panelSnapshot);
  });
});
