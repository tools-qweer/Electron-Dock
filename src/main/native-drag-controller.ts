import { BrowserWindow, screen } from "electron";
import path from "node:path";
import type { BeginPanelDragMessage } from "../shared/protocol.js";
import type { DockPanelHost } from "./dock-host.js";
import type { DockWorkspaceHost } from "./dock-workspace-host.js";
import {
  WindowsDragHelper,
  type NativeCursorEvent,
} from "./windows-drag-helper.js";

type DragMode = "custom" | "system";

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
  #mode: DragMode | null = null;
  #activePanelId: string | null = null;
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
      this.#finish(true);
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
    floatingHost.alignFloatingPointer(message.anchor, cursor);
    floatingHost.setFloatingDragInteraction(true);
    this.#workspace.setDragPreview(message.panelId, null);
    try {
      await this.#helper.begin(floatingHost.floatingWindow);
    } catch (error) {
      process.stderr.write(`Native drag start failed: ${String(error)}\n`);
      this.#finish(true);
    }
  }

  setInteractionEnabled(enabled: boolean): void {
    if (this.#disposed || this.#enabled === enabled) return;
    this.#enabled = enabled;
    if (!enabled) this.#finish(true);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#mode = null;
    this.#activePanelId = null;
    this.#workspace.clearDragPreview();
    for (const removeListener of this.#removeFloatingMoveListeners) {
      removeListener();
    }
    this.#removeFloatingMoveListeners.length = 0;
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
    this.#workspace.setDragPreview(
      host.panelId,
      this.#workspace.dropResolutionAt(
        screen.getCursorScreenPoint(),
        host.panelId,
      ),
    );
    try {
      await this.#helper.monitor(host.floatingWindow);
    } catch (error) {
      process.stderr.write(`Native titlebar monitor failed: ${String(error)}\n`);
      this.#finish(true);
    }
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
