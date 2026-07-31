import {
  app,
  BaseWindow,
  BrowserWindow,
  ipcMain,
  webContents,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createDockLayout,
  createSplitNode,
  createTabsNode,
  findTabsNode,
} from "../core/layout.js";
import type {
  DockLayoutState,
  DockPanelDefinition,
  Rectangle,
} from "../core/types.js";
import {
  IPC,
  isBeginPanelDragMessage,
  isRectangle,
  isReorderTabMessage,
  isSetActivePanelMessage,
  isSetSplitRatioMessage,
} from "../shared/protocol.js";
import { resolveRendererPath } from "./dock-host.js";
import { DockWorkspaceHost } from "./dock-workspace-host.js";
import { AtomicLayoutTextStorage } from "./layout-file-storage.js";
import { NativeDragController } from "./native-drag-controller.js";

const isSmoke = process.argv.includes("--native-dock-smoke");
const smokePhase = process.argv.find((value) => (
  value.startsWith("--native-dock-smoke-phase=")
))?.split("=")[1] ?? "write";
const PANEL_DEFINITIONS: readonly DockPanelDefinition[] = [
  {
    id: "hierarchy",
    title: "组件层级",
    minimumWidth: 220,
    minimumHeight: 240,
  },
  {
    id: "story-scene",
    title: "故事场景",
    minimumWidth: 400,
    minimumHeight: 280,
  },
  {
    id: "map-scene",
    title: "地图场景",
    minimumWidth: 400,
    minimumHeight: 280,
  },
  {
    id: "inspector",
    title: "组件属性",
    minimumWidth: 300,
    minimumHeight: 240,
  },
] as const;

let mainWindow: BrowserWindow | null = null;
let workspace: DockWorkspaceHost | null = null;
let dragController: NativeDragController | null = null;
let shellRendererUrl: string | null = null;
let disposing = false;
let quitFlushStarted = false;
let quitFlushCompleted = false;

function preloadPath(): string {
  return path.resolve(import.meta.dirname, "..", "preload", "index.cjs");
}

function createInitialLayout(): DockLayoutState {
  const hierarchy = createTabsNode("tabs-hierarchy", ["hierarchy"]);
  const scenes = createTabsNode(
    "tabs-scenes",
    ["story-scene", "map-scene"],
    "story-scene",
  );
  const inspector = createTabsNode("tabs-inspector", ["inspector"]);
  const workArea = createSplitNode(
    "split-work-area",
    "horizontal",
    0.72,
    scenes,
    inspector,
  );
  return createDockLayout(
    createSplitNode(
      "split-root",
      "horizontal",
      0.2,
      hierarchy,
      workArea,
    ),
    20,
  );
}

function senderIsShell(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return frame !== null
    && frame === event.sender.mainFrame
    && mainWindow !== null
    && !mainWindow.isDestroyed()
    && event.sender.id === mainWindow.webContents.id
    && shellRendererUrl !== null
    && frame.url === shellRendererUrl;
}

function senderPanelHost(
  event: IpcMainEvent | IpcMainInvokeEvent,
) {
  const frame = event.senderFrame;
  if (frame === null || frame !== event.sender.mainFrame || workspace === null) {
    return null;
  }
  return workspace.hostByWebContents(event.sender.id);
}

function disposeApplicationResources(): void {
  if (disposing) return;
  disposing = true;
  dragController?.dispose();
  dragController = null;
  workspace?.dispose();
  workspace = null;
}

async function createApplication(): Promise<void> {
  const window = new BrowserWindow({
    title: "Electron Native Dock Demo",
    width: 1360,
    height: 820,
    minWidth: 920,
    minHeight: 560,
    show: false,
    backgroundColor: "#101313",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath(),
    },
  });
  mainWindow = window;
  window.setMenu(null);
  window.setMenuBarVisibility(false);

  const shellUrl = new URL(pathToFileURL(resolveRendererPath("index.html")));
  shellUrl.searchParams.set("mode", "shell");
  shellRendererUrl = shellUrl.href;
  await window.loadURL(shellRendererUrl);

  const dockWorkspace = new DockWorkspaceHost({
    mainWindow: window,
    panels: PANEL_DEFINITIONS,
    initialLayout: createInitialLayout(),
    preloadPath: preloadPath(),
    rendererHtmlPath: resolveRendererPath("index.html"),
    storage: new AtomicLayoutTextStorage(
      path.join(app.getPath("userData"), "dock-layout.json"),
    ),
  });
  workspace = dockWorkspace;
  await dockWorkspace.load();

  const controller = new NativeDragController(window, dockWorkspace);
  dragController = controller;
  await controller.initialize();

  window.once("close", () => {
    if (!isSmoke) void dockWorkspace.flushPersistence();
  });
  window.once("closed", () => {
    mainWindow = null;
    shellRendererUrl = null;
  });
  window.show();

  if (isSmoke) {
    if (smokePhase === "restore") {
      await runRestoreSmoke(dockWorkspace);
    } else {
      await runSmoke(dockWorkspace);
    }
  }
}

ipcMain.handle(IPC.getWorkspaceState, (event) => {
  if (!senderIsShell(event) || workspace === null) return null;
  return workspace.snapshot();
});

ipcMain.on(IPC.setActivePanel, (event, value: unknown) => {
  if (
    !senderIsShell(event)
    || workspace === null
    || !isSetActivePanelMessage(value)
  ) {
    return;
  }
  workspace.activatePanel(value.tabsNodeId, value.panelId);
});

ipcMain.on(IPC.reorderTab, (event, value: unknown) => {
  if (
    !senderIsShell(event)
    || workspace === null
    || !isReorderTabMessage(value)
  ) {
    return;
  }
  workspace.reorderTab(
    value.tabsNodeId,
    value.panelId,
    value.targetIndex,
  );
});

ipcMain.on(IPC.setSplitRatio, (event, value: unknown) => {
  if (
    !senderIsShell(event)
    || workspace === null
    || !isSetSplitRatioMessage(value)
  ) {
    return;
  }
  workspace.resizeSplit(value.splitNodeId, value.ratio);
});

ipcMain.handle(IPC.floatPanel, (event, value: unknown) => {
  const host = senderPanelHost(event);
  if (host === null || workspace === null) return null;
  const bounds = isRectangle(value) ? value : undefined;
  return workspace.floatPanel(host.panelId, bounds)?.snapshot() ?? null;
});

ipcMain.handle(IPC.redockPanel, (event) => {
  const host = senderPanelHost(event);
  if (host === null || workspace === null) return null;
  workspace.redockPanel(host.panelId);
  return host.snapshot();
});

ipcMain.handle(IPC.panelSnapshot, async (event) => {
  const host = senderPanelHost(event);
  return host === null ? null : host.readRendererSnapshot();
});

ipcMain.handle(IPC.getHostState, (event) => {
  const host = senderPanelHost(event);
  if (host === null) return null;
  const snapshot = host.snapshot();
  return {
    panelId: snapshot.panelId,
    host: snapshot.host,
    webContentsId: snapshot.webContentsId,
  };
});

ipcMain.on(IPC.beginPanelDrag, (event, value: unknown) => {
  if (
    !senderIsShell(event)
    || dragController === null
    || workspace === null
    || !isBeginPanelDragMessage(value)
    || workspace.hostByPanelId(value.panelId) === null
  ) {
    return;
  }
  void dragController.begin(value);
});

async function runSmoke(dockWorkspace: DockWorkspaceHost): Promise<void> {
  const host = dockWorkspace.hostByPanelId("story-scene");
  const mapHost = dockWorkspace.hostByPanelId("map-scene");
  if (host === null || mapHost === null) throw new Error("Smoke panel is missing");
  await host.prepareSmokeRuntimeState();
  const initialHost = host.snapshot();
  const initialRenderer = await host.readRendererSnapshot();
  const mapWebContentsId = mapHost.webContentsId;
  dockWorkspace.activatePanel("tabs-scenes", "map-scene");
  await delay(50);
  const tabSwitchedToMap = (
    dockWorkspace.geometry.viewports.some(
      (viewport) => viewport.panelId === "map-scene",
    )
    && !dockWorkspace.geometry.viewports.some(
      (viewport) => viewport.panelId === "story-scene",
    )
  );
  const activeMapSnapshot = await mapHost.readRendererSnapshot();
  const tabReorderCorrect = await runTabReorderPointerSmoke(dockWorkspace);
  dockWorkspace.activatePanel("tabs-scenes", "story-scene");
  dockWorkspace.resizeSplit("split-root", 0.3);
  await dockWorkspace.flushPersistence();
  const splitResizeCorrect = dockWorkspace.layout.root?.type === "split"
    && dockWorkspace.layout.root.id === "split-root"
    && dockWorkspace.layout.root.ratio === 0.3;
  const floatBounds: Rectangle = { x: 180, y: 140, width: 560, height: 440 };
  const floated = dockWorkspace.beginTransientFloat(host.panelId, floatBounds);
  if (floated === null) throw new Error("Smoke panel did not float");
  await delay(120);
  const floatedHost = host.snapshot();
  const floatingMenuHidden = host.floatingWindow !== null
    && !host.floatingWindow.isMenuBarVisible();
  const floatedRenderer = await host.readRendererSnapshot();
  dockWorkspace.setDragPreview(host.panelId, {
    target: {
      tabsNodeId: "tabs-hierarchy",
      position: "right",
    },
    previewBounds: { x: 0, y: 0, width: 1, height: 1 },
  });
  const edgePreviewGeometry = dockWorkspace.snapshot().geometry;
  const edgePreviewSlotIsEmpty = (
    !edgePreviewGeometry.titleBars.some(
      (titleBar) => titleBar.panelId === host.panelId,
    )
    && !edgePreviewGeometry.tabStrips.some(
      (tabStrip) => tabStrip.panelIds.includes(host.panelId),
    )
  );
  dockWorkspace.cancelTransientFloat(host.panelId);
  await delay(120);
  const redockedHost = host.snapshot();
  const redockedRenderer = await host.readRendererSnapshot();
  const dockCandidateIntegration = await runDockCandidateIntegrationSmoke();

  const liveWindows = BaseWindow.getAllWindows()
    .filter((candidate) => !candidate.isDestroyed());
  const allHosts = dockWorkspace.hosts;
  const webContentsIds = allHosts.map((candidate) => candidate.webContentsId);
  const rendererStateStable = snapshotsHaveStableRuntimeState([
    initialRenderer,
    floatedRenderer,
    redockedRenderer,
  ]);
  const result = {
    sameWebContents: initialHost.webContentsId === floatedHost.webContentsId
      && floatedHost.webContentsId === redockedHost.webContentsId,
    floated: floatedHost.host === "floating" && floatedHost.hasFloatingWindow,
    redocked: redockedHost.host === "docked" && !redockedHost.hasFloatingWindow,
    windowLeakFree: liveWindows.length === 1,
    rendererStateStable,
    rendererStateWasMutated: isExpectedMutatedSnapshot(initialRenderer),
    rendererHostTransitionsAreCorrect: rendererSnapshotsMatchHosts([
      [initialRenderer, initialHost],
      [floatedRenderer, floatedHost],
      [redockedRenderer, redockedHost],
    ]),
    mainMenuHidden: !windowMenuIsVisible(),
    floatingMenuHidden,
    panelCountCorrect: allHosts.length === PANEL_DEFINITIONS.length,
    panelWebContentsUnique: new Set(webContentsIds).size === webContentsIds.length,
    tabSwitchCorrect: tabSwitchedToMap,
    tabReorderCorrect,
    inactiveWebContentsPreserved: (
      mapHost.webContentsId === mapWebContentsId
      && snapshotUsesWebContents(activeMapSnapshot, mapWebContentsId)
    ),
    splitResizeCorrect,
    edgePreviewSlotIsEmpty,
    ...dockCandidateIntegration,
    webContentsId: initialHost.webContentsId,
    windowCount: liveWindows.length,
    persistenceSeeded: false,
  };
  const persistedFloat = dockWorkspace.floatPanel(
    "map-scene",
    { x: 240, y: 180, width: 480, height: 360 },
  );
  await dockWorkspace.flushPersistence();
  result.persistenceSeeded = (
    persistedFloat?.host === "floating"
    && dockWorkspace.layout.floating.some(
      (entry) => entry.panelId === "map-scene",
    )
  );
  process.stdout.write(`REPARENT_SMOKE ${JSON.stringify(result)}\n`);
  await delay(50);
  const passed = Object.entries(result)
    .filter(([, value]) => typeof value === "boolean")
    .every(([, value]) => value === true);
  disposeApplicationResources();
  app.exit(passed ? 0 : 1);
}

async function runTabReorderPointerSmoke(
  dockWorkspace: DockWorkspaceHost,
): Promise<boolean> {
  const shell = webContents.fromId(dockWorkspace.shellWebContentsId);
  if (shell === undefined || shell.isDestroyed()) return false;
  const rawBounds = await shell.executeJavaScript(`
    Array.from(document.querySelectorAll(".dock-tab")).map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        panelId: element.dataset.panelId,
        x: bounds.left,
        y: bounds.top,
        width: bounds.width,
        height: bounds.height,
      };
    });
  `) as unknown;
  if (!Array.isArray(rawBounds)) return false;
  const entries = rawBounds.filter((value): value is {
    readonly panelId: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } => (
    typeof value === "object"
    && value !== null
    && typeof value.panelId === "string"
    && ["x", "y", "width", "height"].every((key) => (
      typeof Reflect.get(value, key) === "number"
    ))
  ));
  const story = entries.find((entry) => entry.panelId === "story-scene");
  const map = entries.find((entry) => entry.panelId === "map-scene");
  if (story === undefined || map === undefined) return false;
  const start = {
    x: Math.round(map.x + map.width / 2),
    y: Math.round(map.y + map.height / 2),
  };
  const destination = {
    x: Math.round(story.x + story.width / 2 - 2),
    y: start.y,
  };
  const readDomState = (): Promise<unknown> => shell.executeJavaScript(`
    ({
      order: Array.from(document.querySelectorAll(".dock-tab"))
        .map((element) => element.dataset.panelId),
      reordering: document.querySelector(".dock-tab--reordering")
        ?.dataset.panelId ?? null,
      active: document.querySelector(".dock-tab--active")
        ?.dataset.panelId ?? null,
      animationCount: Array.from(document.querySelectorAll(".dock-tab"))
        .reduce((count, element) => count + element.getAnimations()
          .filter((animation) => animation.playState === "running").length, 0),
      cursor: getComputedStyle(document.querySelector(".dock-tab")).cursor,
    });
  `);
  const readTabCenter = async (
    panelId: string,
  ): Promise<{ readonly x: number; readonly y: number } | null> => {
    const serializedPanelId = JSON.stringify(panelId);
    const value = await shell.executeJavaScript(`
      (() => {
        const element = Array.from(document.querySelectorAll(".dock-tab"))
          .find((candidate) => candidate.dataset.panelId === ${serializedPanelId});
        if (!element) return null;
        const bounds = element.getBoundingClientRect();
        return {
          x: Math.round(bounds.left + bounds.width / 2),
          y: Math.round(bounds.top + bounds.height / 2),
        };
      })();
    `) as unknown;
    if (
      typeof value !== "object"
      || value === null
      || typeof Reflect.get(value, "x") !== "number"
      || typeof Reflect.get(value, "y") !== "number"
    ) {
      return null;
    }
    return {
      x: Reflect.get(value, "x") as number,
      y: Reflect.get(value, "y") as number,
    };
  };
  shell.focus();
  const debuggerWasAttached = shell.debugger.isAttached();
  if (!debuggerWasAttached) shell.debugger.attach("1.3");
  let pointerDownState: unknown;
  let pointerMoveState: unknown;
  let pointerUpState: unknown;
  let storyClickState: unknown;
  let mapClickState: unknown;
  let storyClickActivated = false;
  let mapClickActivated = false;
  try {
    await shell.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...start,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await delay(40);
    pointerDownState = await readDomState();
    await shell.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...destination,
      button: "left",
      buttons: 1,
    });
    await delay(80);
    pointerMoveState = await readDomState();
    await shell.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...destination,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await delay(120);
    pointerUpState = await readDomState();
    const storyCenter = await readTabCenter("story-scene");
    if (storyCenter !== null) {
      await shell.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...storyCenter,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await shell.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...storyCenter,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      await delay(80);
      storyClickState = await readDomState();
      storyClickActivated = findTabsNode(
        dockWorkspace.layout.root,
        "tabs-scenes",
      )?.activePanelId === "story-scene";
    }
    const mapCenter = await readTabCenter("map-scene");
    if (mapCenter !== null) {
      await shell.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...mapCenter,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await shell.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...mapCenter,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      await delay(80);
      mapClickState = await readDomState();
      mapClickActivated = findTabsNode(
        dockWorkspace.layout.root,
        "tabs-scenes",
      )?.activePanelId === "map-scene";
    }
  } finally {
    if (!debuggerWasAttached && shell.debugger.isAttached()) {
      shell.debugger.detach();
    }
  }
  const tabs = findTabsNode(dockWorkspace.layout.root, "tabs-scenes");
  const moveEvidence = pointerMoveState as {
    readonly animationCount?: unknown;
    readonly cursor?: unknown;
  };
  const passed = tabs?.activePanelId === "map-scene"
    && tabs.panelIds[0] === "map-scene"
    && tabs.panelIds[1] === "story-scene"
    && storyClickActivated
    && mapClickActivated
    && typeof moveEvidence.animationCount === "number"
    && moveEvidence.animationCount > 0
    && moveEvidence.cursor === "default";
  if (!passed) {
    process.stderr.write(`TAB_REORDER_SMOKE_DIAGNOSTIC ${JSON.stringify({
      entries,
      start,
      destination,
      pointerDownState,
      pointerMoveState,
      pointerUpState,
      storyClickState,
      mapClickState,
      storyClickActivated,
      mapClickActivated,
      layout: tabs,
    })}\n`);
  }
  return passed;
}

async function runDockCandidateIntegrationSmoke(): Promise<{
  readonly localPreviewMatchesCommit: boolean;
  readonly workspacePreviewMatchesCommit: boolean;
  readonly localAndWorkspaceKeepFloatingWidth: boolean;
  readonly minimumConstrainedRoundTripStable: boolean;
  readonly defaultFloatKeepsDockedContentSize: boolean;
}> {
  const fixtureWindow = new BrowserWindow({
    title: "Dock candidate integration smoke",
    width: 1_100,
    height: 760,
    show: false,
    autoHideMenuBar: true,
  });
  fixtureWindow.setMenu(null);
  fixtureWindow.setMenuBarVisibility(false);
  const fixture = new DockWorkspaceHost({
    mainWindow: fixtureWindow,
    panels: [
      {
        id: "smoke-source",
        title: "Smoke source",
        minimumWidth: 160,
        minimumHeight: 120,
      },
      {
        id: "smoke-target",
        title: "Smoke target",
        minimumWidth: 160,
        minimumHeight: 120,
      },
    ],
    initialLayout: createDockLayout(
      createSplitNode(
        "smoke-root",
        "horizontal",
        0.4,
        createTabsNode("smoke-source-tabs", ["smoke-source"]),
        createTabsNode("smoke-target-tabs", ["smoke-target"]),
      ),
      10,
    ),
    preloadPath: preloadPath(),
    rendererHtmlPath: resolveRendererPath("index.html"),
  });

  try {
    await fixture.load();
    const source = fixture.hostByPanelId("smoke-source");
    if (source === null) throw new Error("Dock candidate smoke source is missing");
    const requestedContentWidth = 300;
    const firstFloat = fixture.beginTransientFloat(
      source.panelId,
      {
        x: 180,
        y: 140,
        width: requestedContentWidth,
        height: 320,
      },
    );
    if (firstFloat === null) {
      throw new Error("Dock candidate smoke source did not float");
    }
    const localFloatingWidth = source.floatingContentSize?.width ?? -1;
    const content = fixtureWindow.getContentBounds();
    const workspaceHeight = Math.max(0, content.height - 44);
    const localResolution = fixture.dropResolutionAt(
      {
        x: content.x + Math.round(content.width / 4),
        y: content.y + 44 + Math.round(workspaceHeight / 8),
      },
      source.panelId,
    );
    if (
      localResolution === null
      || localResolution.target.tabsNodeId !== "smoke-target-tabs"
      || localResolution.target.position !== "left"
    ) {
      throw new Error(
        `Unexpected local dock candidate: ${JSON.stringify(localResolution)}`,
      );
    }
    fixture.setDragPreview(source.panelId, localResolution);
    const localPublishedWidth = panelViewportWidth(
      fixture.snapshot().geometry,
      source.panelId,
    );
    fixture.commitDockDrop(source.panelId, localResolution);
    const localCommittedWidth = panelSurfaceWidth(
      fixture.geometry,
      source.panelId,
    );

    const dockedSlot = source.getDockedScreenBounds();
    const secondFloat = fixture.beginTransientFloat(
      source.panelId,
      {
        x: dockedSlot.x,
        y: dockedSlot.y,
        width: dockedSlot.width,
        height: dockedSlot.height,
      },
    );
    if (secondFloat === null) {
      throw new Error("Dock candidate smoke source did not refloat");
    }
    const workspaceFloatingWidth = source.floatingContentSize?.width ?? -1;
    const workspaceResolution = fixture.dropResolutionAt(
      {
        x: content.x + 4,
        y: content.y + 44 + Math.round(workspaceHeight / 2),
      },
      source.panelId,
    );
    if (
      workspaceResolution === null
      || workspaceResolution.target.tabsNodeId !== null
      || workspaceResolution.target.position !== "left"
    ) {
      throw new Error(
        `Unexpected workspace dock candidate: ${JSON.stringify(workspaceResolution)}`,
      );
    }
    fixture.setDragPreview(source.panelId, workspaceResolution);
    const workspacePublishedWidth = panelViewportWidth(
      fixture.snapshot().geometry,
      source.panelId,
    );
    fixture.commitDockDrop(source.panelId, workspaceResolution);
    const workspaceCommittedWidth = panelSurfaceWidth(
      fixture.geometry,
      source.panelId,
    );

    const constrainedFloat = fixture.beginTransientFloat(
      source.panelId,
      {
        x: 220,
        y: 180,
        width: 1,
        height: 1,
      },
    );
    if (constrainedFloat === null) {
      throw new Error("Dock candidate smoke source did not constrained-float");
    }
    const constrainedFloatingWidth = source.floatingContentSize?.width ?? -1;
    const constrainedResolution = fixture.dropResolutionAt(
      {
        x: content.x + Math.round(content.width / 4),
        y: content.y + 44 + Math.round(workspaceHeight / 8),
      },
      source.panelId,
    );
    if (
      constrainedResolution === null
      || constrainedResolution.target.tabsNodeId !== "smoke-target-tabs"
      || constrainedResolution.target.position !== "left"
    ) {
      throw new Error(
        `Unexpected constrained dock candidate: ${
          JSON.stringify(constrainedResolution)
        }`,
      );
    }
    fixture.setDragPreview(source.panelId, constrainedResolution);
    fixture.commitDockDrop(source.panelId, constrainedResolution);
    const constrainedCommittedWidth = panelSurfaceWidth(
      fixture.geometry,
      source.panelId,
    );
    const constrainedDockedSlot = source.getDockedScreenBounds();
    const constrainedRefloat = fixture.beginTransientFloat(
      source.panelId,
      {
        x: constrainedDockedSlot.x,
        y: constrainedDockedSlot.y,
        width: constrainedDockedSlot.width,
        height: constrainedDockedSlot.height,
      },
    );
    if (constrainedRefloat === null) {
      throw new Error("Dock candidate smoke source did not constrained-refloat");
    }
    const constrainedRefloatingWidth = source.floatingContentSize?.width ?? -1;
    fixture.cancelTransientFloat(source.panelId);
    const defaultDockedSlot = source.getDockedScreenBounds();
    const defaultFloat = fixture.floatPanel(source.panelId);
    const defaultFloatSucceeded = defaultFloat?.host === "floating";
    const defaultFloatingContentSize = source.floatingContentSize;
    fixture.redockPanel(source.panelId);

    return {
      localPreviewMatchesCommit: sameSmokeLength(
        localResolution.previewBounds.width,
        localPublishedWidth,
        localCommittedWidth,
      ),
      workspacePreviewMatchesCommit: sameSmokeLength(
        workspaceResolution.previewBounds.width,
        workspacePublishedWidth,
        workspaceCommittedWidth,
      ),
      localAndWorkspaceKeepFloatingWidth: sameSmokeLength(
        requestedContentWidth,
        localFloatingWidth,
        workspaceFloatingWidth,
        localCommittedWidth,
        workspaceCommittedWidth,
      ),
      minimumConstrainedRoundTripStable: (
        constrainedFloatingWidth >= 220
        && sameSmokeLength(
          constrainedFloatingWidth,
          constrainedResolution.previewBounds.width,
          constrainedCommittedWidth,
          constrainedRefloatingWidth,
        )
      ),
      defaultFloatKeepsDockedContentSize: (
        defaultFloatSucceeded
        && defaultFloatingContentSize !== null
        && sameSmokeLength(
          defaultDockedSlot.width,
          defaultFloatingContentSize.width,
        )
        && sameSmokeLength(
          defaultDockedSlot.height,
          defaultFloatingContentSize.height,
        )
      ),
    };
  } finally {
    fixture.dispose();
    if (!fixtureWindow.isDestroyed()) fixtureWindow.destroy();
  }
}

function panelViewportWidth(
  geometry: ReturnType<DockWorkspaceHost["snapshot"]>["geometry"],
  panelId: string,
): number {
  return geometry.viewports.find(
    (viewport) => viewport.panelId === panelId,
  )?.bounds.width ?? -1;
}

function panelSurfaceWidth(
  geometry: ReturnType<DockWorkspaceHost["snapshot"]>["geometry"],
  panelId: string,
): number {
  const tabsNodeId = geometry.titleBars.find(
    (titleBar) => titleBar.panelId === panelId,
  )?.tabsNodeId;
  if (tabsNodeId === undefined) return -1;
  return geometry.dropZones.find((zone) => (
    zone.scope === "tabs"
    && zone.tabsNodeId === tabsNodeId
    && zone.position === "center"
  ))?.previewBounds.width ?? -1;
}

function sameSmokeLength(...values: readonly number[]): boolean {
  const first = values[0];
  return first !== undefined
    && first >= 0
    && values.every((value) => Math.abs(value - first) < 0.01);
}

async function runRestoreSmoke(
  dockWorkspace: DockWorkspaceHost,
): Promise<void> {
  await delay(120);
  const mapHost = dockWorkspace.hostByPanelId("map-scene");
  const root = dockWorkspace.layout.root;
  const liveWindows = BaseWindow.getAllWindows()
    .filter((candidate) => !candidate.isDestroyed());
  const result = {
    splitRatioRestored: root?.type === "split"
      && root.id === "split-root"
      && root.ratio === 0.3,
    floatingPanelRestored: mapHost?.host === "floating"
      && mapHost.floatingBounds !== null,
    floatingEntryRestored: dockWorkspace.layout.floating.some(
      (entry) => entry.panelId === "map-scene",
    ),
    panelCountCorrect: dockWorkspace.hosts.length === PANEL_DEFINITIONS.length,
    expectedWindowCount: liveWindows.length === 2,
  };
  process.stdout.write(`PERSISTENCE_SMOKE ${JSON.stringify(result)}\n`);
  await delay(50);
  const passed = Object.values(result).every((value) => value === true);
  disposeApplicationResources();
  app.exit(passed ? 0 : 1);
}

function snapshotUsesWebContents(value: unknown, expectedId: number): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return (value as Record<string, unknown>).webContentsId === expectedId;
}

function windowMenuIsVisible(): boolean {
  return mainWindow !== null
    && !mainWindow.isDestroyed()
    && mainWindow.isMenuBarVisible();
}

function snapshotsHaveStableRuntimeState(values: readonly unknown[]): boolean {
  if (values.length === 0) return false;
  const snapshots = values.filter((value): value is Record<string, unknown> => (
    typeof value === "object" && value !== null && !Array.isArray(value)
  ));
  if (snapshots.length !== values.length) return false;
  const first = snapshots[0];
  if (first === undefined) return false;
  return snapshots.every((snapshot) => (
    snapshot.webglContextId === first.webglContextId
    && snapshot.webglSignature === first.webglSignature
    && snapshot.webglContextLost === false
    && snapshot.counter === first.counter
    && snapshot.inputValue === first.inputValue
    && snapshot.scrollTop === first.scrollTop
  ));
}

function isExpectedMutatedSnapshot(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const snapshot = value as Record<string, unknown>;
  return snapshot.counter === 37
    && snapshot.inputValue === "smoke-state"
    && snapshot.scrollTop === 180
    && typeof snapshot.webglContextId === "string"
    && snapshot.webglContextId.length > 0
    && snapshot.webglContextLost === false;
}

function rendererSnapshotsMatchHosts(
  values: readonly (
    readonly [unknown, ReturnType<NonNullable<DockWorkspaceHost["hosts"][number]>["snapshot"]>]
  )[],
): boolean {
  return values.every(([value, host]) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const snapshot = value as Record<string, unknown>;
    return snapshot.webContentsId === host.webContentsId
      && snapshot.host === host.host;
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

app.whenReady().then(createApplication).catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  disposeApplicationResources();
  app.exit(1);
});

app.on("before-quit", (event) => {
  if (isSmoke || quitFlushCompleted || workspace === null) return;
  event.preventDefault();
  if (quitFlushStarted) return;
  quitFlushStarted = true;
  void workspace.flushPersistence().finally(() => {
    disposeApplicationResources();
    quitFlushCompleted = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
