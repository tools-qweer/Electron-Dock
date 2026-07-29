import { BrowserWindow, screen, WebContentsView } from "electron";
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
  type WorkspaceStateMessage,
} from "../shared/protocol.js";
import {
  DockPanelHost,
  type DockPanelContentOptions,
} from "./dock-host.js";
import { AtomicLayoutTextStorage } from "./layout-file-storage.js";

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
  #persistChain = Promise.resolve();
  #overlayLoaded = false;
  #overlayAttached = false;
  #listenersAttached = false;
  #loaded = false;
  #disposed = false;

  readonly #handleMainWindowResize = (): void => {
    if (this.#disposed) return;
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
        host.setDockedPresentation(
          { x: 0, y: 0, width: 1, height: 1 },
          false,
        );
        this.#hosts.set(definition.id, host);
      }

      await Promise.all([
        ...this.hosts.map((host) => host.load()),
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
    };
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
    const localPoint = {
      x: screenPoint.x - content.x,
      y: screenPoint.y - content.y,
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
    await this.#persistChain;
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
    for (const host of this.#hosts.values()) host.dispose();
    this.#hosts.clear();
    if (!this.#overlayView.webContents.isDestroyed()) {
      this.#overlayView.webContents.close();
    }
    this.#overlayLoaded = false;
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
      this.#persistChain = this.#persistChain
        .catch(() => undefined)
        .then(() => persistDockLayout(storage, layout))
        .catch((error: unknown) => {
          process.stderr.write(
            `Dock layout persistence failed: ${String(error)}\n`,
          );
        });
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
      layout,
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
    if (!this.#mainWindow.isDestroyed()) {
      this.#mainWindow.webContents.send(IPC.workspaceState, message);
    }
    if (this.#overlayCanReceive()) {
      this.#overlayView.webContents.send(IPC.workspaceState, message);
    }
  }

  #publishDragPreview(message: DragPreviewMessage): void {
    if (!this.#mainWindow.isDestroyed()) {
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
      host.setDockedPresentation(bounds, viewports.has(host.panelId));
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
      !this.#overlayLoaded
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
    const content = this.#mainWindow.getContentBounds();
    this.#overlayView.setBounds({
      x: 0,
      y: 0,
      width: Math.max(1, content.width),
      height: Math.max(1, content.height),
    });
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
