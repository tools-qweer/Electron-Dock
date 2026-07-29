import {
  BaseWindow,
  BrowserWindow,
  screen,
  type WebContents,
  WebContentsView,
  type Rectangle,
  type WebPreferences,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { recoverWindowBounds } from "../core/display-bounds.js";
import {
  IPC,
  type DockHostKind,
  type HostChangedMessage,
  type PanelStateMessage,
  sanitizeRectangle,
} from "../shared/protocol.js";

export interface DockPanelHostOptions {
  readonly panelId: string;
  readonly title: string;
  readonly mainWindow: BrowserWindow;
  readonly preloadPath: string;
  readonly rendererHtmlPath: string;
  /**
   * Consumer-owned panel content. When omitted the bundled demo panel is used.
   *
   * Security-sensitive WebPreferences are deliberately not configurable:
   * every panel keeps contextIsolation and sandbox enabled and Node disabled.
   */
  readonly content?: DockPanelContentOptions;
}

export interface DockPanelContentOptions {
  readonly url: string;
  readonly preload?: string;
  readonly additionalArguments?: readonly string[];
  readonly backgroundThrottling?: boolean;
  /**
   * Additional HTTP(S) origins this panel may navigate to.
   *
   * The initial document's origin is always allowed. Cross-origin navigation
   * is denied unless its origin appears here, and new windows are always
   * denied. File-backed and opaque-origin documents may only navigate to their
   * exact initial document.
   */
  readonly allowedNavigationOrigins?: readonly string[];
}

export interface DockPanelHostSnapshot {
  readonly panelId: string;
  readonly webContentsId: number;
  readonly host: DockHostKind;
  readonly visible: boolean;
  readonly hasFloatingWindow: boolean;
}

export interface FloatPanelOptions {
  readonly dragging?: boolean;
  /**
   * Persisted floating bounds are native window bounds. A transient tear-off,
   * however, starts from a docked content viewport and must preserve that
   * content size across the native frame conversion.
   */
  readonly boundsKind?: "window" | "content";
}

/**
 * Owns one persistent WebContentsView.
 *
 * Moving the panel never reloads or recreates its renderer. Only the native
 * View parent changes between the main BrowserWindow and a floating BaseWindow.
 */
export class DockPanelHost {
  readonly #panelId: string;
  readonly #title: string;
  readonly #mainWindow: BrowserWindow;
  readonly #view: WebContentsView;
  readonly #rendererUrl: string;
  #dockedBounds: Rectangle = { x: 0, y: 0, width: 1, height: 1 };
  #dockedVisible = true;
  #workspaceVisible = true;
  #panelVisible = true;
  #attachedToMain = false;
  #floatingWindow: BaseWindow | null = null;
  #host: DockHostKind = "docked";
  #isDisposing = false;
  readonly #floatingMoveListeners = new Set<() => void>();

  constructor(options: DockPanelHostOptions) {
    this.#panelId = options.panelId;
    this.#title = options.title;
    this.#mainWindow = options.mainWindow;
    let rendererUrl: string;
    if (options.content === undefined) {
      const url = new URL(pathToFileURL(options.rendererHtmlPath));
      url.searchParams.set("mode", "panel");
      url.searchParams.set("panelId", options.panelId);
      rendererUrl = url.href;
    } else {
      rendererUrl = new URL(options.content.url).href;
    }
    const navigationPolicy = createPanelNavigationPolicy(
      rendererUrl,
      options.content?.allowedNavigationOrigins,
    );
    this.#view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: options.content?.preload ?? options.preloadPath,
        ...optionalPanelWebPreferences(options.content),
      },
    });
    this.#view.webContents.on("will-navigate", (event, navigationUrl) => {
      if (!navigationPolicy.allows(navigationUrl)) event.preventDefault();
    });
    this.#view.webContents.on("will-redirect", (event, navigationUrl) => {
      if (!navigationPolicy.allows(navigationUrl)) event.preventDefault();
    });
    this.#view.webContents.setWindowOpenHandler(() => ({
      action: "deny",
    }));
    this.#rendererUrl = rendererUrl;
  }

  get webContentsId(): number {
    return this.#view.webContents.id;
  }

  get webContents(): WebContents {
    return this.#view.webContents;
  }

  get panelId(): string {
    return this.#panelId;
  }

  get floatingWindow(): BaseWindow | null {
    return this.#floatingWindow;
  }

  get host(): DockHostKind {
    return this.#host;
  }

  get rendererUrl(): string {
    return this.#rendererUrl;
  }

  get visible(): boolean {
    if (!this.#workspaceVisible || !this.#panelVisible) return false;
    if (this.#host === "floating") {
      return this.#floatingWindow !== null
        && !this.#floatingWindow.isDestroyed()
        && this.#floatingWindow.isVisible();
    }
    return this.#attachedToMain && this.#dockedVisible;
  }

  get floatingBounds(): Rectangle | null {
    const floatingWindow = this.#floatingWindow;
    return floatingWindow === null || floatingWindow.isDestroyed()
      ? null
      : floatingWindow.getBounds();
  }

  get floatingContentSize(): Readonly<{ width: number; height: number }> | null {
    const floatingWindow = this.#floatingWindow;
    if (floatingWindow === null || floatingWindow.isDestroyed()) return null;
    const bounds = floatingWindow.getContentBounds();
    return {
      width: bounds.width,
      height: bounds.height,
    };
  }

  onFloatingNativeMoveStarted(listener: () => void): () => void {
    this.#floatingMoveListeners.add(listener);
    return () => {
      this.#floatingMoveListeners.delete(listener);
    };
  }

  async load(): Promise<void> {
    await this.#view.webContents.loadURL(this.#rendererUrl);
    this.#attachToMainIfVisible();
    setImmediate(() => {
      this.#notifyHostChanged();
    });
  }

  updateDockedBounds(bounds: Rectangle): void {
    this.setDockedPresentation(bounds, this.#dockedVisible);
  }

  setDockedPresentation(bounds: Rectangle, visible: boolean): void {
    this.#dockedBounds = sanitizeRectangle(bounds);
    this.#dockedVisible = visible;
    if (this.#host !== "docked") return;
    if (visible) {
      this.#attachToMainIfVisible();
      this.#view.setBounds(this.#dockedBounds);
    } else {
      this.#detachFromMain();
    }
  }

  setWorkspaceVisible(visible: boolean): void {
    if (this.#workspaceVisible === visible) return;
    this.#workspaceVisible = visible;
    this.#syncVisibility();
  }

  setPanelVisible(visible: boolean): void {
    if (this.#panelVisible === visible) return;
    this.#panelVisible = visible;
    this.#syncVisibility();
  }

  focusFloating(): void {
    const floatingWindow = this.#floatingWindow;
    if (
      floatingWindow !== null
      && !floatingWindow.isDestroyed()
      && floatingWindow.isVisible()
    ) {
      floatingWindow.focus();
    }
  }

  getDockedScreenBounds(): Rectangle {
    const content = this.#mainWindow.getContentBounds();
    return {
      x: content.x + this.#dockedBounds.x,
      y: content.y + this.#dockedBounds.y,
      width: this.#dockedBounds.width,
      height: this.#dockedBounds.height,
    };
  }

  cursorIsOverDockSlot(
    point: { readonly x: number; readonly y: number } =
      screen.getCursorScreenPoint(),
  ): boolean {
    const bounds = this.getDockedScreenBounds();
    return point.x >= bounds.x
      && point.y >= bounds.y
      && point.x < bounds.x + bounds.width
      && point.y < bounds.y + bounds.height;
  }

  float(
    bounds?: Rectangle,
    options: FloatPanelOptions = {},
  ): DockPanelHostSnapshot {
    if (
      this.#isDisposing
      || this.#mainWindow.isDestroyed()
      || this.#host === "floating"
    ) {
      return this.snapshot();
    }

    const requestedBounds = bounds === undefined
      ? this.#defaultFloatingBounds()
      : sanitizeRectangle(bounds);
    const primaryDisplayId = screen.getPrimaryDisplay().id;
    const targetBounds = recoverWindowBounds(
      requestedBounds,
      screen.getAllDisplays().map((display) => ({
        id: display.id,
        workArea: display.workArea,
        primary: display.id === primaryDisplayId,
        scaleFactor: display.scaleFactor,
      })),
      {
        minimumWidth: 220,
        minimumHeight: 160,
      },
    );
    let floatingWindow: BaseWindow;
    try {
      floatingWindow = new BaseWindow({
        title: this.#title,
        x: targetBounds.x,
        y: targetBounds.y,
        width: Math.max(240, targetBounds.width),
        height: Math.max(180, targetBounds.height),
        minWidth: 220,
        minHeight: 160,
        show: false,
        focusable: options.dragging !== true,
        closable: false,
        autoHideMenuBar: true,
        parent: this.#mainWindow,
      });
      floatingWindow.setMenu(null);
      floatingWindow.setMenuBarVisibility(false);
      if (options.boundsKind === "content") {
        floatingWindow.setContentSize(
          Math.max(1, targetBounds.width),
          Math.max(1, targetBounds.height),
        );
      }
    } catch (error: unknown) {
      process.stderr.write(
        `Electron Dock failed to create floating window for ${this.#panelId}: ${String(error)}\n`,
      );
      return this.snapshot();
    }

    this.#detachFromMain();
    try {
      floatingWindow.contentView.addChildView(this.#view);
    } catch (error: unknown) {
      process.stderr.write(
        `Electron Dock failed to reparent panel ${this.#panelId}: ${String(error)}\n`,
      );
      floatingWindow.setClosable(true);
      floatingWindow.close();
      this.#attachToMainIfVisible();
      return this.snapshot();
    }
    this.#floatingWindow = floatingWindow;
    this.#host = "floating";
    this.#layoutFloatingView();
    floatingWindow.on("resize", () => {
      this.#layoutFloatingView();
    });
    floatingWindow.on("will-move", () => {
      if (this.#isDisposing || this.#host !== "floating") return;
      for (const listener of this.#floatingMoveListeners) listener();
    });
    floatingWindow.on("closed", () => {
      if (this.#isDisposing || this.#host !== "floating") return;
      this.#floatingWindow = null;
      this.#redockAfterFloatingClose();
    });
    if (options.dragging === true) {
      floatingWindow.setIgnoreMouseEvents(true);
    }
    floatingWindow.show();
    this.#syncVisibility();
    this.#notifyHostChanged();
    return this.snapshot();
  }

  redock(): DockPanelHostSnapshot {
    if (
      this.#isDisposing
      || this.#mainWindow.isDestroyed()
      || this.#host === "docked"
    ) {
      return this.snapshot();
    }
    const floatingWindow = this.#floatingWindow;
    if (floatingWindow !== null && !floatingWindow.isDestroyed()) {
      floatingWindow.contentView.removeChildView(this.#view);
    }
    this.#floatingWindow = null;
    this.#host = "docked";
    this.#attachToMainIfVisible();
    if (floatingWindow !== null && !floatingWindow.isDestroyed()) {
      floatingWindow.setClosable(true);
      floatingWindow.close();
    }
    this.#notifyHostChanged();
    return this.snapshot();
  }

  alignFloatingPointer(
    anchor: { readonly x: number; readonly y: number },
    cursor: { readonly x: number; readonly y: number },
  ): void {
    const floatingWindow = this.#floatingWindow;
    if (floatingWindow === null || floatingWindow.isDestroyed()) return;
    // The pointer starts in the dock title bar and must remain at the same
    // offset in the native floating caption. Mapping it into the client area
    // added the Windows non-client height a second time, causing a visible
    // vertical jump as soon as the dock tore off.
    floatingWindow.setPosition(
      Math.round(cursor.x - anchor.x),
      Math.round(cursor.y - anchor.y),
      false,
    );
  }

  setFloatingDragInteraction(active: boolean): void {
    const floatingWindow = this.#floatingWindow;
    if (floatingWindow === null || floatingWindow.isDestroyed()) return;
    floatingWindow.setIgnoreMouseEvents(active);
    floatingWindow.setFocusable(!active);
    if (!active) {
      floatingWindow.focus();
    }
  }

  snapshot(): DockPanelHostSnapshot {
    return {
      panelId: this.#panelId,
      webContentsId: this.#view.webContents.id,
      host: this.#host,
      visible: this.visible,
      hasFloatingWindow: this.#floatingWindow !== null
        && !this.#floatingWindow.isDestroyed(),
    };
  }

  async readRendererSnapshot(): Promise<unknown> {
    return this.#view.webContents.executeJavaScript(
      "globalThis.__electronDockReadSnapshot?.()",
      true,
    );
  }

  notifyPanelState(message: PanelStateMessage): void {
    if (!this.#view.webContents.isDestroyed()) {
      this.#view.webContents.send(IPC.panelStateChanged, message);
    }
  }

  async prepareSmokeRuntimeState(): Promise<void> {
    const deadline = Date.now() + 2_000;
    let hookReady = false;
    while (Date.now() < deadline) {
      hookReady = await this.#view.webContents.executeJavaScript(
        "typeof globalThis.__electronDockMutateForSmoke === 'function'",
        true,
      ) === true;
      if (hookReady) break;
      await delay(20);
    }
    if (!hookReady) {
      throw new Error("Smoke renderer mutation hook did not become ready");
    }

    await this.#view.webContents.executeJavaScript(
      "globalThis.__electronDockMutateForSmoke()",
      true,
    );
    const settleDeadline = Date.now() + 2_000;
    let lastSnapshot: unknown = null;
    while (Date.now() < settleDeadline) {
      lastSnapshot = await this.readRendererSnapshot();
      if (smokeRuntimeStateIsReady(lastSnapshot)) return;
      await delay(20);
    }
    throw new Error(
      `Smoke renderer mutation did not settle: ${JSON.stringify(lastSnapshot)}`,
    );
  }

  dispose(): void {
    if (this.#isDisposing) return;
    this.#isDisposing = true;
    const floatingWindow = this.#floatingWindow;
    this.#floatingWindow = null;
    if (floatingWindow !== null && !floatingWindow.isDestroyed()) {
      floatingWindow.contentView.removeChildView(this.#view);
      floatingWindow.setClosable(true);
      floatingWindow.close();
    } else {
      this.#detachFromMain();
    }
    if (!this.#view.webContents.isDestroyed()) {
      this.#view.webContents.close();
    }
    this.#floatingMoveListeners.clear();
  }

  #redockAfterFloatingClose(): void {
    if (
      this.#isDisposing
      || this.#mainWindow.isDestroyed()
      || this.#view.webContents.isDestroyed()
    ) {
      return;
    }
    this.#host = "docked";
    this.#attachToMainIfVisible();
    this.#notifyHostChanged();
  }

  #layoutFloatingView(): void {
    const floatingWindow = this.#floatingWindow;
    if (floatingWindow === null || floatingWindow.isDestroyed()) return;
    const contentBounds = floatingWindow.getContentBounds();
    this.#view.setBounds({
      x: 0,
      y: 0,
      width: Math.max(1, contentBounds.width),
      height: Math.max(1, contentBounds.height),
    });
  }

  #defaultFloatingBounds(): Rectangle {
    const mainContent = this.#mainWindow.getContentBounds();
    return {
      x: mainContent.x + this.#dockedBounds.x + 32,
      y: mainContent.y + this.#dockedBounds.y + 32,
      width: this.#dockedBounds.width,
      height: this.#dockedBounds.height,
    };
  }

  #notifyHostChanged(): void {
    const message: HostChangedMessage = {
      panelId: this.#panelId,
      host: this.#host,
      webContentsId: this.#view.webContents.id,
    };
    if (!this.#view.webContents.isDestroyed()) {
      this.#view.webContents.send(IPC.hostChanged, message);
    }
  }

  #attachToMainIfVisible(): void {
    if (
      !this.#dockedVisible
      || !this.#workspaceVisible
      || !this.#panelVisible
      || this.#attachedToMain
      || this.#mainWindow.isDestroyed()
      || this.#view.webContents.isDestroyed()
    ) {
      return;
    }
    this.#mainWindow.contentView.addChildView(this.#view);
    this.#attachedToMain = true;
    this.#view.setBounds(this.#dockedBounds);
  }

  #detachFromMain(): void {
    if (!this.#attachedToMain || this.#mainWindow.isDestroyed()) return;
    this.#mainWindow.contentView.removeChildView(this.#view);
    this.#attachedToMain = false;
  }

  #syncVisibility(): void {
    if (this.#host === "docked") {
      if (
        this.#dockedVisible
        && this.#workspaceVisible
        && this.#panelVisible
      ) {
        this.#attachToMainIfVisible();
      } else {
        this.#detachFromMain();
      }
      return;
    }

    const floatingWindow = this.#floatingWindow;
    if (floatingWindow === null || floatingWindow.isDestroyed()) return;
    if (this.#workspaceVisible && this.#panelVisible) {
      floatingWindow.show();
    } else {
      floatingWindow.hide();
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function smokeRuntimeStateIsReady(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const snapshot = value as Record<string, unknown>;
  return snapshot.counter === 37
    && snapshot.inputValue === "smoke-state"
    && snapshot.scrollTop === 180;
}

export function resolveRendererPath(relativePath: string): string {
  return path.resolve(import.meta.dirname, "..", "renderer", relativePath);
}

function optionalPanelWebPreferences(
  content: DockPanelContentOptions | undefined,
): Pick<WebPreferences, "additionalArguments" | "backgroundThrottling"> {
  const preferences: Pick<
    WebPreferences,
    "additionalArguments" | "backgroundThrottling"
  > = {};
  if (content?.additionalArguments !== undefined) {
    preferences.additionalArguments = [...content.additionalArguments];
  }
  if (content?.backgroundThrottling !== undefined) {
    preferences.backgroundThrottling = content.backgroundThrottling;
  }
  return preferences;
}

interface PanelNavigationPolicy {
  allows(url: string): boolean;
}

function createPanelNavigationPolicy(
  initialUrl: string,
  additionalOrigins: readonly string[] | undefined,
): PanelNavigationPolicy {
  const initial = new URL(initialUrl);
  const allowedOrigins = new Set<string>();
  if (isHttpOrigin(initial)) allowedOrigins.add(initial.origin);

  for (const value of additionalOrigins ?? []) {
    const origin = new URL(value);
    if (!isHttpOrigin(origin) || origin.username !== "" || origin.password !== "") {
      throw new Error(
        `Electron Dock panel navigation allowlist entries must be credential-free HTTP(S) origins: ${value}`,
      );
    }
    allowedOrigins.add(origin.origin);
  }

  return {
    allows(candidateUrl: string): boolean {
      let candidate: URL;
      try {
        candidate = new URL(candidateUrl);
      } catch {
        return false;
      }
      if (isHttpOrigin(candidate)) {
        return allowedOrigins.has(candidate.origin);
      }
      return normalizeOpaqueDocumentUrl(candidate)
        === normalizeOpaqueDocumentUrl(initial);
    },
  };
}

function isHttpOrigin(url: URL): boolean {
  return url.protocol === "https:" || url.protocol === "http:";
}

function normalizeOpaqueDocumentUrl(url: URL): string {
  const normalized = new URL(url);
  normalized.search = "";
  normalized.hash = "";
  return normalized.href;
}
