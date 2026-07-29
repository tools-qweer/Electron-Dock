import { BrowserWindow, screen, type BaseWindow } from "electron";
import path from "node:path";
import type { BeginPanelDragMessage } from "../shared/protocol.js";
import type { DockPanelHost } from "./dock-host.js";
import type { DockWorkspaceHost } from "./dock-workspace-host.js";
import {
  WindowsDragHelper,
  type NativeCursorEvent,
} from "./windows-drag-helper.js";

type DragMode = "custom" | "system";
const MAXIMUM_DRAG_DURATION_MS = 35_000;

/**
 * One native cursor monitor coordinates every panel in the workspace.
 *
 * A renderer-initiated drag starts as a transient floating window while its
 * logical position remains in the dock tree. Releasing outside the workspace
 * commits that float; releasing over a drop zone mutates the tree. A move
 * started from an existing floating window uses the same controller.
 */
export class NativeDragController {
  readonly #mainWindow: BrowserWindow;
  readonly #workspace: DockWorkspaceHost;
  readonly #helper: WindowsDragHelper;
  readonly #removeFloatingMoveListeners: (() => void)[] = [];
  readonly #removeMainWindowLifecycleListeners: (() => void)[] = [];
  readonly #removeActiveWindowLifecycleListeners: (() => void)[] = [];
  #mode: DragMode | null = null;
  #activePanelId: string | null = null;
  #dragDeadline: ReturnType<typeof setTimeout> | null = null;
  #enabled = true;
  #disposed = false;

  constructor(
    mainWindow: BrowserWindow,
    workspace: DockWorkspaceHost,
    nativeHelperPath?: string,
  ) {
    this.#mainWindow = mainWindow;
    this.#workspace = workspace;
    this.#helper = new WindowsDragHelper(
      nativeHelperPath
        ?? path.resolve(
          import.meta.dirname,
          "..",
          "native",
          "windows-drag-helper.exe",
        ),
    );
    this.#helper.on("move", (event) => {
      this.#handleMove(event);
    });
    this.#helper.on("release", (event) => {
      this.#finish(false, event);
    });
    this.#helper.on("cancel", (event) => {
      this.#finish(true, event);
    });
    this.#helper.on("error", (error) => {
      process.stderr.write(`Native drag helper: ${error.message}\n`);
      this.#forceCancel();
    });
    const cancelAnyDrag = (): void => {
      this.#forceCancel();
    };
    const cancelCustomDrag = (): void => {
      if (this.#mode === "custom") this.#forceCancel();
    };
    mainWindow.on("hide", cancelAnyDrag);
    mainWindow.on("minimize", cancelAnyDrag);
    mainWindow.on("closed", cancelAnyDrag);
    this.#removeMainWindowLifecycleListeners.push(
      () => mainWindow.off("hide", cancelAnyDrag),
      () => mainWindow.off("minimize", cancelAnyDrag),
      () => mainWindow.off("closed", cancelAnyDrag),
    );
    mainWindow.on("blur", cancelCustomDrag);
    this.#removeMainWindowLifecycleListeners.push(() => {
      mainWindow.off("blur", cancelCustomDrag);
    });
    for (const host of workspace.hosts) {
      this.#removeFloatingMoveListeners.push(
        host.onFloatingNativeMoveStarted(() => {
          void this.#beginSystemMoveMonitor(host);
        }),
      );
    }
  }

  async initialize(): Promise<void> {
    await this.#helper.warmup();
  }

  async begin(message: BeginPanelDragMessage): Promise<void> {
    if (!this.#enabled || this.#disposed || this.#mode !== null) return;
    const host = this.#workspace.hostByPanelId(message.panelId);
    if (host === null || host.host !== "docked") return;

    const cursor = screen.getCursorScreenPoint();
    const slot = host.getDockedScreenBounds();
    if (!anchorIsInside(message.anchor, slot)) return;

    const floatingHost = this.#workspace.beginTransientFloat(
      message.panelId,
      {
        x: Math.round(cursor.x - message.anchor.x),
        y: Math.round(cursor.y - message.anchor.y),
        // Keep the source dock's outer footprint. Inflating every detached
        // panel to 320 x 240 made the panel grow under the pointer and felt
        // unlike QDockWidget's direct tear-off.
        width: slot.width,
        height: slot.height,
      },
    );
    if (floatingHost === null || floatingHost.floatingWindow === null) return;

    this.#mode = "custom";
    this.#activePanelId = message.panelId;
    try {
      this.#armDragLifecycle(floatingHost.floatingWindow);
      floatingHost.alignFloatingPointer(message.anchor, cursor);
      floatingHost.setFloatingDragInteraction(true);
      this.#workspace.setDragPreview(message.panelId, null);
      await this.#helper.begin(floatingHost.floatingWindow);
    } catch (error) {
      process.stderr.write(`Native drag start failed: ${String(error)}\n`);
      this.#forceCancel();
    }
  }

  setInteractionEnabled(enabled: boolean): void {
    if (this.#disposed || this.#enabled === enabled) return;
    this.#enabled = enabled;
    if (!enabled) this.#forceCancel();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#forceCancel();
    this.#disposed = true;
    this.#clearDragLifecycle();
    this.#workspace.clearDragPreview();
    for (const removeListener of this.#removeFloatingMoveListeners) {
      removeListener();
    }
    this.#removeFloatingMoveListeners.length = 0;
    for (const removeListener of this.#removeMainWindowLifecycleListeners) {
      removeListener();
    }
    this.#removeMainWindowLifecycleListeners.length = 0;
    this.#helper.dispose();
  }

  #handleMove(event: NativeCursorEvent): void {
    const panelId = this.#activePanelId;
    if (this.#mode === null || panelId === null) return;
    const resolution = this.#workspace.dropResolutionAt(
      this.#toDipPoint(event),
      panelId,
    );
    this.#workspace.setDragPreview(panelId, resolution);
  }

  #finish(cancelled: boolean, event?: NativeCursorEvent): void {
    const mode = this.#mode;
    const panelId = this.#activePanelId;
    if (mode === null || panelId === null) return;
    this.#mode = null;
    this.#activePanelId = null;
    this.#clearDragLifecycle();

    const host = this.#workspace.hostByPanelId(panelId);
    const point = event === undefined
      ? screen.getCursorScreenPoint()
      : this.#toDipPoint(event);
    const resolution = cancelled
      ? null
      : this.#workspace.dropResolutionAt(point, panelId);

    if (mode === "custom" && cancelled) {
      this.#workspace.clearDragPreview();
      this.#workspace.cancelTransientFloat(panelId);
      return;
    }
    if (!cancelled && resolution !== null) {
      // Commit the exact candidate that produced the visible gap, avoiding a
      // release-time size change or one-frame snap back.
      this.#workspace.commitDockDrop(panelId, resolution);
      return;
    }
    this.#workspace.clearDragPreview();
    host?.setFloatingDragInteraction(false);
    this.#workspace.commitFloatingPanel(panelId);
  }

  async #beginSystemMoveMonitor(host: DockPanelHost): Promise<void> {
    if (
      this.#disposed
      || !this.#enabled
      || this.#mode !== null
      || host.host !== "floating"
      || host.floatingWindow === null
      || host.floatingWindow.isDestroyed()
    ) {
      return;
    }
    this.#mode = "system";
    this.#activePanelId = host.panelId;
    try {
      this.#armDragLifecycle(host.floatingWindow);
      this.#workspace.setDragPreview(
        host.panelId,
        this.#workspace.dropResolutionAt(
          screen.getCursorScreenPoint(),
          host.panelId,
        ),
      );
      await this.#helper.monitor(host.floatingWindow);
    } catch (error) {
      process.stderr.write(`Native titlebar monitor failed: ${String(error)}\n`);
      this.#forceCancel();
    }
  }

  #forceCancel(): void {
    if (this.#mode === null) return;
    this.#helper.cancelActive();
    this.#finish(true);
  }

  #armDragLifecycle(window: BaseWindow): void {
    this.#clearDragLifecycle();
    const cancel = (): void => {
      this.#forceCancel();
    };
    window.on("blur", cancel);
    window.on("hide", cancel);
    window.on("minimize", cancel);
    window.on("closed", cancel);
    this.#removeActiveWindowLifecycleListeners.push(
      () => window.off("blur", cancel),
      () => window.off("hide", cancel),
      () => window.off("minimize", cancel),
      () => window.off("closed", cancel),
    );
    this.#dragDeadline = setTimeout(() => {
      process.stderr.write("Native drag helper exceeded its maximum duration\n");
      this.#forceCancel();
    }, MAXIMUM_DRAG_DURATION_MS);
    this.#dragDeadline.unref();
  }

  #clearDragLifecycle(): void {
    if (this.#dragDeadline !== null) {
      clearTimeout(this.#dragDeadline);
      this.#dragDeadline = null;
    }
    for (const removeListener of this.#removeActiveWindowLifecycleListeners) {
      removeListener();
    }
    this.#removeActiveWindowLifecycleListeners.length = 0;
  }

  #toDipPoint(event: NativeCursorEvent): Electron.Point {
    return screen.screenToDipPoint({ x: event.x, y: event.y });
  }
}

function anchorIsInside(
  anchor: BeginPanelDragMessage["anchor"],
  bounds: Electron.Rectangle,
): boolean {
  return anchor.x >= 0
    && anchor.y >= 0
    && anchor.x <= bounds.width
    && anchor.y <= bounds.height;
}
