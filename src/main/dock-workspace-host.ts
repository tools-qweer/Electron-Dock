import {
  BrowserWindow,
  screen,
  WebContentsView,
  type WebContents,
} from "electron";
import { pathToFileURL } from "node:url";
import {
  computeDockInsertionRatio,
  resolveDockDropAt,
  solveDockLayoutGeometry,
  type DockDropResolution,
  type DockLayoutGeometry,
  type DockPanelMinimumSize,
} from "../core/layout-geometry.js";
import {
  dockPanel as reduceDockPanel,
  floatPanel as reduceFloatPanel,
  removePanel,
  setActivePanel,
  setSplitRatio,
  type DockPanelInsertionOptions,
} from "../core/layout.js";
import {
  persistDockLayout,
  restorePersistedDockLayout,
  type AtomicLayoutTextStorage as AtomicLayoutTextStorageContract,
} from "../core/layout-persistence.js";
import type {
  DockDropTarget,
  DockLayoutState,
  DockPanelDefinition,
  DockSplitNode,
  PanelId,
  Rectangle,
} from "../core/types.js";
import {
  IPC,
  type DragPreviewMessage,
  type PanelStateMessage,
  type WorkspaceStateMessage,
} from "../shared/protocol.js";
import {
  DockPanelHost,
  type DockPanelContentOptions,
} from "./dock-host.js";
import { AtomicLayoutTextStorage } from "./layout-file-storage.js";
import { PersistenceWriteQueue } from "./persistence-write-queue.js";

const SHELL_HEIGHT = 44;
const SPLITTER_THICKNESS = 5;
const DOCK_TITLE_HEIGHT = 28;
const BOTTOM_TAB_STRIP_HEIGHT = 30;
const DEFAULT_PANEL_MINIMUM_WIDTH = 160;
const DEFAULT_PANEL_MINIMUM_HEIGHT = 120;
const DROP_TARGET_HYSTERESIS_DIP = 5;

interface PendingDockCandidate {
  readonly panelId: PanelId;
  readonly target: DockDropTarget;
  readonly insertedRatio: number | undefined;
  readonly layout: DockLayoutState;
  readonly geometry: DockLayoutGeometry;
  readonly previewBounds: Rectangle;
}

export interface DockWorkspaceHostOptions {
  readonly mainWindow: BrowserWindow;
  readonly panels: readonly DockPanelDefinition[];
  readonly initialLayout: DockLayoutState;
  readonly preloadPath: string;
  readonly rendererHtmlPath: string;
  /**
   * Optional consumer-owned content keyed by panel id. The shell, title bars,
   * splitters and drag overlay remain library-owned.
   */
  readonly panelContents?: Readonly<
    Record<PanelId, DockPanelContentOptions | undefined>
  >;
  /**
   * An application-owned adapter takes precedence over `layoutFilePath`.
   * Supplying neither keeps persistence disabled.
   */
  readonly storage?: AtomicLayoutTextStorageContract;
  readonly layoutFilePath?: string;
  /**
   * Creates a library-owned shell WebContentsView inside an existing window.
   *
   * When omitted, the legacy demo mode renders the shell in the owner
   * BrowserWindow webContents. Public runtime consumers always use an
   * independent shell view so the owner document is never reloaded.
   */
  readonly shellView?: {
    readonly bounds: Rectangle;
    readonly headerHeight?: number;
    readonly followWindowContentBounds?: boolean;
    readonly visible?: boolean;
    readonly interactionEnabled?: boolean;
  };
  readonly onPanelWebContentsCreated?: (
    panelId: PanelId,
    webContents: WebContents,
  ) => void;
  readonly onPanelWebContentsDisposed?: (
    panelId: PanelId,
    webContentsId: number,
  ) => void;
}

export interface DockWorkspacePanelState {
  readonly panelId: PanelId;
  readonly host: "docked" | "floating";
  readonly active: boolean;
  readonly requestedVisible: boolean;
  readonly visible: boolean;
  readonly webContentsId: number;
}

/**
 * Main-process authority for one dock workspace.
 *
 * The layout tree, solved geometry and persistent panel hosts all live here.
 * Renderers receive immutable snapshots and never submit authoritative bounds.
 */
export class DockWorkspaceHost {
  readonly #mainWindow: BrowserWindow;
  readonly #panels: readonly DockPanelDefinition[];
  readonly #initialLayout: DockLayoutState;
  readonly #preloadPath: string;
  readonly #rendererHtmlPath: string;
  readonly #panelContents: Readonly<
    Record<PanelId, DockPanelContentOptions | undefined>
  >;
  readonly #storage: AtomicLayoutTextStorageContract | undefined;
  readonly #panelMinimumSizes: Readonly<
    Record<PanelId, DockPanelMinimumSize | undefined>
  >;
  readonly #hosts = new Map<PanelId, DockPanelHost>();
  readonly #panelVisibility = new Map<PanelId, boolean>();
  readonly #changeListeners = new Set<() => void>();
  readonly #shellView: WebContentsView | null;
  readonly #shellRendererUrl: string | null;
  readonly #shellHeaderHeight: number;
  readonly #followWindowContentBounds: boolean;
  readonly #onPanelWebContentsCreated:
    DockWorkspaceHostOptions["onPanelWebContentsCreated"];
  readonly #onPanelWebContentsDisposed:
    DockWorkspaceHostOptions["onPanelWebContentsDisposed"];
  readonly #overlayView: WebContentsView;
  readonly #overlayRendererUrl: string;
  #layout: DockLayoutState;
  #geometry: DockLayoutGeometry = emptyGeometry();
  #previewGeometry: DockLayoutGeometry | null = null;
  #dragHitGeometry: {
    readonly panelId: PanelId;
    readonly geometry: DockLayoutGeometry;
  } | null = null;
  #dragPreview: DragPreviewMessage | null = null;
  #pendingDockCandidate: PendingDockCandidate | null = null;
  readonly #persistenceQueue = new PersistenceWriteQueue((error) => {
    process.stderr.write(
      `Dock layout persistence failed: ${String(error)}\n`,
    );
  });
  #workspaceFrame: Rectangle | null;
  #visible: boolean;
  #interactionEnabled: boolean;
  #shellAttached = false;
  #shellLoaded = false;
  #overlayLoaded = false;
  #overlayAttached = false;
  #listenersAttached = false;
  #loaded = false;
  #disposed = false;

  readonly #handleMainWindowResize = (): void => {
    if (this.#disposed) return;
    if (this.#followWindowContentBounds) {
      const content = this.#mainWindow.getContentBounds();
      this.#workspaceFrame = {
        x: 0,
        y: 0,
        width: Math.max(1, content.width),
        height: Math.max(1, content.height),
      };
      this.#layoutShell();
    }
    const activeDrag = this.#dragPreview;
    this.#dragHitGeometry = null;
    this.#pendingDockCandidate = null;
    this.#recomputeGeometry();
    this.#previewGeometry = activeDrag === null
      ? null
      : this.#geometryForDrag(activeDrag.panelId);
    if (activeDrag !== null) {
      this.#dragPreview = {
        ...activeDrag,
        target: null,
        previewBounds: null,
      };
      this.#publishDragPreview(this.#dragPreview);
      this.#detachOverlay();
    }
    this.#applyDockedPresentations();
    this.#layoutOverlay();
    this.#publishState();
  };

  readonly #handleMainWindowClosed = (): void => {
    this.dispose();
  };

  constructor(options: DockWorkspaceHostOptions) {
    this.#mainWindow = options.mainWindow;
    this.#panels = options.panels;
    this.#initialLayout = options.initialLayout;
    this.#layout = options.initialLayout;
    this.#preloadPath = options.preloadPath;
    this.#rendererHtmlPath = options.rendererHtmlPath;
    this.#panelContents = options.panelContents ?? {};
    this.#storage = options.storage
      ?? (
        options.layoutFilePath === undefined
          ? undefined
          : new AtomicLayoutTextStorage(options.layoutFilePath)
      );
    this.#panelMinimumSizes = createPanelMinimumSizes(options.panels);
    for (const panel of options.panels) {
      this.#panelVisibility.set(panel.id, true);
    }

    const shellOptions = options.shellView;
    this.#workspaceFrame = shellOptions === undefined
      ? null
      : sanitizeWorkspaceFrame(shellOptions.bounds);
    this.#shellHeaderHeight = shellOptions?.headerHeight ?? SHELL_HEIGHT;
    this.#followWindowContentBounds =
      shellOptions?.followWindowContentBounds ?? false;
    this.#onPanelWebContentsCreated =
      options.onPanelWebContentsCreated;
    this.#onPanelWebContentsDisposed =
      options.onPanelWebContentsDisposed;
    this.#visible = shellOptions?.visible ?? true;
    this.#interactionEnabled = shellOptions?.interactionEnabled ?? true;

    if (shellOptions === undefined) {
      this.#shellView = null;
      this.#shellRendererUrl = null;
    } else {
      const shellUrl = new URL(pathToFileURL(options.rendererHtmlPath));
      shellUrl.searchParams.set("mode", "shell");
      shellUrl.searchParams.set(
        "shellHeaderHeight",
        String(this.#shellHeaderHeight),
      );
      this.#shellRendererUrl = shellUrl.href;
      this.#shellView = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          preload: options.preloadPath,
        },
      });
      this.#shellView.setBackgroundColor("#101313");
      this.#shellView.setVisible(this.#visible);
      this.#shellView.webContents.setWindowOpenHandler(() => ({
        action: "deny",
      }));
    }

    const overlayUrl = new URL(pathToFileURL(options.rendererHtmlPath));
    overlayUrl.searchParams.set("mode", "overlay");
    this.#overlayRendererUrl = overlayUrl.href;
    this.#overlayView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: options.preloadPath,
      },
    });
    this.#overlayView.setBackgroundColor("#00000000");
    this.#overlayView.setVisible(false);
    this.#overlayView.webContents.setWindowOpenHandler(() => ({
      action: "deny",
    }));
    this.#recomputeGeometry();
  }

  get layout(): DockLayoutState {
    return this.#layout;
  }

  get geometry(): DockLayoutGeometry {
    return this.#geometry;
  }

  get panels(): readonly DockPanelDefinition[] {
    return this.#panels;
  }

  get hosts(): readonly DockPanelHost[] {
    return [...this.#hosts.values()];
  }

  get bounds(): Rectangle {
    const frame = this.#workspaceFrame;
    if (frame !== null) return { ...frame };
    const content = this.#mainWindow.getContentBounds();
    return {
      x: 0,
      y: 0,
      width: Math.max(1, content.width),
      height: Math.max(1, content.height),
    };
  }

  get visible(): boolean {
    return this.#visible;
  }

  get interactionEnabled(): boolean {
    return this.#interactionEnabled;
  }

  get shellWebContentsId(): number {
    return this.#shellView?.webContents.id
      ?? this.#mainWindow.webContents.id;
  }

  async load(): Promise<void> {
    if (this.#disposed || this.#loaded) return;

    if (this.#storage !== undefined) {
      this.#layout = await restorePersistedDockLayout(
        this.#storage,
        this.#panels,
        this.#initialLayout,
      );
    }
    this.#recomputeGeometry();

    try {
      this.#attachShell();
      for (const definition of this.#panels) {
        const content = this.#panelContents[definition.id];
        const hostOptions = {
          panelId: definition.id,
          title: definition.title,
          mainWindow: this.#mainWindow,
          preloadPath: this.#preloadPath,
          rendererHtmlPath: this.#rendererHtmlPath,
        };
        const host = new DockPanelHost(
          content === undefined
            ? hostOptions
            : { ...hostOptions, content },
        );
        this.#hosts.set(definition.id, host);
        this.#onPanelWebContentsCreated?.(
          definition.id,
          host.webContents,
        );
        host.setDockedPresentation(
          { x: 0, y: 0, width: 1, height: 1 },
          false,
        );
        host.setWorkspaceVisible(this.#visible);
      }

      const shellLoad = this.#shellView === null
        || this.#shellRendererUrl === null
        ? Promise.resolve()
        : this.#shellView.webContents
          .loadURL(this.#shellRendererUrl)
          .then(() => {
            this.#shellLoaded = true;
          });
      await Promise.all([
        ...this.hosts.map((host) => host.load()),
        shellLoad,
        this.#overlayView.webContents.loadURL(this.#overlayRendererUrl),
      ]);
      this.#overlayLoaded = true;

      for (const floating of this.#layout.floating) {
        this.#hosts.get(floating.panelId)?.float(floating.bounds);
      }
      this.#attachWindowListeners();
      this.#applyDockedPresentations();
      this.#loaded = true;
      this.#publishState();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  snapshot(): WorkspaceStateMessage {
    return {
      panels: this.#panels,
      layout: this.#layout,
      geometry: this.#previewGeometry ?? this.#geometry,
      interactionEnabled: this.#interactionEnabled,
    };
  }

  panelStates(): readonly DockWorkspacePanelState[] {
    const activeDockedPanels = collectActivePanelIds(
      this.#layoutForPresentation(this.#layout).root,
    );
    return this.hosts.map((host) => {
      const requestedVisible =
        this.#panelVisibility.get(host.panelId) === true;
      const status = deriveDockWorkspacePanelStatus({
        host: host.host,
        requestedVisible,
        dockedActive: activeDockedPanels.has(host.panelId),
        rendered: host.visible,
      });
      return {
        panelId: host.panelId,
        host: host.host,
        ...status,
        webContentsId: host.webContentsId,
      };
    });
  }

  onDidChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => {
      this.#changeListeners.delete(listener);
    };
  }

  setBounds(bounds: Rectangle): void {
    if (this.#workspaceFrame === null || this.#disposed) return;
    const next = sanitizeWorkspaceFrame(bounds);
    if (sameRectangle(this.#workspaceFrame, next)) return;
    this.#workspaceFrame = next;
    this.#handleWorkspaceGeometryChange();
  }

  setVisible(visible: boolean): void {
    if (this.#disposed || this.#visible === visible) return;
    this.#visible = visible;
    if (this.#shellView !== null && !this.#shellView.webContents.isDestroyed()) {
      this.#shellView.setVisible(visible);
    }
    if (!visible) this.#detachOverlay();
    for (const host of this.#hosts.values()) {
      host.setWorkspaceVisible(visible);
    }
    this.#publishState();
  }

  setInteractionEnabled(enabled: boolean): void {
    if (this.#disposed || this.#interactionEnabled === enabled) return;
    this.#interactionEnabled = enabled;
    if (!enabled) this.clearDragPreview();
    this.#publishState();
  }

  setPanelVisible(panelId: PanelId, visible: boolean): void {
    const host = this.#hosts.get(panelId);
    if (host === undefined) {
      throw new Error(`Unknown Electron Dock panel id: ${panelId}`);
    }
    if (this.#panelVisibility.get(panelId) === visible) return;
    this.#panelVisibility.set(panelId, visible);
    host.setPanelVisible(visible);
    this.#handleWorkspaceGeometryChange();
  }

  activatePanelById(panelId: PanelId): void {
    const host = this.#hosts.get(panelId);
    if (host === undefined) {
      throw new Error(`Unknown Electron Dock panel id: ${panelId}`);
    }
    if (this.#panelVisibility.get(panelId) !== true) {
      this.setPanelVisible(panelId, true);
    }
    if (host.host === "floating") {
      host.focusFloating();
      this.#publishState();
      return;
    }
    const tabsNodeId = tabsNodeIdForPanel(this.#layout.root, panelId);
    if (tabsNodeId !== null) this.activatePanel(tabsNodeId, panelId);
  }

  reset(): void {
    for (const [panelId, host] of this.#hosts) {
      this.#panelVisibility.set(panelId, true);
      host.setPanelVisible(true);
      if (host.host === "floating") host.redock();
    }
    this.#commitLayout(this.#initialLayout);
  }

  hostByPanelId(panelId: PanelId): DockPanelHost | null {
    return this.#hosts.get(panelId) ?? null;
  }

  hostByWebContents(webContentsId: number): DockPanelHost | null {
    for (const host of this.#hosts.values()) {
      if (host.webContentsId === webContentsId) {
        return host;
      }
    }
    return null;
  }

  activatePanel(tabsNodeId: string, panelId: PanelId): void {
    const next = setActivePanel(this.#layout, tabsNodeId, panelId);
    if (next.root === this.#layout.root) return;
    this.#commitLayout(next);
  }

  resizeSplit(splitNodeId: string, ratio: number): void {
    const next = setSplitRatio(this.#layout, splitNodeId, ratio);
    if (next.root === this.#layout.root) return;
    this.#commitLayout(next);
  }

  floatPanel(panelId: PanelId, bounds?: Rectangle): DockPanelHost | null {
    const host = this.#hosts.get(panelId);
    if (host === undefined) return null;
    if (this.#panelVisibility.get(panelId) !== true) {
      this.setPanelVisible(panelId, true);
    }
    const snapshot = host.float(
      bounds,
      bounds === undefined ? { boundsKind: "content" } : {},
    );
    if (snapshot.host !== "floating") return null;
    this.commitFloatingPanel(panelId);
    return host;
  }

  beginTransientFloat(
    panelId: PanelId,
    bounds: Rectangle,
  ): DockPanelHost | null {
    const host = this.#hosts.get(panelId);
    if (host === undefined) return null;
    const snapshot = host.float(bounds, {
      dragging: true,
      boundsKind: "content",
    });
    return snapshot.host === "floating" ? host : null;
  }

  cancelTransientFloat(panelId: PanelId): void {
    const host = this.#hosts.get(panelId);
    if (host === undefined) return;
    host.redock();
    this.clearDragPreview();
    this.#applyDockedPresentations();
  }

  commitFloatingPanel(panelId: PanelId): void {
    const host = this.#hosts.get(panelId);
    const bounds = host?.floatingBounds;
    if (host === undefined || bounds === null || bounds === undefined) return;
    host.setFloatingDragInteraction(false);
    this.#commitLayout(reduceFloatPanel(this.#layout, panelId, bounds));
  }

  dockPanel(
    panelId: PanelId,
    target: DockDropTarget,
    options: DockPanelInsertionOptions = {},
  ): void {
    const host = this.#hosts.get(panelId);
    if (
      host === undefined
      || !this.#allowedDropPositions(panelId).has(target.position)
    ) {
      return;
    }
    if (this.#panelVisibility.get(panelId) !== true) {
      this.setPanelVisible(panelId, true);
    }
    const next = reduceDockPanel(this.#layout, panelId, target, options);
    host.redock();
    this.#commitLayout(next);
  }

  /**
   * Commits the exact candidate layout that produced the visible drag gap.
   * This prevents release-time geometry from drifting away from the preview.
   */
  commitDockDrop(
    panelId: PanelId,
    resolution: DockDropResolution,
  ): void {
    const host = this.#hosts.get(panelId);
    if (
      host === undefined
      || !this.#allowedDropPositions(panelId).has(resolution.target.position)
    ) {
      return;
    }
    const candidate = this.#pendingDockCandidate;
    const next = candidate !== null
      && candidate.panelId === panelId
      && sameDropTarget(candidate.target, resolution.target)
      && candidate.insertedRatio === resolution.insertedRatio
      ? candidate.layout
      : reduceDockPanel(
        this.#layout,
        panelId,
        resolution.target,
        { insertedRatio: resolution.insertedRatio },
      );
    host.redock();
    this.#commitLayout(next);
  }

  redockPanel(panelId: PanelId): void {
    const target = this.#defaultDockTarget();
    if (target === null) return;
    this.dockPanel(panelId, target);
  }

  /**
   * Resolves a Qt-style local drop from source-stripped main-process geometry.
   *
   * The dragged panel is removed from the transient hit tree first, so a
   * single-panel source leaf cannot be selected even though it will disappear
   * when the drop is committed.
   */
  dropResolutionAt(
    screenPoint: Electron.Point,
    panelId?: PanelId,
  ): DockDropResolution | null {
    if (this.#mainWindow.isDestroyed()) return null;
    const content = this.#mainWindow.getContentBounds();
    const frame = this.#workspaceFrame;
    const localPoint = {
      x: screenPoint.x - content.x - (frame?.x ?? 0),
      y: screenPoint.y - content.y - (frame?.y ?? 0),
    };
    const hitGeometry = panelId === undefined
      ? this.#geometry
      : this.#geometryForDrag(panelId);
    const retainedTarget = panelId !== undefined
      && this.#dragPreview?.panelId === panelId
      && this.#dragPreview.target !== null
      ? this.#dragPreview.target
      : undefined;
    const resolution = resolveDockDropAt(
      hitGeometry,
      localPoint,
      panelId === undefined
        ? undefined
        : this.#allowedDropPositions(panelId),
      retainedTarget,
      retainedTarget === undefined ? 0 : DROP_TARGET_HYSTERESIS_DIP,
    );
    if (resolution === null || panelId === undefined) {
      if (panelId !== undefined) this.#pendingDockCandidate = null;
      return resolution;
    }
    const retainedCandidate = this.#pendingDockCandidate;
    if (
      retainedCandidate !== null
      && retainedCandidate.panelId === panelId
      && sameDropTarget(retainedCandidate.target, resolution.target)
    ) {
      // Native cursor sampling can arrive faster than a rendered frame.
      // Reuse the exact solved candidate while the target identity remains
      // stable instead of deriving a second gap from a percentage.
      return {
        target: retainedCandidate.target,
        previewBounds: retainedCandidate.previewBounds,
        insertedRatio: retainedCandidate.insertedRatio,
      };
    }
    if (resolution.target.position === "center") {
      // A center merge does not resize the target group. Keep its current
      // active panel visible under the translucent highlight; the dragged
      // panel becomes active only when the drop is committed.
      this.#pendingDockCandidate = null;
      return resolution;
    }

    const targetBounds = dropTargetSurfaceBounds(
      hitGeometry,
      resolution.target,
      this.#workspaceBounds(),
    );
    const floatingContentSize = this.#hosts.get(panelId)?.floatingContentSize;
    const insertedRatio = targetBounds === null || floatingContentSize === null
      || floatingContentSize === undefined
      ? undefined
      : computeDockInsertionRatio(
        resolution.target,
        targetBounds,
        {
          width: floatingContentSize.width,
          // A floating native title bar replaces the dock title. When the
          // content returns, the dock title is part of its surface again.
          height: floatingContentSize.height + DOCK_TITLE_HEIGHT,
        },
        SPLITTER_THICKNESS,
      );
    const candidateLayout = reduceDockPanel(
      this.#layout,
      panelId,
      resolution.target,
      { insertedRatio },
    );
    const candidateGeometry = this.#solveGeometry(candidateLayout);
    const previewBounds = panelSurfaceBounds(candidateGeometry, panelId)
      ?? resolution.previewBounds;
    this.#pendingDockCandidate = {
      panelId,
      target: resolution.target,
      insertedRatio,
      layout: candidateLayout,
      geometry: candidateGeometry,
      previewBounds,
    };
    return {
      target: resolution.target,
      previewBounds,
      insertedRatio,
    };
  }

  dropTargetAt(
    screenPoint: Electron.Point,
    panelId?: PanelId,
  ): DockDropTarget | null {
    return this.dropResolutionAt(screenPoint, panelId)?.target ?? null;
  }

  setDragPreview(
    panelId: PanelId,
    resolution: DockDropResolution | null,
  ): void {
    const target = resolution?.target ?? null;
    const previewBounds = resolution?.previewBounds ?? null;
    const message: DragPreviewMessage = {
      panelId,
      active: true,
      target,
      previewBounds,
    };
    if (
      this.#dragPreview?.panelId === message.panelId
      && sameDropTarget(this.#dragPreview.target, message.target)
      && sameRectangle(
        this.#dragPreview.previewBounds,
        message.previewBounds,
      )
    ) {
      return;
    }

    this.#dragPreview = message;
    if (target === null) {
      this.#pendingDockCandidate = null;
      // Floating the source immediately collapses its old sole-panel leaf,
      // just like QMainWindow. A target preview is inserted only when the
      // cursor reaches an eligible local or outer-edge drop region.
      this.#previewGeometry = this.#geometryForDrag(panelId);
      this.#publishDragPreview(message);
      this.#detachOverlay();
      this.#applyDockedPresentations();
      this.#publishState();
      return;
    }

    const candidate = this.#pendingDockCandidate;
    this.#previewGeometry = target.position === "center"
      ? this.#geometryForDrag(panelId)
      : blankDraggedPanelSurface(
        candidate !== null
          && candidate.panelId === panelId
          && sameDropTarget(candidate.target, target)
          ? candidate.geometry
          : this.#solveGeometry(
            reduceDockPanel(
              this.#layout,
              panelId,
              target,
              { insertedRatio: resolution?.insertedRatio },
            ),
          ),
        panelId,
      );
    this.#applyDockedPresentations();
    this.#attachOverlayOnTop();
    // A freshly attached overlay first receives the transient future geometry
    // so the remaining panels visibly make room, then its one highlighted
    // final landing rectangle.
    this.#publishState();
    this.#publishDragPreview(message);
  }

  clearDragPreview(): void {
    const previous = this.#dragPreview;
    if (previous === null) return;
    const message: DragPreviewMessage = {
      panelId: previous.panelId,
      active: false,
      target: null,
      previewBounds: null,
    };
    this.#dragPreview = null;
    this.#previewGeometry = null;
    this.#dragHitGeometry = null;
    this.#pendingDockCandidate = null;
    this.#publishDragPreview(message);
    this.#detachOverlay();
    this.#applyDockedPresentations();
    this.#publishState();
  }

  recoverFloatingWindows(): void {
    const primaryDisplayId = screen.getPrimaryDisplay().id;
    if (
      !screen.getAllDisplays().some(
        (display) => display.id === primaryDisplayId,
      )
    ) {
      return;
    }
    for (const host of this.#hosts.values()) {
      if (host.host === "floating") this.commitFloatingPanel(host.panelId);
    }
  }

  async flushPersistence(): Promise<void> {
    await this.#persistenceQueue.flush();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#dragPreview = null;
    this.#previewGeometry = null;
    this.#dragHitGeometry = null;
    this.#pendingDockCandidate = null;
    this.#detachWindowListeners();
    this.#detachOverlay();
    for (const host of this.#hosts.values()) {
      const panelId = host.panelId;
      const webContentsId = host.webContentsId;
      host.dispose();
      try {
        this.#onPanelWebContentsDisposed?.(panelId, webContentsId);
      } catch (error) {
        process.stderr.write(
          `Electron Dock panel disposal callback failed: ${String(error)}\n`,
        );
      }
    }
    this.#hosts.clear();
    if (!this.#overlayView.webContents.isDestroyed()) {
      this.#overlayView.webContents.close();
    }
    this.#detachShell();
    if (
      this.#shellView !== null
      && !this.#shellView.webContents.isDestroyed()
    ) {
      this.#shellView.webContents.close();
    }
    this.#changeListeners.clear();
    this.#overlayLoaded = false;
    this.#shellLoaded = false;
  }

  #commitLayout(layout: DockLayoutState): void {
    const previousPreview = this.#dragPreview;
    this.#dragPreview = null;
    this.#previewGeometry = null;
    this.#dragHitGeometry = null;
    this.#pendingDockCandidate = null;
    if (previousPreview !== null) {
      this.#publishDragPreview({
        panelId: previousPreview.panelId,
        active: false,
        target: null,
        previewBounds: null,
      });
    }
    this.#detachOverlay();
    this.#layout = layout;
    this.#recomputeGeometry();
    this.#applyDockedPresentations();
    this.#layoutOverlay();
    this.#publishState();
    if (this.#storage !== undefined) {
      const storage = this.#storage;
      this.#persistenceQueue.enqueue(
        () => persistDockLayout(storage, layout),
      );
    }
  }

  #recomputeGeometry(): void {
    if (this.#mainWindow.isDestroyed()) {
      this.#geometry = emptyGeometry();
      return;
    }
    this.#geometry = this.#solveGeometry(this.#layout);
  }

  #solveGeometry(
    layout: DockLayoutState,
    tabsParentOrientations?: Readonly<
      Record<string, DockSplitNode["axis"] | undefined>
    >,
  ): DockLayoutGeometry {
    return solveDockLayoutGeometry(
      this.#layoutForPresentation(layout),
      this.#workspaceBounds(),
      {
        splitterThickness: SPLITTER_THICKNESS,
        titleBarHeight: DOCK_TITLE_HEIGHT,
        tabStripHeight: BOTTOM_TAB_STRIP_HEIGHT,
        tabStripPlacement: "bottom",
        showSingleTab: false,
        panelMinimumSizes: this.#panelMinimumSizes,
        ...(tabsParentOrientations === undefined
          ? {}
          : { tabsParentOrientations }),
      },
    );
  }

  #workspaceBounds(): Rectangle {
    if (this.#workspaceFrame !== null) {
      return {
        x: 0,
        y: Math.min(this.#shellHeaderHeight, this.#workspaceFrame.height),
        width: Math.max(0, this.#workspaceFrame.width),
        height: Math.max(
          0,
          this.#workspaceFrame.height - this.#shellHeaderHeight,
        ),
      };
    }
    const content = this.#mainWindow.getContentBounds();
    return {
      x: 0,
      y: SHELL_HEIGHT,
      width: Math.max(0, content.width),
      height: Math.max(0, content.height - SHELL_HEIGHT),
    };
  }

  #geometryForDrag(panelId: PanelId): DockLayoutGeometry {
    if (this.#dragHitGeometry?.panelId === panelId) {
      return this.#dragHitGeometry.geometry;
    }
    const sourceStripped = reduceFloatPanel(
      this.#layout,
      panelId,
      { x: 0, y: 0, width: 1, height: 1 },
    );
    const geometry = this.#solveGeometry(
      sourceStripped,
      collectTabsParentOrientations(this.#layout.root),
    );
    this.#dragHitGeometry = { panelId, geometry };
    return geometry;
  }

  #publishState(): void {
    const message = this.snapshot();
    if (
      this.#shellView !== null
      && this.#shellLoaded
      && !this.#shellView.webContents.isDestroyed()
    ) {
      this.#shellView.webContents.send(IPC.workspaceState, message);
    } else if (this.#shellView === null && !this.#mainWindow.isDestroyed()) {
      this.#mainWindow.webContents.send(IPC.workspaceState, message);
    }
    if (this.#overlayCanReceive()) {
      this.#overlayView.webContents.send(IPC.workspaceState, message);
    }
    for (const listener of this.#changeListeners) {
      try {
        listener();
      } catch (error) {
        process.stderr.write(
          `Electron Dock change listener failed: ${String(error)}\n`,
        );
      }
    }
    for (const state of this.panelStates()) {
      const message: PanelStateMessage = state;
      this.#hosts.get(state.panelId)?.notifyPanelState(message);
    }
  }

  #publishDragPreview(message: DragPreviewMessage): void {
    if (
      this.#shellView !== null
      && this.#shellLoaded
      && !this.#shellView.webContents.isDestroyed()
    ) {
      this.#shellView.webContents.send(IPC.dragPreview, message);
    } else if (this.#shellView === null && !this.#mainWindow.isDestroyed()) {
      this.#mainWindow.webContents.send(IPC.dragPreview, message);
    }
    if (this.#overlayCanReceive()) {
      this.#overlayView.webContents.send(IPC.dragPreview, message);
    }
  }

  #applyDockedPresentations(): void {
    const geometry = this.#previewGeometry ?? this.#geometry;
    const viewports = new Map(
      geometry.viewports.map(
        (viewport) => [viewport.panelId, viewport.bounds],
      ),
    );
    for (const host of this.#hosts.values()) {
      if (host.host !== "docked") continue;
      const bounds = viewports.get(host.panelId)
        ?? { x: 0, y: 0, width: 1, height: 1 };
      // The transparent overlay is layered above active business views during
      // dragging. Business views remain attached and are never blanked.
      host.setDockedPresentation(
        this.#toOwnerBounds(bounds),
        viewports.has(host.panelId) && this.#visible,
      );
    }
    if (
      this.#dragPreview !== null
      && this.#dragPreview.previewBounds !== null
    ) {
      this.#attachOverlayOnTop();
    }
  }

  #attachOverlayOnTop(): void {
    if (
      !this.#visible
      || !this.#overlayLoaded
      || this.#mainWindow.isDestroyed()
      || this.#overlayView.webContents.isDestroyed()
    ) {
      return;
    }
    this.#overlayView.setVisible(true);
    // addChildView on an existing child deliberately reorders it to the top.
    this.#mainWindow.contentView.addChildView(this.#overlayView);
    this.#overlayAttached = true;
    this.#layoutOverlay();
  }

  #detachOverlay(): void {
    if (
      this.#overlayAttached
      && !this.#mainWindow.isDestroyed()
    ) {
      this.#mainWindow.contentView.removeChildView(this.#overlayView);
    }
    this.#overlayAttached = false;
    if (!this.#overlayView.webContents.isDestroyed()) {
      this.#overlayView.setVisible(false);
    }
  }

  #layoutOverlay(): void {
    if (
      !this.#overlayAttached
      || this.#mainWindow.isDestroyed()
      || this.#overlayView.webContents.isDestroyed()
    ) {
      return;
    }
    this.#overlayView.setBounds(this.bounds);
  }

  #overlayCanReceive(): boolean {
    return this.#overlayLoaded
      && !this.#overlayView.webContents.isDestroyed();
  }

  #attachWindowListeners(): void {
    if (this.#listenersAttached || this.#mainWindow.isDestroyed()) return;
    this.#mainWindow.on("resize", this.#handleMainWindowResize);
    this.#mainWindow.on("closed", this.#handleMainWindowClosed);
    this.#listenersAttached = true;
  }

  #detachWindowListeners(): void {
    if (!this.#listenersAttached) return;
    this.#mainWindow.off("resize", this.#handleMainWindowResize);
    this.#mainWindow.off("closed", this.#handleMainWindowClosed);
    this.#listenersAttached = false;
  }

  #attachShell(): void {
    if (
      this.#shellView === null
      || this.#shellAttached
      || this.#mainWindow.isDestroyed()
      || this.#shellView.webContents.isDestroyed()
    ) {
      return;
    }
    this.#mainWindow.contentView.addChildView(this.#shellView);
    this.#shellAttached = true;
    this.#layoutShell();
  }

  #detachShell(): void {
    if (
      this.#shellView === null
      || !this.#shellAttached
      || this.#mainWindow.isDestroyed()
    ) {
      return;
    }
    this.#mainWindow.contentView.removeChildView(this.#shellView);
    this.#shellAttached = false;
  }

  #layoutShell(): void {
    if (
      this.#shellView === null
      || !this.#shellAttached
      || this.#mainWindow.isDestroyed()
      || this.#shellView.webContents.isDestroyed()
    ) {
      return;
    }
    this.#shellView.setBounds(this.bounds);
    this.#shellView.setVisible(this.#visible);
  }

  #handleWorkspaceGeometryChange(): void {
    if (this.#disposed) return;
    this.#dragHitGeometry = null;
    this.#pendingDockCandidate = null;
    this.#previewGeometry = null;
    this.#recomputeGeometry();
    this.#layoutShell();
    this.#applyDockedPresentations();
    this.#layoutOverlay();
    this.#publishState();
  }

  #layoutForPresentation(layout: DockLayoutState): DockLayoutState {
    let visibleLayout = layout;
    for (const [panelId, visible] of this.#panelVisibility) {
      if (!visible) visibleLayout = removePanel(visibleLayout, panelId);
    }
    return visibleLayout;
  }

  #toOwnerBounds(bounds: Rectangle): Rectangle {
    const frame = this.#workspaceFrame;
    return frame === null
      ? bounds
      : {
        x: frame.x + bounds.x,
        y: frame.y + bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
  }

  #defaultDockTarget(): DockDropTarget | null {
    const firstTabsNodeId = firstTabsId(this.#layout.root);
    return firstTabsNodeId === null
      ? { tabsNodeId: null, position: "center" }
      : { tabsNodeId: firstTabsNodeId, position: "center" };
  }

  #allowedDropPositions(
    panelId: PanelId,
  ): ReadonlySet<DockDropTarget["position"]> {
    const definition = this.#panels.find((panel) => panel.id === panelId);
    return new Set(
      definition?.allowedDropPositions
      ?? ["left", "right", "top", "bottom", "center"],
    );
  }
}

export function deriveDockWorkspacePanelStatus(options: {
  readonly host: "docked" | "floating";
  readonly requestedVisible: boolean;
  readonly dockedActive: boolean;
  readonly rendered: boolean;
}): Pick<
  DockWorkspacePanelState,
  "active" | "requestedVisible" | "visible"
> {
  return {
    active: options.host === "floating"
      ? options.requestedVisible
      : options.dockedActive,
    requestedVisible: options.requestedVisible,
    visible: options.rendered,
  };
}

function createPanelMinimumSizes(
  panels: readonly DockPanelDefinition[],
): Readonly<Record<PanelId, DockPanelMinimumSize | undefined>> {
  const sizes: Record<PanelId, DockPanelMinimumSize | undefined> = {};
  for (const panel of panels) {
    sizes[panel.id] = {
      width: panel.minimumWidth ?? DEFAULT_PANEL_MINIMUM_WIDTH,
      height: panel.minimumHeight ?? DEFAULT_PANEL_MINIMUM_HEIGHT,
    };
  }
  return sizes;
}

function emptyGeometry(): DockLayoutGeometry {
  return {
    viewports: [],
    titleBars: [],
    tabStrips: [],
    splitters: [],
    dropZones: [],
    boundaryDropZones: [],
  };
}

function firstTabsId(root: DockLayoutState["root"]): string | null {
  if (root === null) return null;
  if (root.type === "tabs") return root.id;
  return firstTabsId(root.first) ?? firstTabsId(root.second);
}

function tabsNodeIdForPanel(
  root: DockLayoutState["root"],
  panelId: PanelId,
): string | null {
  if (root === null) return null;
  if (root.type === "tabs") {
    return root.panelIds.includes(panelId) ? root.id : null;
  }
  return tabsNodeIdForPanel(root.first, panelId)
    ?? tabsNodeIdForPanel(root.second, panelId);
}

function collectActivePanelIds(
  root: DockLayoutState["root"],
  result = new Set<PanelId>(),
): ReadonlySet<PanelId> {
  if (root === null) return result;
  if (root.type === "tabs") {
    result.add(root.activePanelId);
    return result;
  }
  collectActivePanelIds(root.first, result);
  collectActivePanelIds(root.second, result);
  return result;
}

function sanitizeWorkspaceFrame(bounds: Rectangle): Rectangle {
  if (
    !Number.isFinite(bounds.x)
    || !Number.isFinite(bounds.y)
    || !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height)
  ) {
    throw new Error("Electron Dock workspace bounds must be finite.");
  }
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}

/**
 * Qt evaluates drop corners against the target leaf's orientation in the
 * pre-drag saved layout. Removing a sole-panel source can collapse that split,
 * so capture the directions before building the source-stripped hit geometry.
 */
function collectTabsParentOrientations(
  root: DockLayoutState["root"],
  inherited: DockSplitNode["axis"] = "horizontal",
  result: Record<string, DockSplitNode["axis"] | undefined> = {},
): Readonly<Record<string, DockSplitNode["axis"] | undefined>> {
  if (root === null) return result;
  if (root.type === "tabs") {
    result[root.id] = inherited;
    return result;
  }
  collectTabsParentOrientations(root.first, root.axis, result);
  collectTabsParentOrientations(root.second, root.axis, result);
  return result;
}

function panelSurfaceBounds(
  geometry: DockLayoutGeometry,
  panelId: PanelId,
): Rectangle | null {
  const tabsNodeId = geometry.titleBars.find(
    (titleBar) => titleBar.panelId === panelId,
  )?.tabsNodeId;
  if (tabsNodeId === undefined) return null;
  return geometry.dropZones.find((zone) => (
    zone.scope === "tabs"
    && zone.tabsNodeId === tabsNodeId
    && zone.position === "center"
  ))?.previewBounds ?? null;
}

function dropTargetSurfaceBounds(
  geometry: DockLayoutGeometry,
  target: DockDropTarget,
  workspaceBounds: Rectangle,
): Rectangle | null {
  if (target.tabsNodeId === null) return workspaceBounds;
  return geometry.dropZones.find((zone) => (
    zone.scope === "tabs"
    && zone.tabsNodeId === target.tabsNodeId
    && zone.position === "center"
  ))?.previewBounds ?? null;
}

/**
 * Qt previews a dock insertion as an empty gap. The floating panel remains
 * visible under the pointer, so rendering its dock title inside the future
 * slot would duplicate the panel and make the gap look occupied.
 */
function blankDraggedPanelSurface(
  geometry: DockLayoutGeometry,
  panelId: PanelId,
): DockLayoutGeometry {
  return {
    ...geometry,
    titleBars: geometry.titleBars.filter(
      (titleBar) => titleBar.panelId !== panelId,
    ),
    tabStrips: geometry.tabStrips.filter(
      (tabStrip) => !(
        tabStrip.panelIds.length === 1
        && tabStrip.panelIds[0] === panelId
      ),
    ),
  };
}

function sameDropTarget(
  first: DockDropTarget | null,
  second: DockDropTarget | null,
): boolean {
  return first?.tabsNodeId === second?.tabsNodeId
    && first?.position === second?.position;
}

function sameRectangle(
  first: Rectangle | null,
  second: Rectangle | null,
): boolean {
  return first?.x === second?.x
    && first?.y === second?.y
    && first?.width === second?.width
    && first?.height === second?.height;
}
