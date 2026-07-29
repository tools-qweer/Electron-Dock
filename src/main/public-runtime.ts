import {
  app,
  BrowserWindow,
  ipcMain,
  type BrowserWindowConstructorOptions,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import type { DockLayoutGeometry } from "../core/layout-geometry.js";
import type { AtomicLayoutTextStorage } from "../core/layout-persistence.js";
import type {
  DockDropTarget,
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
  type DockHostKind,
} from "../shared/protocol.js";
import type { DockPanelContentOptions } from "./dock-host.js";
import {
  DockWorkspaceHost,
  type DockWorkspacePanelState,
} from "./dock-workspace-host.js";
import { NativeDragController } from "./native-drag-controller.js";
import {
  resolveElectronDockResources,
  type ElectronDockResourceOptions,
  type ElectronDockResources,
} from "./resources.js";

export interface ElectronDockPanelDefinition extends DockPanelDefinition {
  /**
   * Consumer-owned page rendered inside this panel. If omitted, the bundled
   * diagnostic panel is used; production consumers should normally provide it.
   */
  readonly content?: DockPanelContentOptions;
}

interface ElectronDockWorkspaceConfiguration
  extends ElectronDockResourceOptions {
  readonly id: string;
  readonly panels: readonly ElectronDockPanelDefinition[];
  readonly initialLayout: DockLayoutState;
  readonly layoutFilePath?: string;
  readonly storage?: AtomicLayoutTextStorage;
  /**
   * Runs synchronously after a panel WebContents is created and before its
   * first loadURL(), allowing the host to register sender authority safely.
   */
  readonly onPanelWebContentsCreated?: (
    event: ElectronDockPanelWebContentsCreatedEvent,
  ) => void;
  readonly onPanelWebContentsDisposed?: (
    event: ElectronDockPanelWebContentsDisposedEvent,
  ) => void;
}

export interface ElectronDockWorkspaceOptions
  extends ElectronDockWorkspaceConfiguration {
  /**
   * Existing consumer-owned window. Electron Dock never reloads it, changes
   * its menu, intercepts its close flow, or destroys it.
   */
  readonly window: BrowserWindow;
  /**
   * Bounds in owner-window content coordinates.
   */
  readonly bounds: Rectangle;
  /**
   * Optional library header within the attached region. Consumer workspaces
   * default to zero; createWindow() retains the 44 DIP demo header.
   */
  readonly shellHeaderHeight?: number;
  readonly visible?: boolean;
  readonly interactionEnabled?: boolean;
}

export interface ElectronDockWindowOptions
  extends ElectronDockWorkspaceConfiguration {
  readonly windowOptions?: BrowserWindowConstructorOptions;
  readonly show?: boolean;
}

export interface ElectronDockPanelState {
  readonly panelId: string;
  readonly host: DockHostKind;
  readonly active: boolean;
  /**
   * Stable user visibility preference controlled by setPanelVisible().
   */
  readonly requestedVisible: boolean;
  /**
   * Actual renderer presentation; inactive tabs are false here.
   */
  readonly visible: boolean;
  readonly webContentsId: number;
}

export interface ElectronDockPanelWebContentsCreatedEvent {
  readonly panelId: string;
  readonly role: "panel";
  readonly generation: 1;
  readonly webContents: WebContents;
}

export interface ElectronDockPanelWebContentsDisposedEvent {
  readonly panelId: string;
  readonly role: "panel";
  readonly generation: 1;
  readonly webContentsId: number;
}

export interface ElectronDockWorkspaceSnapshot {
  readonly id: string;
  readonly bounds: Rectangle;
  readonly visible: boolean;
  readonly interactionEnabled: boolean;
  readonly layout: DockLayoutState;
  readonly geometry: DockLayoutGeometry;
  readonly panels: readonly ElectronDockPanelState[];
}

export type ElectronDockWorkspaceChangeListener = (
  snapshot: ElectronDockWorkspaceSnapshot,
) => void;

export interface ElectronDockWorkspace {
  readonly id: string;
  readonly window: BrowserWindow;
  setBounds(bounds: Rectangle): void;
  setVisible(visible: boolean): void;
  setInteractionEnabled(enabled: boolean): void;
  snapshot(): ElectronDockWorkspaceSnapshot;
  onDidChange(listener: ElectronDockWorkspaceChangeListener): () => void;
  activatePanel(panelId: string): void;
  setPanelVisible(panelId: string, visible: boolean): void;
  float(panelId: string, bounds?: Rectangle): void;
  redock(panelId: string, target?: DockDropTarget): void;
  reset(): void;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ElectronDockWindow extends ElectronDockWorkspace {
  show(): void;
  close(): Promise<void>;
}

export interface ElectronDockRuntime {
  createWindow(
    options: ElectronDockWindowOptions,
  ): Promise<ElectronDockWindow>;
  attachWorkspace(
    options: ElectronDockWorkspaceOptions,
  ): Promise<ElectronDockWorkspace>;
  windowById(id: string): ElectronDockWindow | null;
  workspaceById(id: string): ElectronDockWorkspace | null;
  dispose(): Promise<void>;
}

let activeRuntime: ElectronDockRuntimeImpl | null = null;

/**
 * Creates the main-process authority for Electron Dock.
 *
 * Importing this module has no Electron lifecycle side effects. Consumers must
 * wait for `app.whenReady()` and dispose the runtime in their shutdown flow.
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
  readonly #workspaces = new Map<string, ElectronDockWorkspaceImpl>();
  readonly #initializingWorkspaces = new Map<string, DockWorkspaceHost>();
  readonly #windows = new Map<string, ElectronDockWindowImpl>();
  readonly #pendingIds = new Set<string>();
  readonly #pendingOperations = new Set<Promise<unknown>>();
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
    if (
      entry === null
      || !entry.workspace.interactionEnabled
      || !isSetActivePanelMessage(value)
    ) {
      return;
    }
    entry.workspace.activatePanel(value.tabsNodeId, value.panelId);
  };

  readonly #handleSetSplitRatio = (
    event: IpcMainEvent,
    value: unknown,
  ): void => {
    const entry = this.#shellEntry(event);
    if (
      entry === null
      || !entry.workspace.interactionEnabled
      || !isSetSplitRatioMessage(value)
    ) {
      return;
    }
    entry.workspace.resizeSplit(value.splitNodeId, value.ratio);
  };

  readonly #handleFloatPanel = (
    event: IpcMainInvokeEvent,
    value: unknown,
  ): unknown => {
    const located = this.#panelEntry(event);
    if (
      located === null
      || !located.entry.workspace.visible
      || !located.entry.workspace.interactionEnabled
      || !panelIsVisible(located.entry.workspace, located.panelId)
    ) {
      return null;
    }
    const bounds = isRectangle(value) ? value : undefined;
    return located.entry.workspace
      .floatPanel(located.panelId, bounds)
      ?.snapshot() ?? null;
  };

  readonly #handleRedockPanel = (event: IpcMainInvokeEvent): unknown => {
    const located = this.#panelEntry(event);
    if (
      located === null
      || !located.entry.workspace.visible
      || !located.entry.workspace.interactionEnabled
      || !panelIsVisible(located.entry.workspace, located.panelId)
    ) {
      return null;
    }
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
    const located = this.#panelStateEntry(event);
    if (located === null) return null;
    const snapshot = located.workspace
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

  readonly #handleGetPanelState = (event: IpcMainInvokeEvent): unknown => {
    const located = this.#panelStateEntry(event);
    if (located === null) return null;
    return located.workspace.panelStates().find(
      (state) => state.panelId === located.panelId,
    ) ?? null;
  };

  readonly #handleBeginPanelDrag = (
    event: IpcMainEvent,
    value: unknown,
  ): void => {
    const entry = this.#shellEntry(event);
    if (
      entry === null
      || !entry.workspace.interactionEnabled
      || !isBeginPanelDragMessage(value)
      || entry.workspace.hostByPanelId(value.panelId) === null
    ) {
      return;
    }
    void entry.dragController.begin(value).catch((error: unknown) => {
      process.stderr.write(`Electron Dock panel drag rejected: ${String(error)}\n`);
    });
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
    ipcMain.handle(IPC.getPanelState, this.#handleGetPanelState);
    ipcMain.on(IPC.beginPanelDrag, this.#handleBeginPanelDrag);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  createWindow(
    options: ElectronDockWindowOptions,
  ): Promise<ElectronDockWindow> {
    this.#validateReservation(options);
    const operation = this.#createWindow(options);
    this.#trackPending(options.id, operation);
    return operation;
  }

  attachWorkspace(
    options: ElectronDockWorkspaceOptions,
  ): Promise<ElectronDockWorkspace> {
    this.#validateReservation(options);
    if (options.window.isDestroyed()) {
      throw new Error("Cannot attach Electron Dock to a destroyed window.");
    }
    const operation = this.#attachWorkspace(options);
    this.#trackPending(options.id, operation);
    return operation;
  }

  windowById(id: string): ElectronDockWindow | null {
    return this.#windows.get(id) ?? null;
  }

  workspaceById(id: string): ElectronDockWorkspace | null {
    return this.#workspaces.get(id) ?? null;
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeRuntime();
    return this.#disposePromise;
  }

  #trackPending(id: string, operation: Promise<unknown>): void {
    this.#pendingIds.add(id);
    this.#pendingOperations.add(operation);
    void operation.finally(() => {
      this.#pendingIds.delete(id);
      this.#pendingOperations.delete(operation);
    }).catch(() => {
      // The original operation remains owned by its caller.
    });
  }

  #validateReservation(options: ElectronDockWorkspaceConfiguration): void {
    if (this.#disposed) {
      throw new Error("Electron Dock runtime has been disposed.");
    }
    if (!app.isReady()) {
      throw new Error(
        "Electron Dock workspaces must be created after app.whenReady().",
      );
    }
    if (
      this.#workspaces.has(options.id)
      || this.#initializingWorkspaces.has(options.id)
      || this.#pendingIds.has(options.id)
    ) {
      throw new Error(
        `Electron Dock workspace id is already in use: ${options.id}`,
      );
    }
    if (options.panels.length === 0) {
      throw new Error("Electron Dock requires at least one panel.");
    }
    const panelIds = new Set(options.panels.map((panel) => panel.id));
    if (panelIds.size !== options.panels.length) {
      throw new Error("Electron Dock panel ids must be unique per workspace.");
    }
  }

  async #createWindow(
    options: ElectronDockWindowOptions,
  ): Promise<ElectronDockWindowImpl> {
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
      },
    });
    window.setMenu(null);
    window.setMenuBarVisibility(false);

    const content = window.getContentBounds();
    let workspace: ElectronDockWorkspaceImpl | null = null;
    let initializingWorkspace: DockWorkspaceHost | null = null;
    try {
      workspace = await ElectronDockWorkspaceImpl.create({
        options: {
          ...options,
          window,
          bounds: {
            x: 0,
            y: 0,
            width: Math.max(1, content.width),
            height: Math.max(1, content.height),
          },
          shellHeaderHeight: 44,
        },
        resources: resolveElectronDockResources(options),
        ownsWindow: true,
        followWindowContentBounds: true,
        onWorkspaceHostCreated: (createdWorkspace) => {
          initializingWorkspace = createdWorkspace;
          this.#registerInitializingWorkspace(
            options.id,
            createdWorkspace,
          );
        },
        onDisposed: () => {
          this.#removeEntry(options.id, workspace);
        },
      });
      const dockWindow = new ElectronDockWindowImpl(workspace);
      this.#publishEntry(options.id, workspace, dockWindow);
      if (desiredShow) window.show();
      return dockWindow;
    } catch (error) {
      if (workspace !== null) {
        await workspace.dispose().catch(() => {});
      } else if (!window.isDestroyed()) {
        window.destroy();
      }
      throw error;
    } finally {
      this.#removeInitializingWorkspace(
        options.id,
        initializingWorkspace,
      );
    }
  }

  async #attachWorkspace(
    options: ElectronDockWorkspaceOptions,
  ): Promise<ElectronDockWorkspaceImpl> {
    let workspace: ElectronDockWorkspaceImpl | null = null;
    let initializingWorkspace: DockWorkspaceHost | null = null;
    try {
      workspace = await ElectronDockWorkspaceImpl.create({
        options,
        resources: resolveElectronDockResources(options),
        ownsWindow: false,
        followWindowContentBounds: false,
        onWorkspaceHostCreated: (createdWorkspace) => {
          initializingWorkspace = createdWorkspace;
          this.#registerInitializingWorkspace(
            options.id,
            createdWorkspace,
          );
        },
        onDisposed: () => {
          this.#removeEntry(options.id, workspace);
        },
      });
      this.#publishEntry(options.id, workspace, null);
      return workspace;
    } catch (error) {
      if (workspace !== null) await workspace.dispose().catch(() => {});
      throw error;
    } finally {
      this.#removeInitializingWorkspace(
        options.id,
        initializingWorkspace,
      );
    }
  }

  #registerInitializingWorkspace(
    id: string,
    workspace: DockWorkspaceHost,
  ): void {
    if (this.#disposed) {
      throw new Error(
        "Electron Dock runtime was disposed while workspace creation was in progress.",
      );
    }
    if (
      this.#workspaces.has(id)
      || this.#initializingWorkspaces.has(id)
    ) {
      throw new Error(`Electron Dock workspace id is already in use: ${id}`);
    }
    this.#initializingWorkspaces.set(id, workspace);
  }

  #removeInitializingWorkspace(
    id: string,
    expected: DockWorkspaceHost | null,
  ): void {
    if (
      expected !== null
      && this.#initializingWorkspaces.get(id) === expected
    ) {
      this.#initializingWorkspaces.delete(id);
    }
  }

  #publishEntry(
    id: string,
    workspace: ElectronDockWorkspaceImpl,
    dockWindow: ElectronDockWindowImpl | null,
  ): void {
    if (this.#disposed) {
      void workspace.dispose().catch(() => {});
      throw new Error(
        "Electron Dock runtime was disposed while workspace creation was in progress.",
      );
    }
    this.#workspaces.set(id, workspace);
    if (dockWindow !== null) this.#windows.set(id, dockWindow);
  }

  #removeEntry(
    id: string,
    expected: ElectronDockWorkspaceImpl | null,
  ): void {
    if (expected === null || this.#workspaces.get(id) === expected) {
      this.#workspaces.delete(id);
      this.#windows.delete(id);
    }
  }

  async #disposeRuntime(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const workspaces = [...this.#workspaces.values()];
    const pending = [...this.#pendingOperations];
    this.#workspaces.clear();
    this.#initializingWorkspaces.clear();
    this.#windows.clear();
    const errors: unknown[] = [];
    try {
      const results = await Promise.allSettled(
        workspaces.map((workspace) => workspace.dispose()),
      );
      for (const result of results) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      await Promise.allSettled(pending);
    } finally {
      ipcMain.removeHandler(IPC.getWorkspaceState);
      ipcMain.off(IPC.setActivePanel, this.#handleSetActivePanel);
      ipcMain.off(IPC.setSplitRatio, this.#handleSetSplitRatio);
      ipcMain.removeHandler(IPC.floatPanel);
      ipcMain.removeHandler(IPC.redockPanel);
      ipcMain.removeHandler(IPC.panelSnapshot);
      ipcMain.removeHandler(IPC.getHostState);
      ipcMain.removeHandler(IPC.getPanelState);
      ipcMain.off(IPC.beginPanelDrag, this.#handleBeginPanelDrag);
      this.#onDisposed();
    }
    throwCollectedErrors(errors, "Electron Dock runtime disposal failed.");
  }

  #shellEntry(
    event: IpcMainEvent | IpcMainInvokeEvent,
  ): ElectronDockWorkspaceImpl | null {
    if (!senderIsMainFrame(event)) return null;
    for (const entry of this.#workspaces.values()) {
      if (entry.workspace.shellWebContentsId === event.sender.id) return entry;
    }
    return null;
  }

  #panelEntry(
    event: IpcMainEvent | IpcMainInvokeEvent,
  ): {
    readonly entry: ElectronDockWorkspaceImpl;
    readonly panelId: string;
  } | null {
    if (!senderIsMainFrame(event)) return null;
    for (const entry of this.#workspaces.values()) {
      const host = entry.workspace.hostByWebContents(event.sender);
      if (host !== null) return { entry, panelId: host.panelId };
    }
    return null;
  }

  #panelStateEntry(
    event: IpcMainEvent | IpcMainInvokeEvent,
  ): {
    readonly workspace: DockWorkspaceHost;
    readonly panelId: string;
  } | null {
    if (!senderIsMainFrame(event)) return null;
    for (const entry of this.#workspaces.values()) {
      const host = entry.workspace.hostByWebContents(event.sender);
      if (host !== null) {
        return { workspace: entry.workspace, panelId: host.panelId };
      }
    }
    for (const workspace of this.#initializingWorkspaces.values()) {
      const host = workspace.hostByWebContents(event.sender);
      if (host !== null) return { workspace, panelId: host.panelId };
    }
    return null;
  }
}

interface CreateWorkspaceImplOptions {
  readonly options: ElectronDockWorkspaceOptions;
  readonly resources: ElectronDockResources;
  readonly ownsWindow: boolean;
  readonly followWindowContentBounds: boolean;
  readonly onWorkspaceHostCreated: (workspace: DockWorkspaceHost) => void;
  readonly onDisposed: () => void;
}

class ElectronDockWorkspaceImpl implements ElectronDockWorkspace {
  readonly id: string;
  readonly window: BrowserWindow;
  readonly workspace: DockWorkspaceHost;
  readonly dragController: NativeDragController;
  readonly #ownsWindow: boolean;
  readonly #onDisposed: () => void;
  #disposed = false;
  #closeReady = false;
  #closePending = false;
  #disposePromise: Promise<void> | null = null;
  readonly #handleOwnerClose = (
    event: { preventDefault(): void },
  ): void => {
    if (this.#disposed || this.#closeReady) return;
    event.preventDefault();
    if (this.#closePending) return;
    this.#closePending = true;
    void this.closeOwner()
      .catch((error: unknown) => {
        this.#reportAsyncError("close", error);
      })
      .finally(() => {
        this.#closePending = false;
      });
  };
  readonly #handleOwnerClosed = (): void => {
    void this.#disposeInternal(false, !this.#closeReady).catch(
      (error: unknown) => {
        this.#reportAsyncError("closed cleanup", error);
      },
    );
  };

  private constructor(
    id: string,
    window: BrowserWindow,
    workspace: DockWorkspaceHost,
    dragController: NativeDragController,
    ownsWindow: boolean,
    onDisposed: () => void,
  ) {
    this.id = id;
    this.window = window;
    this.workspace = workspace;
    this.dragController = dragController;
    this.#ownsWindow = ownsWindow;
    this.#onDisposed = onDisposed;
  }

  static async create(
    createOptions: CreateWorkspaceImplOptions,
  ): Promise<ElectronDockWorkspaceImpl> {
    const { options, resources } = createOptions;
    const panelContents: Record<
      string,
      DockPanelContentOptions | undefined
    > = {};
    for (const panel of options.panels) {
      panelContents[panel.id] = panel.content;
    }
    const workspaceOptions = {
      mainWindow: options.window,
      panels: options.panels.map(stripPanelContent),
      initialLayout: options.initialLayout,
      preloadPath: resources.internalPreloadPath,
      rendererHtmlPath: resources.rendererHtmlPath,
      panelContents,
      shellView: {
        bounds: options.bounds,
        headerHeight: options.shellHeaderHeight ?? 0,
        followWindowContentBounds: createOptions.followWindowContentBounds,
        visible: options.visible ?? true,
        interactionEnabled: options.interactionEnabled ?? true,
      },
      onPanelWebContentsCreated: (
        panelId: string,
        webContents: WebContents,
      ) => {
        options.onPanelWebContentsCreated?.({
          panelId,
          role: "panel",
          generation: 1,
          webContents,
        });
      },
      onPanelWebContentsDisposed: (
        panelId: string,
        webContentsId: number,
      ) => {
        options.onPanelWebContentsDisposed?.({
          panelId,
          role: "panel",
          generation: 1,
          webContentsId,
        });
      },
    };
    const workspace = new DockWorkspaceHost(
      options.storage !== undefined
        ? { ...workspaceOptions, storage: options.storage }
        : options.layoutFilePath !== undefined
          ? { ...workspaceOptions, layoutFilePath: options.layoutFilePath }
          : workspaceOptions,
    );
    let dragController: NativeDragController | null = null;
    try {
      createOptions.onWorkspaceHostCreated(workspace);
      await workspace.load();
      dragController = new NativeDragController(
        options.window,
        workspace,
        resources.nativeHelperPath,
      );
      await dragController.initialize();
      dragController.setInteractionEnabled(workspace.interactionEnabled);
      const entry = new ElectronDockWorkspaceImpl(
        options.id,
        options.window,
        workspace,
        dragController,
        createOptions.ownsWindow,
        createOptions.onDisposed,
      );
      entry.#installOwnerLifecycle();
      return entry;
    } catch (error) {
      const errors: unknown[] = [error];
      collectSynchronousError(errors, () => dragController?.dispose());
      collectSynchronousError(errors, () => workspace.dispose());
      if (
        createOptions.ownsWindow
        && !options.window.isDestroyed()
      ) {
        collectSynchronousError(errors, () => options.window.destroy());
      }
      if (errors.length === 1) throw error;
      throw new AggregateError(
        errors,
        "Electron Dock workspace creation and cleanup failed.",
      );
    }
  }

  setBounds(bounds: Rectangle): void {
    this.#assertActive();
    this.workspace.setBounds(bounds);
  }

  setVisible(visible: boolean): void {
    this.#assertActive();
    this.workspace.setVisible(visible);
  }

  setInteractionEnabled(enabled: boolean): void {
    this.#assertActive();
    this.dragController.setInteractionEnabled(enabled);
    this.workspace.setInteractionEnabled(enabled);
  }

  snapshot(): ElectronDockWorkspaceSnapshot {
    const state = this.workspace.snapshot();
    return {
      id: this.id,
      bounds: this.workspace.bounds,
      visible: this.workspace.visible,
      interactionEnabled: this.workspace.interactionEnabled,
      layout: state.layout,
      geometry: state.geometry,
      panels: this.workspace.panelStates().map(publicPanelState),
    };
  }

  onDidChange(listener: ElectronDockWorkspaceChangeListener): () => void {
    this.#assertActive();
    return this.workspace.onDidChange(() => {
      listener(this.snapshot());
    });
  }

  activatePanel(panelId: string): void {
    this.#assertActive();
    this.workspace.activatePanelById(panelId);
  }

  setPanelVisible(panelId: string, visible: boolean): void {
    this.#assertActive();
    this.workspace.setPanelVisible(panelId, visible);
  }

  float(panelId: string, bounds?: Rectangle): void {
    this.#assertActive();
    this.#requirePanel(panelId);
    this.workspace.floatPanel(panelId, bounds);
  }

  redock(panelId: string, target?: DockDropTarget): void {
    this.#assertActive();
    this.#requirePanel(panelId);
    if (target === undefined) {
      this.workspace.redockPanel(panelId);
    } else {
      this.workspace.dockPanel(panelId, target);
    }
  }

  reset(): void {
    this.#assertActive();
    this.workspace.reset();
  }

  async flush(): Promise<void> {
    this.#assertActive();
    await this.workspace.flushPersistence();
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeInternal(
      this.#ownsWindow,
      true,
    );
    return this.#disposePromise;
  }

  async closeOwner(): Promise<void> {
    if (!this.#ownsWindow || this.#disposed) return;
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

  #installOwnerLifecycle(): void {
    if (this.#ownsWindow) {
      this.window.on("close", this.#handleOwnerClose);
    }
    this.window.once("closed", this.#handleOwnerClosed);
  }

  async #disposeInternal(
    destroyOwnerWindow: boolean,
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
    this.window.off("closed", this.#handleOwnerClosed);
    if (this.#ownsWindow) {
      this.window.off("close", this.#handleOwnerClose);
    }
    collectSynchronousError(errors, () => this.dragController.dispose());
    collectSynchronousError(errors, () => this.workspace.dispose());
    collectSynchronousError(errors, this.#onDisposed);
    if (destroyOwnerWindow) {
      collectSynchronousError(errors, () => {
        if (!this.window.isDestroyed()) this.window.destroy();
      });
    }
    throwCollectedErrors(errors, "Electron Dock workspace disposal failed.");
  }

  #requirePanel(panelId: string): void {
    if (this.workspace.hostByPanelId(panelId) === null) {
      throw new Error(`Unknown Electron Dock panel id: ${panelId}`);
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error(`Electron Dock workspace ${this.id} has been disposed.`);
    }
    if (this.window.isDestroyed()) {
      throw new Error(`Electron Dock owner window ${this.id} is destroyed.`);
    }
  }

  #reportAsyncError(operation: string, error: unknown): void {
    console.error(
      `Electron Dock ${operation} failed for workspace ${this.id}.`,
      error,
    );
  }
}

class ElectronDockWindowImpl implements ElectronDockWindow {
  readonly #workspace: ElectronDockWorkspaceImpl;

  constructor(workspace: ElectronDockWorkspaceImpl) {
    this.#workspace = workspace;
  }

  get id(): string {
    return this.#workspace.id;
  }

  get window(): BrowserWindow {
    return this.#workspace.window;
  }

  setBounds(bounds: Rectangle): void {
    this.#workspace.setBounds(bounds);
  }

  setVisible(visible: boolean): void {
    this.#workspace.setVisible(visible);
  }

  setInteractionEnabled(enabled: boolean): void {
    this.#workspace.setInteractionEnabled(enabled);
  }

  snapshot(): ElectronDockWorkspaceSnapshot {
    return this.#workspace.snapshot();
  }

  onDidChange(listener: ElectronDockWorkspaceChangeListener): () => void {
    return this.#workspace.onDidChange(listener);
  }

  activatePanel(panelId: string): void {
    this.#workspace.activatePanel(panelId);
  }

  setPanelVisible(panelId: string, visible: boolean): void {
    this.#workspace.setPanelVisible(panelId, visible);
  }

  float(panelId: string, bounds?: Rectangle): void {
    this.#workspace.float(panelId, bounds);
  }

  redock(panelId: string, target?: DockDropTarget): void {
    this.#workspace.redock(panelId, target);
  }

  reset(): void {
    this.#workspace.reset();
  }

  flush(): Promise<void> {
    return this.#workspace.flush();
  }

  dispose(): Promise<void> {
    return this.#workspace.dispose();
  }

  show(): void {
    if (!this.window.isDestroyed()) this.window.show();
  }

  close(): Promise<void> {
    return this.#workspace.closeOwner();
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

function publicPanelState(
  state: DockWorkspacePanelState,
): ElectronDockPanelState {
  return {
    panelId: state.panelId,
    host: state.host,
    active: state.active,
    requestedVisible: state.requestedVisible,
    visible: state.visible,
    webContentsId: state.webContentsId,
  };
}

function panelIsVisible(
  workspace: DockWorkspaceHost,
  panelId: string,
): boolean {
  return workspace.panelStates().find(
    (state) => state.panelId === panelId,
  )?.visible === true;
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
