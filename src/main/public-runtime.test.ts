import type { DockLayoutState, Rectangle } from "../core/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface BrowserWindowDouble {
  readonly webContents: { readonly id: number; readonly mainFrame: object };
  destroyed: boolean;
  shown: boolean;
  loadUrlCalls: number;
  menuCalls: number;
  menuBarCalls: number;
  closeCalls: number;
  destroyCalls: number;
  close(): void;
  destroy(): void;
}

interface WorkspaceDouble {
  disposed: boolean;
  readonly shellWebContentsId: number;
  readonly panelWebContents: {
    readonly id: number;
    readonly mainFrame: object;
  };
  bounds: Rectangle;
  visible: boolean;
  interactionEnabled: boolean;
  shellAppearance: unknown;
  shellAppearanceCalls: unknown[];
  flushPersistence(): Promise<void>;
  floatCalls: number;
  redockCalls: number;
  reorderCalls: Array<{
    readonly tabsNodeId: string;
    readonly panelId: string;
    readonly targetIndex: number;
  }>;
}

interface DragControllerDouble {
  disposed: boolean;
  enabled: boolean;
}

const testState = vi.hoisted(() => ({
  nextWebContentsId: 1,
  windows: [] as BrowserWindowDouble[],
  workspaces: [] as WorkspaceDouble[],
  dragControllers: [] as DragControllerDouble[],
  flushError: null as unknown,
  workspaceLoadHook: null as (
    ((workspace: WorkspaceDouble) => void | Promise<void>) | null
  ),
  ipcHandlers: new Map<string, unknown>(),
  ipcListeners: new Map<string, Set<unknown>>(),
}));

vi.mock("electron", () => {
  class BrowserWindow {
    readonly webContents = {
      id: testState.nextWebContentsId++,
      mainFrame: {},
    };
    readonly contentView = {
      addChildView(): void {},
      removeChildView(): void {},
    };
    readonly #listeners = new Map<
      string,
      Array<{
        readonly listener: (...args: any[]) => void;
        readonly once: boolean;
      }>
    >();
    destroyed = false;
    shown = false;
    loadUrlCalls = 0;
    menuCalls = 0;
    menuBarCalls = 0;
    closeCalls = 0;
    destroyCalls = 0;

    constructor() {
      testState.windows.push(this);
    }

    setMenu(): void {
      this.menuCalls += 1;
    }

    setMenuBarVisibility(): void {
      this.menuBarCalls += 1;
    }

    async loadURL(): Promise<void> {
      this.loadUrlCalls += 1;
    }

    getContentBounds(): Rectangle {
      return { x: 10, y: 20, width: 900, height: 700 };
    }

    show(): void {
      this.shown = true;
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    on(name: string, listener: (...args: any[]) => void): this {
      const listeners = this.#listeners.get(name) ?? [];
      listeners.push({ listener, once: false });
      this.#listeners.set(name, listeners);
      return this;
    }

    once(name: string, listener: (...args: any[]) => void): this {
      const listeners = this.#listeners.get(name) ?? [];
      listeners.push({ listener, once: true });
      this.#listeners.set(name, listeners);
      return this;
    }

    off(name: string, listener: (...args: any[]) => void): this {
      this.#listeners.set(
        name,
        (this.#listeners.get(name) ?? []).filter(
          (entry) => entry.listener !== listener,
        ),
      );
      return this;
    }

    close(): void {
      this.closeCalls += 1;
      if (this.destroyed) return;
      let prevented = false;
      this.#emit("close", {
        preventDefault(): void {
          prevented = true;
        },
      });
      if (prevented || this.destroyed) return;
      this.destroyed = true;
      this.#emit("closed");
    }

    destroy(): void {
      this.destroyCalls += 1;
      if (this.destroyed) return;
      this.destroyed = true;
      this.#emit("closed");
    }

    #emit(name: string, ...args: any[]): void {
      const listeners = [...(this.#listeners.get(name) ?? [])];
      this.#listeners.set(
        name,
        (this.#listeners.get(name) ?? []).filter((entry) => !entry.once),
      );
      for (const entry of listeners) entry.listener(...args);
    }
  }

  return {
    app: {
      isReady: () => true,
    },
    BrowserWindow,
    ipcMain: {
      handle(channel: string, listener: unknown): void {
        testState.ipcHandlers.set(channel, listener);
      },
      removeHandler(channel: string): void {
        testState.ipcHandlers.delete(channel);
      },
      on(channel: string, listener: unknown): void {
        const listeners = testState.ipcListeners.get(channel) ?? new Set();
        listeners.add(listener);
        testState.ipcListeners.set(channel, listeners);
      },
      off(channel: string, listener: unknown): void {
        testState.ipcListeners.get(channel)?.delete(listener);
      },
    },
  };
});

vi.mock("./dock-workspace-host.js", () => {
  class DockWorkspaceHost {
    readonly shellWebContentsId = testState.nextWebContentsId++;
    readonly panelWebContents = {
      id: 500,
      mainFrame: {},
    };
    readonly layout = {
      version: 1,
      nextNodeSequence: 1,
      root: null,
      floating: [],
    };
    readonly geometry = {
      viewports: [],
      titleBars: [],
      tabStrips: [],
      splitters: [],
      dropZones: [],
      boundaryDropZones: [],
    };
    readonly #listeners = new Set<() => void>();
    disposed = false;
    bounds: Rectangle;
    visible: boolean;
    interactionEnabled: boolean;
    shellAppearance: unknown;
    shellAppearanceCalls: unknown[] = [];
    host: "docked" | "floating" = "docked";
    floatCalls = 0;
    redockCalls = 0;
    reorderCalls: Array<{
      readonly tabsNodeId: string;
      readonly panelId: string;
      readonly targetIndex: number;
    }> = [];

    constructor(readonly options: any) {
      this.bounds = options.shellView.bounds;
      this.visible = options.shellView.visible;
      this.interactionEnabled = options.shellView.interactionEnabled;
      this.shellAppearance = options.shellAppearance ?? null;
      testState.workspaces.push(this);
    }

    async load(): Promise<void> {
      await testState.workspaceLoadHook?.(this);
    }

    snapshot() {
      return {
        panels: [{ id: "panel", title: "Panel" }],
        layout: this.layout,
        geometry: this.geometry,
        interactionEnabled: this.interactionEnabled,
        shellAppearance: this.shellAppearance,
      };
    }

    panelStates() {
      return [{
        panelId: "panel",
        host: this.host,
        active: true,
        requestedVisible: true,
        visible: this.visible,
        webContentsId: 500,
      }];
    }

    onDidChange(listener: () => void): () => void {
      this.#listeners.add(listener);
      return () => {
        this.#listeners.delete(listener);
      };
    }

    setBounds(bounds: Rectangle): void {
      this.bounds = bounds;
      this.#emit();
    }

    setVisible(visible: boolean): void {
      this.visible = visible;
      this.#emit();
    }

    setInteractionEnabled(enabled: boolean): void {
      this.interactionEnabled = enabled;
      this.#emit();
    }

    setShellAppearance(appearance: unknown): void {
      this.shellAppearance = appearance;
      this.shellAppearanceCalls.push(appearance);
      this.#emit();
    }

    setPanelVisible(): void {
      this.#emit();
    }

    activatePanelById(): void {
      this.#emit();
    }

    reorderTab(
      tabsNodeId: string,
      panelId: string,
      targetIndex: number,
    ): void {
      this.reorderCalls.push({ tabsNodeId, panelId, targetIndex });
      this.#emit();
    }

    floatPanel(): { snapshot(): object } {
      this.floatCalls += 1;
      this.host = "floating";
      this.#emit();
      return { snapshot: () => ({}) };
    }

    redockPanel(): void {
      this.redockCalls += 1;
      this.host = "docked";
      this.#emit();
    }

    dockPanel(): void {
      this.#emit();
    }

    reset(): void {
      this.#emit();
    }

    hostByPanelId(panelId: string) {
      return panelId === "panel"
        ? {
          panelId,
          snapshot: () => ({
            panelId,
            host: this.host,
            webContentsId: 500,
          }),
          readRendererSnapshot: async () => null,
        }
        : null;
    }

    hostByWebContents(webContents: number | object) {
      return (
        typeof webContents === "number"
          ? webContents === this.panelWebContents.id
          : webContents === this.panelWebContents
      )
        ? this.hostByPanelId("panel")
        : null;
    }

    async flushPersistence(): Promise<void> {
      if (testState.flushError !== null) throw testState.flushError;
    }

    dispose(): void {
      this.disposed = true;
    }

    #emit(): void {
      for (const listener of this.#listeners) listener();
    }
  }

  return { DockWorkspaceHost };
});

vi.mock("./native-drag-controller.js", () => {
  class NativeDragController {
    disposed = false;
    enabled = true;

    constructor() {
      testState.dragControllers.push(this);
    }

    async initialize(): Promise<void> {}

    async begin(): Promise<void> {}

    setInteractionEnabled(enabled: boolean): void {
      this.enabled = enabled;
    }

    dispose(): void {
      this.disposed = true;
    }
  }

  return { NativeDragController };
});

vi.mock("./resources.js", () => ({
  resolveElectronDockResources: () => ({
    internalPreloadPath: "internal-preload.cjs",
    rendererHtmlPath: "renderer.html",
    nativeHelperPath: "native-helper.exe",
  }),
}));

import { BrowserWindow } from "electron";
import {
  createElectronDockRuntime,
  type ElectronDockRuntime,
} from "./public-runtime.js";
import { IPC } from "../shared/protocol.js";
import {
  DEFAULT_ELECTRON_DOCK_SHELL_APPEARANCE,
  normalizeElectronDockShellAppearance,
} from "../shared/shell-appearance.js";

let runtime: ElectronDockRuntime | null = null;

beforeEach(() => {
  testState.nextWebContentsId = 1;
  testState.windows.length = 0;
  testState.workspaces.length = 0;
  testState.dragControllers.length = 0;
  testState.flushError = null;
  testState.workspaceLoadHook = null;
  testState.ipcHandlers.clear();
  testState.ipcListeners.clear();
  runtime = createElectronDockRuntime();
});

afterEach(async () => {
  if (runtime !== null) {
    await runtime.dispose().catch(() => {});
    runtime = null;
  }
});

describe("ElectronDockRuntime attachWorkspace", () => {
  it("serves panel state during the panel's first load before publication", async () => {
    let firstScreenState: unknown;
    testState.workspaceLoadHook = (loadingWorkspace) => {
      const senderFrame = loadingWorkspace.panelWebContents.mainFrame;
      const event = {
        sender: loadingWorkspace.panelWebContents,
        senderFrame,
      };
      const invokeGetPanelState = testState.ipcHandlers.get(
        IPC.getPanelState,
      ) as (event: unknown) => unknown;
      const invokeFloat = testState.ipcHandlers.get(IPC.floatPanel) as (
        event: unknown,
        value?: unknown,
      ) => unknown;

      expect(runtime!.workspaceById("starting")).toBeNull();
      firstScreenState = invokeGetPanelState(event);
      const forgedFrame = {};
      expect(invokeGetPanelState({
        sender: { id: 500, mainFrame: forgedFrame },
        senderFrame: forgedFrame,
      })).toBeNull();
      expect(invokeGetPanelState({
        sender: loadingWorkspace.panelWebContents,
        senderFrame: {},
      })).toBeNull();
      expect(invokeFloat(event)).toBeNull();
      expect(loadingWorkspace.floatCalls).toBe(0);
    };

    const owner = new BrowserWindow() as unknown as BrowserWindowDouble;
    const workspace = await runtime!.attachWorkspace({
      ...baseOptions("starting"),
      window: owner as unknown as BrowserWindow,
      bounds: { x: 0, y: 0, width: 500, height: 400 },
    });

    expect(firstScreenState).toEqual({
      panelId: "panel",
      host: "docked",
      active: true,
      requestedVisible: true,
      visible: true,
      webContentsId: 500,
    });
    expect(runtime!.workspaceById("starting")).toBe(workspace);
  });

  it("revokes startup panel authority after load failure and exact-id reuse", async () => {
    const failure = new Error("panel load failed");
    let failedEvent: unknown;
    testState.workspaceLoadHook = (loadingWorkspace) => {
      const senderFrame = loadingWorkspace.panelWebContents.mainFrame;
      failedEvent = {
        sender: loadingWorkspace.panelWebContents,
        senderFrame,
      };
      const invokeGetPanelState = testState.ipcHandlers.get(
        IPC.getPanelState,
      ) as (event: unknown) => unknown;
      expect(invokeGetPanelState(failedEvent)).not.toBeNull();
      throw failure;
    };

    const owner = new BrowserWindow() as unknown as BrowserWindowDouble;
    await expect(runtime!.attachWorkspace({
      ...baseOptions("retry"),
      window: owner as unknown as BrowserWindow,
      bounds: { x: 0, y: 0, width: 500, height: 400 },
    })).rejects.toBe(failure);

    const invokeGetPanelState = testState.ipcHandlers.get(
      IPC.getPanelState,
    ) as (event: unknown) => unknown;
    expect(invokeGetPanelState(failedEvent)).toBeNull();
    expect(testState.workspaces[0]?.disposed).toBe(true);

    testState.workspaceLoadHook = null;
    const replacement = await runtime!.attachWorkspace({
      ...baseOptions("retry"),
      window: owner as unknown as BrowserWindow,
      bounds: { x: 0, y: 0, width: 500, height: 400 },
    });
    const replacementState = testState.workspaces[1]!;
    const replacementEvent = {
      sender: replacementState.panelWebContents,
      senderFrame: replacementState.panelWebContents.mainFrame,
    };

    expect(invokeGetPanelState(failedEvent)).toBeNull();
    expect(invokeGetPanelState(replacementEvent)).not.toBeNull();
    await replacement.dispose();
  });

  it("revokes startup panel authority before waiting for runtime disposal", async () => {
    let releaseLoad!: () => void;
    const loadBarrier = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let started!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let startupEvent: unknown;
    testState.workspaceLoadHook = async (loadingWorkspace) => {
      startupEvent = {
        sender: loadingWorkspace.panelWebContents,
        senderFrame: loadingWorkspace.panelWebContents.mainFrame,
      };
      started();
      await loadBarrier;
    };

    const owner = new BrowserWindow() as unknown as BrowserWindowDouble;
    const attach = runtime!.attachWorkspace({
      ...baseOptions("disposing"),
      window: owner as unknown as BrowserWindow,
      bounds: { x: 0, y: 0, width: 500, height: 400 },
    });
    await loadStarted;
    const invokeGetPanelState = testState.ipcHandlers.get(
      IPC.getPanelState,
    ) as (event: unknown) => unknown;
    expect(invokeGetPanelState(startupEvent)).not.toBeNull();

    const disposal = runtime!.dispose();
    expect(invokeGetPanelState(startupEvent)).toBeNull();
    releaseLoad();

    await expect(attach).rejects.toThrow(
      "runtime was disposed while workspace creation was in progress",
    );
    await disposal;
  });

  it("does not reload, close, destroy, or change the owner menu", async () => {
    const owner = new BrowserWindow() as unknown as BrowserWindowDouble;
    const workspace = await runtime!.attachWorkspace({
      ...baseOptions("attached"),
      window: owner as unknown as BrowserWindow,
      bounds: { x: 40, y: 60, width: 640, height: 420 },
    });

    expect(owner.loadUrlCalls).toBe(0);
    expect(owner.menuCalls).toBe(0);
    expect(owner.menuBarCalls).toBe(0);
    expect(runtime!.workspaceById("attached")).toBe(workspace);
    expect(runtime!.windowById("attached")).toBeNull();

    let changed = 0;
    const unsubscribe = workspace.onDidChange(() => {
      changed += 1;
    });
    workspace.setBounds({ x: 50, y: 70, width: 600, height: 380 });
    workspace.setInteractionEnabled(false);
    workspace.setVisible(false);
    workspace.setPanelVisible("panel", false);
    workspace.activatePanel("panel");
    workspace.float("panel");
    workspace.redock("panel");
    workspace.reset();
    unsubscribe();

    expect(changed).toBeGreaterThan(0);
    expect(workspace.snapshot()).toMatchObject({
      id: "attached",
      bounds: { x: 50, y: 70, width: 600, height: 380 },
      visible: false,
      interactionEnabled: false,
      panels: [{
        panelId: "panel",
        host: "docked",
        active: true,
        requestedVisible: true,
        visible: false,
        webContentsId: 500,
      }],
    });

    await workspace.dispose();
    expect(owner.closeCalls).toBe(0);
    expect(owner.destroyCalls).toBe(0);
    expect(owner.destroyed).toBe(false);
    expect(testState.workspaces[0]?.disposed).toBe(true);
    expect(testState.dragControllers[0]?.disposed).toBe(true);
  });

  it("delegates initial and dynamic shell appearance without replacing layout or WebContents", async () => {
    const owner = new BrowserWindow() as unknown as BrowserWindowDouble;
    const initialAppearance = normalizeElectronDockShellAppearance({
      colors: { shellBackground: "#151515" },
      titleBar: { background: "#202020", borderWidth: 0 },
    });
    const workspace = await runtime!.attachWorkspace({
      ...baseOptions("appearance"),
      window: owner as unknown as BrowserWindow,
      bounds: { x: 0, y: 0, width: 500, height: 400 },
      shellAppearance: initialAppearance,
    });
    const state = testState.workspaces[0]!;
    const initialSnapshot = workspace.snapshot();
    const panelWebContentsId = initialSnapshot.panels[0]?.webContentsId;
    const layoutIdentity = initialSnapshot.layout;

    expect(state.shellAppearance).toEqual(initialAppearance);
    expect(initialSnapshot.shellAppearance).toEqual(initialAppearance);

    workspace.setShellAppearance({
      tab: { activeForeground: "#abcdef" },
    });
    expect(state.shellAppearanceCalls).toEqual([
      { tab: { activeForeground: "#abcdef" } },
    ]);
    expect(workspace.snapshot().layout).toBe(layoutIdentity);
    expect(workspace.snapshot().panels[0]?.webContentsId).toBe(
      panelWebContentsId,
    );

    workspace.setShellAppearance(null);
    expect(state.shellAppearanceCalls.at(-1)).toBeNull();
    // The real DockWorkspaceHost performs normalization. The public wrapper
    // never scans or exposes the private shell WebContents.
    expect(DEFAULT_ELECTRON_DOCK_SHELL_APPEARANCE.colors.shellBackground)
      .toBe("#101313");
  });

  it("surfaces persistence failures while still cleaning attached resources", async () => {
    const owner = new BrowserWindow() as unknown as BrowserWindowDouble;
    const workspace = await runtime!.attachWorkspace({
      ...baseOptions("persistence"),
      window: owner as unknown as BrowserWindow,
      bounds: { x: 0, y: 0, width: 500, height: 400 },
    });
    const failure = new Error("write failed");
    testState.flushError = failure;

    await expect(workspace.flush()).rejects.toBe(failure);
    await expect(workspace.dispose()).rejects.toBe(failure);

    expect(owner.destroyed).toBe(false);
    expect(testState.workspaces[0]?.disposed).toBe(true);
    expect(testState.dragControllers[0]?.disposed).toBe(true);
  });

  it("rejects panel-originated float/redock while interaction is disabled or hidden", async () => {
    const owner = new BrowserWindow() as unknown as BrowserWindowDouble;
    const workspace = await runtime!.attachWorkspace({
      ...baseOptions("guarded"),
      window: owner as unknown as BrowserWindow,
      bounds: { x: 0, y: 0, width: 500, height: 400 },
    });
    const state = testState.workspaces[0]!;
    const senderFrame = state.panelWebContents.mainFrame;
    const event = {
      sender: state.panelWebContents,
      senderFrame,
    };
    const invokeFloat = testState.ipcHandlers.get(IPC.floatPanel) as (
      event: unknown,
      value?: unknown,
    ) => unknown;
    const invokeRedock = testState.ipcHandlers.get(IPC.redockPanel) as (
      event: unknown,
    ) => unknown;

    workspace.setInteractionEnabled(false);
    expect(invokeFloat(event)).toBeNull();
    expect(state.floatCalls).toBe(0);

    workspace.setInteractionEnabled(true);
    workspace.setVisible(false);
    expect(invokeRedock(event)).toBeNull();
    expect(state.redockCalls).toBe(0);
  });

  it("returns the stable public panel state after float and redock", async () => {
    const owner = new BrowserWindow() as unknown as BrowserWindowDouble;
    await runtime!.attachWorkspace({
      ...baseOptions("panel-state-results"),
      window: owner as unknown as BrowserWindow,
      bounds: { x: 0, y: 0, width: 500, height: 400 },
    });
    const state = testState.workspaces[0]!;
    const senderFrame = state.panelWebContents.mainFrame;
    const event = {
      sender: state.panelWebContents,
      senderFrame,
    };
    const invokeFloat = testState.ipcHandlers.get(IPC.floatPanel) as (
      event: unknown,
      value?: unknown,
    ) => unknown;
    const invokeRedock = testState.ipcHandlers.get(IPC.redockPanel) as (
      event: unknown,
    ) => unknown;

    expect(invokeFloat(event)).toEqual({
      panelId: "panel",
      host: "floating",
      active: true,
      requestedVisible: true,
      visible: true,
      webContentsId: 500,
    });
    expect(invokeRedock(event)).toEqual({
      panelId: "panel",
      host: "docked",
      active: true,
      requestedVisible: true,
      visible: true,
      webContentsId: 500,
    });
  });

  it("accepts tab reorder only from the enabled workspace shell main frame", async () => {
    const owner = new BrowserWindow() as unknown as BrowserWindowDouble;
    const workspace = await runtime!.attachWorkspace({
      ...baseOptions("tab-reorder"),
      window: owner as unknown as BrowserWindow,
      bounds: { x: 0, y: 0, width: 500, height: 400 },
    });
    const state = testState.workspaces[0]!;
    const senderFrame = {};
    const event = {
      sender: { id: state.shellWebContentsId, mainFrame: senderFrame },
      senderFrame,
    };
    const forgedFrameEvent = {
      sender: { id: state.shellWebContentsId, mainFrame: senderFrame },
      senderFrame: {},
    };
    const listener = [
      ...(testState.ipcListeners.get(IPC.reorderTab) ?? []),
    ][0];
    if (typeof listener !== "function") {
      throw new Error("Expected the tab reorder IPC listener");
    }
    const message = {
      tabsNodeId: "tabs-scenes",
      panelId: "map",
      targetIndex: 0,
    };

    listener(forgedFrameEvent, message);
    listener(event, { ...message, targetIndex: -1 });
    expect(state.reorderCalls).toEqual([]);

    listener(event, message);
    expect(state.reorderCalls).toEqual([message]);

    workspace.setInteractionEnabled(false);
    listener(event, { ...message, targetIndex: 1 });
    expect(state.reorderCalls).toEqual([message]);
  });
});

describe("ElectronDockRuntime createWindow compatibility", () => {
  it("uses the shared workspace primitive while retaining owned-window cleanup", async () => {
    const dockWindow = await runtime!.createWindow({
      ...baseOptions("owned"),
      show: false,
    });
    const owner = dockWindow.window as unknown as BrowserWindowDouble;

    expect(runtime!.windowById("owned")).toBe(dockWindow);
    expect(runtime!.workspaceById("owned")).not.toBeNull();
    expect(owner.loadUrlCalls).toBe(0);
    expect(owner.menuCalls).toBe(1);
    expect(owner.menuBarCalls).toBe(1);
    expect(owner.shown).toBe(false);

    await dockWindow.dispose();
    expect(owner.destroyed).toBe(true);
    expect(owner.destroyCalls).toBe(1);
  });
});

function baseOptions(id: string) {
  return {
    id,
    panels: [{ id: "panel", title: "Panel" }],
    initialLayout: {
      version: 1,
      nextNodeSequence: 2,
      root: {
        type: "tabs",
        id: "tabs-1",
        panelIds: ["panel"],
        activePanelId: "panel",
      },
      floating: [],
    } as DockLayoutState,
  };
}
