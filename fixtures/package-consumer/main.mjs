import { createRequire } from "node:module";
import { app, BrowserWindow, Menu } from "electron";

app.disableHardwareAcceleration();

let stage = "boot";
const watchdog = setTimeout(() => {
  process.stderr.write(`ELECTRON_CONSUMER_TIMEOUT stage=${stage}\n`);
  app.exit(2);
}, 30_000);

async function run() {
  process.stdout.write(
    `ELECTRON_CONSUMER_BOOT electron=${process.versions.electron}\n`,
  );
  stage = "app-ready";
  await app.whenReady();

  stage = "imports";
  const root = await import("@tools-qweer/electron-dock");
  const core = await import("@tools-qweer/electron-dock/core");
  const require = createRequire(import.meta.url);
  const preload = require("@tools-qweer/electron-dock/preload");

  if (typeof root.createElectronDockRuntime !== "function") {
    throw new Error("Root createElectronDockRuntime export is missing");
  }
  if (
    typeof core.createDockLayout !== "function"
    || typeof core.createTabsNode !== "function"
  ) {
    throw new Error("Core layout exports are missing");
  }
  if (
    typeof preload.createElectronDockPreloadApi !== "function"
    || typeof preload.exposeElectronDockPreloadApi !== "function"
  ) {
    throw new Error("Preload CommonJS exports are missing");
  }
  const publicPreloadKeys = Object.keys(
    preload.createElectronDockPreloadApi(),
  ).sort();
  const expectedPublicPreloadKeys = [
    "floatPanel",
    "getHostState",
    "getPanelState",
    "onHostChanged",
    "onPanelStateChanged",
    "redockPanel",
  ];
  if (
    JSON.stringify(publicPreloadKeys)
    !== JSON.stringify(expectedPublicPreloadKeys)
  ) {
    throw new Error(
      "Public preload authority is unexpected: "
      + JSON.stringify(publicPreloadKeys),
    );
  }

  stage = "create-window";
  const initialLayout = core.createDockLayout(
    core.createTabsNode("tabs-1", ["consumer-panel"]),
  );
  const runtime = root.createElectronDockRuntime();

  stage = "attach-owner";
  const ownerWindow = new BrowserWindow({
    width: 860,
    height: 620,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const ownerMenu = Menu.buildFromTemplate([{ label: "Consumer owner" }]);
  ownerWindow.setMenu(ownerMenu);
  let ownerMenuMutations = 0;
  let ownerMenuBarMutations = 0;
  const originalOwnerSetMenu = ownerWindow.setMenu.bind(ownerWindow);
  const originalOwnerSetMenuBarVisibility =
    ownerWindow.setMenuBarVisibility.bind(ownerWindow);
  ownerWindow.setMenu = (menu) => {
    ownerMenuMutations += 1;
    originalOwnerSetMenu(menu);
  };
  ownerWindow.setMenuBarVisibility = (visible) => {
    ownerMenuBarMutations += 1;
    originalOwnerSetMenuBarVisibility(visible);
  };
  await ownerWindow.loadURL(
    "data:text/html;charset=utf-8,"
    + encodeURIComponent(
      "<!doctype html><title>Attach owner sentinel</title>"
      + "<main id=\"owner-sentinel\">owner untouched</main>"
      + "<script>globalThis.__ownerSentinel={count:7}</script>",
    ),
  );
  const ownerWebContentsId = ownerWindow.webContents.id;
  const ownerUrl = ownerWindow.webContents.getURL();
  const ownerCloseListenersBefore = ownerWindow.listenerCount("close");
  const ownerClosedListenersBefore = ownerWindow.listenerCount("closed");
  let ownerCloseCalls = 0;
  let ownerDestroyCalls = 0;
  const originalOwnerClose = ownerWindow.close.bind(ownerWindow);
  const originalOwnerDestroy = ownerWindow.destroy.bind(ownerWindow);
  ownerWindow.close = () => {
    ownerCloseCalls += 1;
    originalOwnerClose();
  };
  ownerWindow.destroy = () => {
    ownerDestroyCalls += 1;
    originalOwnerDestroy();
  };
  let createdPanelEvent = null;
  let createdPanelInitialUrl = null;
  let disposedPanelEvent = null;

  stage = "attach-workspace";
  const attached = await runtime.attachWorkspace({
    id: "tgz-attached",
    window: ownerWindow,
    bounds: { x: 40, y: 36, width: 720, height: 500 },
    shellAppearance: {
      colors: {
        shellBackground: "#121619",
        foreground: "#e7edf0",
      },
      titleBar: {
        background: "#1a2024",
        borderWidth: 0,
        bottomBorderColor: "#35505a",
        bottomBorderWidth: 1,
      },
      tabBar: {
        borderWidth: 0,
        topBorderWidth: 1,
      },
      tab: {
        activeForeground: "#65f7d4",
      },
    },
    panels: [
      {
        id: "consumer-panel",
        title: "Attached consumer",
        content: {
          url:
            "data:text/html;charset=utf-8,"
            + encodeURIComponent(
              "<!doctype html><title>Attached consumer</title>"
              + "<main id=\"attached-ok\">attached panel loaded</main>"
              + "<script>globalThis.__firstPanelState="
              + "window.electronDock.getPanelState()</script>",
            ),
        },
      },
    ],
    initialLayout,
    onPanelWebContentsCreated(event) {
      createdPanelEvent = event;
      createdPanelInitialUrl = event.webContents.getURL();
    },
    onPanelWebContentsDisposed(event) {
      disposedPanelEvent = event;
    },
  });
  if (runtime.workspaceById("tgz-attached") !== attached) {
    throw new Error("Runtime did not retain the attached workspace");
  }
  if (runtime.windowById("tgz-attached") !== null) {
    throw new Error("Attached workspace was incorrectly registered as owned");
  }
  if (
    ownerWindow.webContents.id !== ownerWebContentsId
    || ownerWindow.webContents.getURL() !== ownerUrl
    || ownerMenuMutations !== 0
    || ownerMenuBarMutations !== 0
    || ownerWindow.listenerCount("close") !== ownerCloseListenersBefore
  ) {
    throw new Error("attachWorkspace mutated owner page or menu");
  }
  const ownerSentinel = await ownerWindow.webContents.executeJavaScript(
    "globalThis.__ownerSentinel",
    true,
  );
  if (ownerSentinel?.count !== 7) {
    throw new Error("attachWorkspace reloaded or replaced owner state");
  }
  if (
    createdPanelEvent?.panelId !== "consumer-panel"
    || createdPanelEvent.role !== "panel"
    || createdPanelEvent.generation !== 1
    || createdPanelInitialUrl !== ""
  ) {
    throw new Error(
      "Panel creation hook did not run before loadURL: "
      + JSON.stringify({
        panelId: createdPanelEvent?.panelId,
        role: createdPanelEvent?.role,
        generation: createdPanelEvent?.generation,
        initialUrl: createdPanelInitialUrl,
      }),
    );
  }
  const firstScreenPanelState =
    await createdPanelEvent.webContents.executeJavaScript(
      "globalThis.__firstPanelState",
      true,
    );
  if (
    firstScreenPanelState?.panelId !== "consumer-panel"
    || firstScreenPanelState.host !== "docked"
    || firstScreenPanelState.active !== true
    || firstScreenPanelState.requestedVisible !== true
    || typeof firstScreenPanelState.visible !== "boolean"
    || firstScreenPanelState.webContentsId
      !== createdPanelEvent.webContents.id
  ) {
    throw new Error(
      "Panel first-screen state query failed: "
      + JSON.stringify(firstScreenPanelState),
    );
  }

  const initialAttached = attached.snapshot();
  const attachedPanel = initialAttached.panels[0];
  if (
    initialAttached.bounds.x !== 40
    || initialAttached.bounds.y !== 36
    || initialAttached.bounds.width !== 720
    || initialAttached.bounds.height !== 500
    || attachedPanel?.host !== "docked"
    || attachedPanel.active !== true
    || attachedPanel.requestedVisible !== true
    || attachedPanel.visible !== true
    || attachedPanel.webContentsId === ownerWebContentsId
    || initialAttached.shellAppearance.colors.shellBackground !== "#121619"
    || initialAttached.shellAppearance.titleBar.background !== "#1a2024"
    || initialAttached.shellAppearance.titleBar.borderWidth !== 0
    || initialAttached.shellAppearance.tabBar.borderWidth !== 0
  ) {
    throw new Error(
      "Unexpected initial attached snapshot: "
      + JSON.stringify(initialAttached),
    );
  }

  let attachedChanges = 0;
  const unsubscribeAttached = attached.onDidChange(() => {
    attachedChanges += 1;
  });
  const appearanceLayout = JSON.stringify(initialAttached.layout);
  const appearancePanelWebContentsId = attachedPanel.webContentsId;
  attached.setShellAppearance({
    colors: { shellBackground: "#202830" },
    splitter: { hoverBackground: "#8090a0" },
  });
  const changedAppearance = attached.snapshot();
  if (
    changedAppearance.shellAppearance.colors.shellBackground !== "#202830"
    || changedAppearance.shellAppearance.splitter.hoverBackground !== "#8090a0"
    || JSON.stringify(changedAppearance.layout) !== appearanceLayout
    || changedAppearance.panels[0]?.webContentsId
      !== appearancePanelWebContentsId
  ) {
    throw new Error(
      "Dynamic shell appearance recreated state: "
      + JSON.stringify(changedAppearance),
    );
  }
  attached.setShellAppearance(null);
  const resetAppearance = attached.snapshot();
  if (
    resetAppearance.shellAppearance.colors.shellBackground !== "#101313"
    || JSON.stringify(resetAppearance.layout) !== appearanceLayout
    || resetAppearance.panels[0]?.webContentsId
      !== appearancePanelWebContentsId
  ) {
    throw new Error(
      "Reset shell appearance did not restore stable defaults: "
      + JSON.stringify(resetAppearance),
    );
  }
  attached.setBounds({ x: 52, y: 48, width: 680, height: 450 });
  attached.setInteractionEnabled(false);
  attached.setVisible(false);
  attached.setVisible(true);
  attached.setPanelVisible("consumer-panel", false);
  if (
    attached.snapshot().panels[0]?.requestedVisible !== false
    || attached.snapshot().panels[0]?.visible !== false
  ) {
    throw new Error("setPanelVisible(false) did not hide the attached panel");
  }
  attached.activatePanel("consumer-panel");
  const originalPanelWebContentsId =
    attached.snapshot().panels[0]?.webContentsId;
  const initialPreloadState =
    await createdPanelEvent.webContents.executeJavaScript(
      "window.electronDock.getPanelState()",
      true,
    );
  if (
    initialPreloadState?.host !== "docked"
    || initialPreloadState.active !== true
    || initialPreloadState.requestedVisible !== true
    || initialPreloadState.visible !== true
  ) {
    throw new Error(
      "Public preload panel state is incomplete: "
      + JSON.stringify(initialPreloadState),
    );
  }
  const deniedFloat = await createdPanelEvent.webContents.executeJavaScript(
    "window.electronDock.floatPanel()",
    true,
  );
  if (
    deniedFloat !== null
    || attached.snapshot().panels[0]?.host !== "docked"
  ) {
    throw new Error("Disabled workspace accepted a panel-originated float");
  }
  attached.setInteractionEnabled(true);
  const floatedState = await createdPanelEvent.webContents.executeJavaScript(
    "window.electronDock.floatPanel("
      + "{ x: 120, y: 120, width: 420, height: 300 })",
    true,
  );
  if (
    floatedState?.panelId !== "consumer-panel"
    || floatedState.host !== "floating"
    || floatedState.active !== true
    || floatedState.requestedVisible !== true
    || floatedState.visible !== true
    || floatedState.webContentsId !== originalPanelWebContentsId
    || attached.snapshot().panels[0]?.host !== "floating"
  ) {
    throw new Error(
      "Public preload float returned an unstable panel state: "
      + JSON.stringify(floatedState),
    );
  }
  attached.setVisible(false);
  const deniedRedock = await createdPanelEvent.webContents.executeJavaScript(
    "window.electronDock.redockPanel()",
    true,
  );
  if (
    deniedRedock !== null
    || attached.snapshot().panels[0]?.host !== "floating"
  ) {
    throw new Error("Hidden workspace accepted a panel-originated redock");
  }
  attached.setVisible(true);
  const redockState = await createdPanelEvent.webContents.executeJavaScript(
    "window.electronDock.redockPanel()",
    true,
  );
  const redockedPanel = attached.snapshot().panels[0];
  if (
    redockState?.panelId !== "consumer-panel"
    || redockState.host !== "docked"
    || redockState.active !== true
    || redockState.requestedVisible !== true
    || redockState.visible !== true
    || redockState.webContentsId !== originalPanelWebContentsId
    || redockedPanel?.host !== "docked"
    || redockedPanel.webContentsId !== originalPanelWebContentsId
  ) {
    throw new Error(
      "Public preload redock returned an unstable panel state: "
      + JSON.stringify(redockState),
    );
  }
  attached.reset();
  await attached.flush();
  unsubscribeAttached();
  if (attachedChanges < 8) {
    throw new Error(
      `Attached workspace emitted too few changes: ${attachedChanges}`,
    );
  }

  stage = "dispose-attached";
  await attached.dispose();
  if (
    ownerWindow.isDestroyed()
    || ownerWindow.webContents.id !== ownerWebContentsId
    || ownerWindow.webContents.getURL() !== ownerUrl
    || ownerMenuMutations !== 0
    || ownerMenuBarMutations !== 0
    || ownerWindow.listenerCount("close") !== ownerCloseListenersBefore
    || ownerWindow.listenerCount("closed") !== ownerClosedListenersBefore
    || ownerCloseCalls !== 0
    || ownerDestroyCalls !== 0
    || runtime.workspaceById("tgz-attached") !== null
    || disposedPanelEvent?.panelId !== "consumer-panel"
    || disposedPanelEvent.role !== "panel"
    || disposedPanelEvent.generation !== 1
    || disposedPanelEvent.webContentsId !== originalPanelWebContentsId
  ) {
    throw new Error("Disposing attached workspace mutated its owner");
  }

  stage = "create-window";
  const dockWindow = await runtime.createWindow({
    id: "tgz-consumer",
    panels: [
      {
        id: "consumer-panel",
        title: "TGZ consumer",
        content: {
          url:
            "data:text/html;charset=utf-8,"
            + encodeURIComponent(
              "<!doctype html><title>TGZ consumer</title>"
              + "<main id=\"consumer-ok\">consumer panel loaded</main>",
            ),
        },
      },
    ],
    initialLayout,
    shellAppearance: {
      tab: {
        activeBackground: "#26383d",
        activeForeground: "#72f5da",
      },
    },
    windowOptions: {
      width: 720,
      height: 480,
    },
    show: false,
  });

  if (runtime.windowById("tgz-consumer") !== dockWindow) {
    throw new Error("Runtime did not retain the created window");
  }
  if (dockWindow.window.isVisible()) {
    throw new Error("show:false consumer window unexpectedly became visible");
  }
  const ownedPanelWebContentsId =
    dockWindow.snapshot().panels[0]?.webContentsId;
  const ownedLayout = JSON.stringify(dockWindow.snapshot().layout);
  dockWindow.setShellAppearance({
    titleBar: { background: "#24292d" },
  });
  if (
    dockWindow.snapshot().shellAppearance.titleBar.background !== "#24292d"
    || dockWindow.snapshot().panels[0]?.webContentsId
      !== ownedPanelWebContentsId
    || JSON.stringify(dockWindow.snapshot().layout) !== ownedLayout
  ) {
    throw new Error("Owned-window appearance update recreated Dock state");
  }

  stage = "dispose";
  await runtime.dispose();
  if (ownerWindow.isDestroyed()) {
    throw new Error("Runtime disposal destroyed an attached owner window");
  }
  ownerWindow.destroy();
  stage = "complete";
  await new Promise((resolve) =>
    process.stdout.write(
      "ELECTRON_CONSUMER_OK "
      + `electron=${process.versions.electron} `
      + "root=imported core=executed preload=required "
      + "attach=owner-preserved/sender-hook/first-screen-state/guards/reparent "
      + "window=create/dispose nativeHelper=started\n",
      resolve,
    ),
  );
}

void run().then(
  () => {
    clearTimeout(watchdog);
    app.exit(0);
  },
  (error) => {
    clearTimeout(watchdog);
    process.stderr.write(
      `ELECTRON_CONSUMER_FAIL stage=${stage} `
      + `${error?.stack ?? String(error)}\n`,
    );
    app.exit(1);
  },
);
