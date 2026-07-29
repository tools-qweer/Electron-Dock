import type { BaseWindow, BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DockPanelHost } from "./dock-host.js";
import type { DockWorkspaceHost } from "./dock-workspace-host.js";

interface HelperDouble {
  readonly listeners: Map<string, (...args: any[]) => void>;
  readonly warmup: ReturnType<typeof vi.fn>;
  readonly begin: ReturnType<typeof vi.fn>;
  readonly monitor: ReturnType<typeof vi.fn>;
  readonly cancelActive: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  emit(name: string, ...args: unknown[]): void;
}

const helperState = vi.hoisted(() => ({
  instances: [] as HelperDouble[],
}));
const electronState = vi.hoisted(() => ({
  cursor: { x: 400, y: 300 },
}));

vi.mock("./windows-drag-helper.js", () => ({
  WindowsDragHelper: class {
    readonly listeners = new Map<string, (...args: any[]) => void>();
    readonly warmup = vi.fn(async () => undefined);
    readonly begin = vi.fn(async () => undefined);
    readonly monitor = vi.fn(async () => undefined);
    readonly cancelActive = vi.fn();
    readonly dispose = vi.fn();

    constructor() {
      helperState.instances.push(this);
    }

    on(name: string, listener: (...args: any[]) => void): this {
      this.listeners.set(name, listener);
      return this;
    }

    emit(name: string, ...args: unknown[]): void {
      this.listeners.get(name)?.(...args);
    }
  },
}));

vi.mock("electron", () => ({
  BrowserWindow: class {},
  screen: {
    getCursorScreenPoint: () => ({ ...electronState.cursor }),
    screenToDipPoint: (point: Electron.Point) => point,
  },
}));

import { NativeDragController } from "./native-drag-controller.js";

class WindowDouble {
  readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  destroyed = false;

  on(name: string, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
    return this;
  }

  off(name: string, listener: (...args: any[]) => void): this {
    this.listeners.get(name)?.delete(listener);
    return this;
  }

  emit(name: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      listener(...args);
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

interface Harness {
  readonly controller: NativeDragController;
  readonly helper: HelperDouble;
  readonly mainWindow: WindowDouble;
  readonly floatingWindow: WindowDouble;
  readonly host: DockPanelHost & {
    host: "docked" | "floating";
    floatingWindow: BaseWindow | null;
  };
  readonly workspace: {
    readonly cancelTransientFloat: ReturnType<typeof vi.fn>;
    readonly clearDragPreview: ReturnType<typeof vi.fn>;
    readonly commitFloatingPanel: ReturnType<typeof vi.fn>;
    readonly setDragPreview: ReturnType<typeof vi.fn>;
  };
  startSystemMove(): void;
}

function createHarness(): Harness {
  const mainWindow = new WindowDouble();
  const floatingWindow = new WindowDouble();
  let systemMoveListener: (() => void) | null = null;
  const host = {
    panelId: "hierarchy",
    host: "docked" as "docked" | "floating",
    floatingWindow: null as BaseWindow | null,
    getDockedScreenBounds: vi.fn(() => ({
      x: 0,
      y: 0,
      width: 280,
      height: 640,
    })),
    alignFloatingPointer: vi.fn(),
    setFloatingDragInteraction: vi.fn(),
    onFloatingNativeMoveStarted: vi.fn((listener: () => void) => {
      systemMoveListener = listener;
      return () => {
        if (systemMoveListener === listener) systemMoveListener = null;
      };
    }),
  } as unknown as Harness["host"];
  const workspace = {
    hosts: [host],
    hostByPanelId: vi.fn((panelId: string) => (
      panelId === host.panelId ? host : null
    )),
    beginTransientFloat: vi.fn(() => {
      host.host = "floating";
      host.floatingWindow = floatingWindow as unknown as BaseWindow;
      return host;
    }),
    setDragPreview: vi.fn(),
    clearDragPreview: vi.fn(),
    dropResolutionAt: vi.fn(() => null),
    cancelTransientFloat: vi.fn(() => {
      host.host = "docked";
      host.floatingWindow = null;
    }),
    commitDockDrop: vi.fn(),
    commitFloatingPanel: vi.fn(),
  };
  const controller = new NativeDragController(
    mainWindow as unknown as BrowserWindow,
    workspace as unknown as DockWorkspaceHost,
    "windows-drag-helper.exe",
  );
  const helper = helperState.instances.at(-1);
  if (!helper) throw new Error("missing helper double");
  return {
    controller,
    helper,
    mainWindow,
    floatingWindow,
    host,
    workspace,
    startSystemMove(): void {
      if (!systemMoveListener) throw new Error("missing system move listener");
      systemMoveListener();
    },
  };
}

beforeEach(() => {
  helperState.instances.length = 0;
  electronState.cursor = { x: 400, y: 300 };
});

describe("NativeDragController", () => {
  it("force-cancels a custom drag on owner blur and permits the next drag", async () => {
    const harness = createHarness();
    await harness.controller.begin({
      panelId: "hierarchy",
      anchor: { x: 20, y: 12 },
    });

    harness.mainWindow.emit("blur");

    expect(harness.helper.cancelActive).toHaveBeenCalledOnce();
    expect(harness.workspace.cancelTransientFloat).toHaveBeenCalledWith("hierarchy");
    await harness.controller.begin({
      panelId: "hierarchy",
      anchor: { x: 20, y: 12 },
    });
    expect(harness.helper.begin).toHaveBeenCalledTimes(2);
    harness.controller.dispose();
  });

  it("uses an absolute watchdog to recover from a missing native release", async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const harness = createHarness();
      await harness.controller.begin({
        panelId: "hierarchy",
        anchor: { x: 20, y: 12 },
      });

      await vi.advanceTimersByTimeAsync(35_000);

      expect(harness.helper.cancelActive).toHaveBeenCalledOnce();
      expect(harness.workspace.cancelTransientFloat).toHaveBeenCalledWith("hierarchy");
      harness.controller.dispose();
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not kill a healthy helper when native cancellation completes normally", async () => {
    const harness = createHarness();
    await harness.controller.begin({
      panelId: "hierarchy",
      anchor: { x: 20, y: 12 },
    });

    harness.helper.emit("cancel", { x: 420, y: 320 });

    expect(harness.helper.cancelActive).not.toHaveBeenCalled();
    expect(harness.workspace.cancelTransientFloat).toHaveBeenCalledWith("hierarchy");
    harness.controller.dispose();
  });

  it("restores an existing floating panel when its native move loses focus", async () => {
    const harness = createHarness();
    harness.host.host = "floating";
    harness.host.floatingWindow = harness.floatingWindow as unknown as BaseWindow;

    harness.startSystemMove();
    await vi.waitFor(() => expect(harness.helper.monitor).toHaveBeenCalledOnce());
    harness.floatingWindow.emit("blur");

    expect(harness.helper.cancelActive).toHaveBeenCalledOnce();
    expect(harness.host.setFloatingDragInteraction).toHaveBeenCalledWith(false);
    expect(harness.workspace.commitFloatingPanel).toHaveBeenCalledWith("hierarchy");
    harness.controller.dispose();
  });

  it("cancels an active drag before disabling interaction or disposing", async () => {
    const harness = createHarness();
    await harness.controller.begin({
      panelId: "hierarchy",
      anchor: { x: 20, y: 12 },
    });

    harness.controller.setInteractionEnabled(false);
    harness.controller.dispose();

    expect(harness.helper.cancelActive).toHaveBeenCalledOnce();
    expect(harness.workspace.cancelTransientFloat).toHaveBeenCalledWith("hierarchy");
    expect(harness.helper.dispose).toHaveBeenCalledOnce();
    expect(harness.mainWindow.listeners.get("blur")?.size ?? 0).toBe(0);
  });
});
