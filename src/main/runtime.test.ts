import type { DockLayoutState } from "../core/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface BrowserWindowDouble {
  destroyed: boolean;
  shown: boolean;
  close(): void;
  destroy(): void;
}

interface WorkspaceDouble {
  disposed: boolean;
}

interface DragControllerDouble {
  disposed: boolean;
}

const testState = vi.hoisted(() => ({
  nextWebContentsId: 1,
  windows: [] as BrowserWindowDouble[],
  workspaces: [] as WorkspaceDouble[],
  dragControllers: [] as DragControllerDouble[],
  workspaceLoadDeferred: null as Deferred | null,
  loadUrlError: null as unknown,
  flushError: null as unknown,
  ipcHandlers: new Map<string, unknown>(),
  ipcListeners: new Map<string, Set<unknown>>(),
}));

vi.mock("electron", () => {
  class BrowserWindow {
    readonly webContents = {
      id: testState.nextWebContentsId++,
      mainFrame: {},
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

    constructor() {
      testState.windows.push(this);
    }

    setMenu(): void {}
    setMenuBarVisibility(): void {}

    async loadURL(): Promise<void> {
      if (testState.loadUrlError !== null) throw testState.loadUrlError;
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

    close(): void {
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
    disposed = false;

    constructor() {
      testState.workspaces.push(this);
    }

    async load(): Promise<void> {
      await testState.workspaceLoadDeferred?.promise;
    }

    async flushPersistence(): Promise<void> {
      if (testState.flushError !== null) throw testState.flushError;
    }

    dispose(): void {
      this.disposed = true;
    }

    snapshot(): null {
      return null;
    }

    hostByWebContents(): null {
      return null;
    }

    hostByPanelId(): null {
      return null;
    }
  }

  return { DockWorkspaceHost };
});

vi.mock("./native-drag-controller.js", () => {
  class NativeDragController {
    disposed = false;

    constructor() {
      testState.dragControllers.push(this);
    }

    async initialize(): Promise<void> {}

    async begin(): Promise<void> {}

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

import {
  createElectronDockRuntime,
  type ElectronDockRuntime,
} from "./runtime.js";

let runtime: ElectronDockRuntime | null = null;

beforeEach(() => {
  testState.nextWebContentsId = 1;
  testState.windows.length = 0;
  testState.workspaces.length = 0;
  testState.dragControllers.length = 0;
  testState.workspaceLoadDeferred = null;
  testState.loadUrlError = null;
  testState.flushError = null;
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

describe("ElectronDockRuntime lifecycle", () => {
  it("reserves a window id while asynchronous creation is pending", async () => {
    const load = deferred();
    testState.workspaceLoadDeferred = load;
    const first = runtime!.createWindow(windowOptions("shared"));

    await expect(
      runtime!.createWindow(windowOptions("shared")),
    ).rejects.toThrow(/already in use/);

    load.resolve();
    await expect(first).resolves.toMatchObject({ id: "shared" });
  });

  it("tears down a window created concurrently with runtime disposal", async () => {
    const load = deferred();
    testState.workspaceLoadDeferred = load;
    const creating = runtime!.createWindow(windowOptions("racing"));
    const disposing = runtime!.dispose();

    load.resolve();

    await expect(creating).rejects.toThrow(/disposed while createWindow/);
    await expect(disposing).resolves.toBeUndefined();
    expect(testState.windows[0]?.destroyed).toBe(true);
    expect(testState.workspaces[0]?.disposed).toBe(true);
    expect(testState.dragControllers[0]?.disposed).toBe(true);
    runtime = null;
  });

  it("destroys the BrowserWindow when shell loading fails", async () => {
    testState.loadUrlError = new Error("shell failed");

    await expect(
      runtime!.createWindow(windowOptions("load-failure")),
    ).rejects.toThrow("shell failed");

    expect(testState.windows[0]?.destroyed).toBe(true);
    expect(testState.workspaces).toHaveLength(0);
  });

  it("disposes a partially loaded workspace when workspace loading fails", async () => {
    const load = deferred();
    testState.workspaceLoadDeferred = load;
    const creating = runtime!.createWindow(windowOptions("workspace-failure"));

    load.reject(new Error("workspace failed"));

    await expect(creating).rejects.toThrow("workspace failed");
    expect(testState.windows[0]?.destroyed).toBe(true);
    expect(testState.workspaces[0]?.disposed).toBe(true);
    expect(testState.dragControllers).toHaveLength(0);
  });

  it("cleans every resource and releases the singleton when flush fails", async () => {
    await runtime!.createWindow(windowOptions("flush-failure"));
    const flushError = new Error("flush failed");
    testState.flushError = flushError;

    await expect(runtime!.dispose()).rejects.toBe(flushError);

    expect(testState.windows[0]?.destroyed).toBe(true);
    expect(testState.workspaces[0]?.disposed).toBe(true);
    expect(testState.dragControllers[0]?.disposed).toBe(true);
    expect(testState.ipcHandlers.size).toBe(0);
    expect(
      [...testState.ipcListeners.values()].every((listeners) => (
        listeners.size === 0
      )),
    ).toBe(true);

    runtime = createElectronDockRuntime();
  });

  it("catches close-event flush errors while still closing and cleaning up", async () => {
    await runtime!.createWindow(windowOptions("native-close"));
    testState.flushError = new Error("close flush failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    testState.windows[0]!.close();
    await new Promise((resolve) => setImmediate(resolve));

    expect(testState.windows[0]?.destroyed).toBe(true);
    expect(testState.workspaces[0]?.disposed).toBe(true);
    expect(testState.dragControllers[0]?.disposed).toBe(true);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("close failed"),
      testState.flushError,
    );
    consoleError.mockRestore();
  });
});

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function windowOptions(id: string) {
  return {
    id,
    panels: [{ id: "panel", title: "Panel" }],
    initialLayout: {
      schemaVersion: 1,
      revision: 0,
      root: {
        kind: "tabs",
        id: "tabs",
        panelIds: ["panel"],
        activePanelId: "panel",
      },
      floating: [],
    } as unknown as DockLayoutState,
    show: false,
  };
}
