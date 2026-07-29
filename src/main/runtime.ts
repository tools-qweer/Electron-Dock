import {
  app,
  BrowserWindow,
  ipcMain,
  type BrowserWindowConstructorOptions,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { pathToFileURL } from "node:url";
import type { AtomicLayoutTextStorage } from "../core/layout-persistence.js";
import type {
  DockLayoutState,
  DockPanelDefinition,
  Rectangle,
} from "../core/types.js";
import {
  IPC,
  isBeginPanelDragMessage,
  isRectangle,
  isSetActivePanelMessage,
  isSetSplitRatioMessage,
} from "../shared/protocol.js";
import type { DockPanelContentOptions } from "./dock-host.js";
import { DockWorkspaceHost } from "./dock-workspace-host.js";
import { NativeDragController } from "./native-drag-controller.js";
import {
  resolveElectronDockResources,
  type ElectronDockResourceOptions,
} from "./resources.js";

export interface ElectronDockPanelDefinition extends DockPanelDefinition {
  /**
   * Consumer-owned page rendered inside this panel. If omitted, the bundled
   * diagnostic panel is used; production consumers should normally provide it.
   */
  readonly content?: DockPanelContentOptions;
}

export interface ElectronDockWindowOptions extends ElectronDockResourceOptions {
  readonly id: string;
  readonly panels: readonly ElectronDockPanelDefinition[];
  readonly initialLayout: DockLayoutState;
  readonly layoutFilePath?: string;
  readonly storage?: AtomicLayoutTextStorage;
  readonly windowOptions?: BrowserWindowConstructorOptions;
  readonly show?: boolean;
}

export interface ElectronDockWindow {
  readonly id: string;
  readonly window: BrowserWindow;
  show(): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ElectronDockRuntime {
  createWindow(
    options: ElectronDockWindowOptions,
  ): Promise<ElectronDockWindow>;
  windowById(id: string): ElectronDockWindow | null;
  dispose(): Promise<void>;
}

let activeRuntime: ElectronDockRuntimeImpl | null = null;

/**
 * Creates the main-process authority for Electron Dock.
 *
 * Importing this module has no Electron lifecycle side effects. The consumer
 * must wait for `app.whenReady()` before calling `createWindow()` and must
 * dispose the runtime from its own shutdown flow.
 */
export function createElectronDockRuntime(): ElectronDockRuntime {
  if (activeRuntime !== null && !activeRuntime.disposed) {
    throw new Error(
      "Only one Electron Dock runtime may be active in an Electron process.",
    );
  }
  const runtime = new ElectronDockRuntimeImpl(() => {
    if (activeRuntime === runtime) activeRuntime = null;
  });
  activeRuntime = runtime;
  return runtime;
}

class ElectronDockRuntimeImpl implements ElectronDockRuntime {
  readonly #entries = new Map<string, ElectronDockWindowImpl>();
  readonly #pendingCreates = new Map<
    string,
    Promise<ElectronDockWindowImpl>
  >();
  readonly #onDisposed: () => void;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  readonly #handleGetWorkspaceState = (
    event: IpcMainInvokeEvent,
  ): ReturnType<DockWorkspaceHost["snapshot"]> | null => {
    return this.#shellEntry(event)?.workspace.snapshot() ?? null;
  };

  readonly #handleSetActivePanel = (
    event: IpcMainEvent,
    value: unknown,
  ): void => {
    const entry = this.#shellEntry(event);
    if (entry === null || !isSetActivePanelMessage(value)) return;
    entry.workspace.activatePanel(value.tabsNodeId, value.panelId);
  };

  readonly #handleSetSplitRatio = (
    event: IpcMainEvent,
    value: unknown,
  ): void => {
    const entry = this.#shellEntry(event);
    if (entry === null || !isSetSplitRatioMessage(value)) return;
    entry.workspace.resizeSplit(value.splitNodeId, value.ratio);
  };

  readonly #handleFloatPanel = (
    event: IpcMainInvokeEvent,
    value: unknown,
  ): unknown => {
    const located = this.#panelEntry(event);
    if (located === null) return null;
    const bounds = isRectangle(value) ? value : undefined;
    return located.entry.workspace
      .floatPanel(located.panelId, bounds)
      ?.snapshot() ?? null;
  };

  readonly #handleRedockPanel = (event: IpcMainInvokeEvent): unknown => {
    const located = this.#panelEntry(event);
    if (located === null) return null;
    located.entry.workspace.redockPanel(located.panelId);
    return located.entry.workspace.hostByPanelId(located.panelId)?.snapshot()
      ?? null;
  };

  readonly #handlePanelSnapshot = async (
    event: IpcMainInvokeEvent,
  ): Promise<unknown> => {
    const located = this.#panelEntry(event);
    return located === null
      ? null
      : located.entry.workspace
        .hostByPanelId(located.panelId)
        ?.readRendererSnapshot() ?? null;
  };

  readonly #handleGetHostState = (event: IpcMainInvokeEvent): unknown => {
    const located = this.#panelEntry(event);
    if (located === null) return null;
    const snapshot = located.entry.workspace
      .hostByPanelId(located.panelId)
      ?.snapshot();
    return snapshot === undefined
      ? null
      : {
        panelId: snapshot.panelId,
        host: snapshot.host,
        webContentsId: snapshot.webContentsId,
      };
  };

  readonly #handleBeginPanelDrag = (
    event: IpcMainEvent,
    value: unknown,
  ): void => {
    const entry = this.#shellEntry(event);
    if (
      entry === null
      || !isBeginPanelDragMessage(value)
      || entry.workspace.hostByPanelId(value.panelId) === null
    ) {
      return;
    }
    void entry.dragController.begin(value);
  };

  constructor(onDisposed: () => void) {
    this.#onDisposed = onDisposed;
    ipcMain.handle(IPC.getWorkspaceState, this.#handleGetWorkspaceState);
    ipcMain.on(IPC.setActivePanel, this.#handleSetActivePanel);
    ipcMain.on(IPC.setSplitRatio, this.#handleSetSplitRatio);
    ipcMain.handle(IPC.floatPanel, this.#handleFloatPanel);
    ipcMain.handle(IPC.redockPanel, this.#handleRedockPanel);
    ipcMain.handle(IPC.panelSnapshot, this.#handlePanelSnapshot);
    ipcMain.handle(IPC.getHostState, this.#handleGetHostState);
    ipcMain.on(IPC.beginPanelDrag, this.#handleBeginPanelDrag);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  async createWindow(
    options: ElectronDockWindowOptions,
  ): Promise<ElectronDockWindow> {
    if (this.#disposed) {
      throw new Error("Electron Dock runtime has been disposed.");
    }
    if (!app.isReady()) {
      throw new Error(
        "Electron Dock createWindow() must be called after app.whenReady().",
      );
    }
    if (this.#entries.has(options.id) || this.#pendingCreates.has(options.id)) {
      throw new Error(`Electron Dock window id is already in use: ${options.id}`);
    }
    if (options.panels.length === 0) {
      throw new Error("Electron Dock requires at least one panel.");
    }
    const panelIds = new Set(options.panels.map((panel) => panel.id));
    if (panelIds.size !== options.panels.length) {
      throw new Error("Electron Dock panel ids must be unique per window.");
    }

    const operation = this.#createReservedWindow(options);
    this.#pendingCreates.set(options.id, operation);
    try {
      return await operation;
    } finally {
      if (this.#pendingCreates.get(options.id) === operation) {
        this.#pendingCreates.delete(options.id);
      }
    }
  }

  windowById(id: string): ElectronDockWindow | null {
    return this.#entries.get(id) ?? null;
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeRuntime();
    return this.#disposePromise;
  }

  async #createReservedWindow(
    options: ElectronDockWindowOptions,
  ): Promise<ElectronDockWindowImpl> {
    const resources = resolveElectronDockResources(options);
    let entryReference: ElectronDockWindowImpl | null = null;
    const entry = await ElectronDockWindowImpl.create({
      options,
      resources,
      onDisposed: () => {
        if (this.#entries.get(options.id) === entryReference) {
          this.#entries.delete(options.id);
        }
      },
    });
    entryReference = entry;

    if (this.#disposed) {
      let cleanupError: unknown;
      try {
        await entry.dispose();
      } catch (error) {
        cleanupError = error;
      }
      throw new Error(
        "Electron Dock runtime was disposed while createWindow() was in progress.",
        cleanupError === undefined ? undefined : { cause: cleanupError },
      );
    }

    this.#entries.set(options.id, entry);
    return entry;
  }

  async #disposeRuntime(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const entries = [...this.#entries.values()];
    const pendingCreates = [...this.#pendingCreates.values()];
    this.#entries.clear();
    const errors: unknown[] = [];
    try {
      const results = await Promise.allSettled(
        entries.map((entry) => entry.dispose()),
      );
      for (const result of results) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      // Each pending create observes #disposed before publishing its window and
      // tears that window down. Awaiting here closes the dispose/create race;
      // its rejection still belongs to the createWindow() caller.
      await Promise.allSettled(pendingCreates);
    } finally {
      ipcMain.removeHandler(IPC.getWorkspaceState);
      ipcMain.off(IPC.setActivePanel, this.#handleSetActivePanel);
      ipcMain.off(IPC.setSplitRatio, this.#handleSetSplitRatio);
      ipcMain.removeHandler(IPC.floatPanel);
      ipcMain.removeHandler(IPC.redockPanel);
      ipcMain.removeHandler(IPC.panelSnapshot);
      ipcMain.removeHandler(IPC.getHostState);
      ipcMain.off(IPC.beginPanelDrag, this.#handleBeginPanelDrag);
      this.#onDisposed();
    }
    throwCollectedErrors(errors, "Electron Dock runtime disposal failed.");
  }

  #shellEntry(
    event: IpcMainEvent | IpcMainInvokeEvent,
  ): ElectronDockWindowImpl | null {
    if (!senderIsMainFrame(event)) return null;
    for (const entry of this.#entries.values()) {
      if (entry.window.webContents.id === event.sender.id) return entry;
    }
    return null;
  }

  #panelEntry(
    event: IpcMainEvent | IpcMainInvokeEvent,
  ): { readonly entry: ElectronDockWindowImpl; readonly panelId: string } | null {
    if (!senderIsMainFrame(event)) return null;
    for (const entry of this.#entries.values()) {
      const host = entry.workspace.hostByWebContents(event.sender.id);
      if (host !== null) {
        return { entry, panelId: host.panelId };
      }
    }
    return null;
  }
}

interface CreateWindowImplOptions {
  readonly options: ElectronDockWindowOptions;
  readonly resources: ReturnType<typeof resolveElectronDockResources>;
  readonly onDisposed: () => void;
}

class ElectronDockWindowImpl implements ElectronDockWindow {
  readonly id: string;
  readonly window: BrowserWindow;
  readonly workspace: DockWorkspaceHost;
  readonly dragController: NativeDragController;
  readonly #onDisposed: () => void;
  #disposed = false;
  #closeReady = false;
  #closePending = false;
  #disposePromise: Promise<void> | null = null;

  private constructor(
    id: string,
    window: BrowserWindow,
    workspace: DockWorkspaceHost,
    dragController: NativeDragController,
    onDisposed: () => void,
  ) {
    this.id = id;
    this.window = window;
    this.workspace = workspace;
    this.dragController = dragController;
    this.#onDisposed = onDisposed;
  }

  static async create(
    createOptions: CreateWindowImplOptions,
  ): Promise<ElectronDockWindowImpl> {
    const { options, resources } = createOptions;
    const requestedPreferences = options.windowOptions?.webPreferences ?? {};
    const desiredShow = options.show
      ?? options.windowOptions?.show
      ?? true;
    const window = new BrowserWindow({
      title: "Electron Dock",
      width: 1360,
      height: 820,
      minWidth: 640,
      minHeight: 420,
      backgroundColor: "#101313",
      autoHideMenuBar: true,
      ...options.windowOptions,
      show: false,
      webPreferences: {
        ...requestedPreferences,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: resources.internalPreloadPath,
      },
    });
    window.setMenu(null);
    window.setMenuBarVisibility(false);

    let workspace: DockWorkspaceHost | null = null;
    let dragController: NativeDragController | null = null;
    try {
      const shellUrl = new URL(pathToFileURL(resources.rendererHtmlPath));
      shellUrl.searchParams.set("mode", "shell");
      shellUrl.searchParams.set("workspaceId", options.id);
      await window.loadURL(shellUrl.href);

      const panelContents: Record<
        string,
        DockPanelContentOptions | undefined
      > = {};
      for (const panel of options.panels) {
        panelContents[panel.id] = panel.content;
      }
      const workspaceOptions = {
        mainWindow: window,
        panels: options.panels.map(stripPanelContent),
        initialLayout: options.initialLayout,
        preloadPath: resources.internalPreloadPath,
        rendererHtmlPath: resources.rendererHtmlPath,
        panelContents,
      };
      workspace = new DockWorkspaceHost(
        options.storage !== undefined
          ? { ...workspaceOptions, storage: options.storage }
          : options.layoutFilePath !== undefined
            ? { ...workspaceOptions, layoutFilePath: options.layoutFilePath }
            : workspaceOptions,
      );
      await workspace.load();
      dragController = new NativeDragController(
        window,
        workspace,
        resources.nativeHelperPath,
      );
      await dragController.initialize();
      const entry = new ElectronDockWindowImpl(
        options.id,
        window,
        workspace,
        dragController,
        createOptions.onDisposed,
      );
      window.on("close", (event) => {
        if (entry.#disposed || entry.#closeReady) return;
        event.preventDefault();
        if (entry.#closePending) return;
        entry.#closePending = true;
        void entry.close()
          .catch((error: unknown) => {
            entry.#reportAsyncError("close", error);
          })
          .finally(() => {
            entry.#closePending = false;
          });
      });
      window.once("closed", () => {
        void entry.disposeWithoutClosingWindow().catch((error: unknown) => {
          entry.#reportAsyncError("closed cleanup", error);
        });
      });
      if (desiredShow) window.show();
      return entry;
    } catch (error) {
      const errors: unknown[] = [error];
      collectSynchronousError(errors, () => dragController?.dispose());
      collectSynchronousError(errors, () => workspace?.dispose());
      collectSynchronousError(errors, () => {
        if (!window.isDestroyed()) window.destroy();
      });
      if (errors.length === 1) throw error;
      throw new AggregateError(
        errors,
        "Electron Dock window creation and cleanup failed.",
      );
    }
  }

  show(): void {
    if (!this.#disposed && !this.window.isDestroyed()) this.window.show();
  }

  async flush(): Promise<void> {
    if (this.#disposed) return;
    await this.workspace.flushPersistence();
  }

  async close(): Promise<void> {
    if (this.#disposed) return;
    let flushError: unknown;
    try {
      await this.workspace.flushPersistence();
    } catch (error) {
      flushError = error;
    }
    if (!this.window.isDestroyed()) {
      this.#closeReady = true;
      this.window.close();
    }
    if (flushError !== undefined) throw flushError;
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeInternal(true, true);
    return this.#disposePromise;
  }

  disposeWithoutClosingWindow(): Promise<void> {
    this.#disposePromise ??= this.#disposeInternal(false, !this.#closeReady);
    return this.#disposePromise;
  }

  async #disposeInternal(
    destroyWindow: boolean,
    flushPersistence: boolean,
  ): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors: unknown[] = [];
    if (flushPersistence) {
      try {
        await this.workspace.flushPersistence();
      } catch (error) {
        errors.push(error);
      }
    }
    collectSynchronousError(errors, () => this.dragController.dispose());
    collectSynchronousError(errors, () => this.workspace.dispose());
    collectSynchronousError(errors, this.#onDisposed);
    if (destroyWindow) {
      collectSynchronousError(errors, () => {
        if (!this.window.isDestroyed()) this.window.destroy();
      });
    }
    throwCollectedErrors(errors, "Electron Dock window disposal failed.");
  }

  #reportAsyncError(operation: string, error: unknown): void {
    console.error(`Electron Dock ${operation} failed for window ${this.id}.`, error);
  }
}

function senderIsMainFrame(
  event: IpcMainEvent | IpcMainInvokeEvent,
): boolean {
  return event.senderFrame !== null
    && event.senderFrame === event.sender.mainFrame;
}

function stripPanelContent(
  panel: ElectronDockPanelDefinition,
): DockPanelDefinition {
  const {
    id,
    title,
    minimumWidth,
    minimumHeight,
    allowedDropPositions,
  } = panel;
  return {
    id,
    title,
    ...(minimumWidth === undefined ? {} : { minimumWidth }),
    ...(minimumHeight === undefined ? {} : { minimumHeight }),
    ...(
      allowedDropPositions === undefined
        ? {}
        : { allowedDropPositions }
    ),
  };
}

function collectSynchronousError(
  errors: unknown[],
  operation: () => void,
): void {
  try {
    operation();
  } catch (error) {
    errors.push(error);
  }
}

function throwCollectedErrors(errors: unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}
