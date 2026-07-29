import { createRequire } from "node:module";
import { app } from "electron";

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
    "onHostChanged",
    "readPanelSnapshot",
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

  stage = "dispose";
  await runtime.dispose();
  stage = "complete";
  await new Promise((resolve) =>
    process.stdout.write(
      "ELECTRON_CONSUMER_OK "
      + `electron=${process.versions.electron} `
      + "root=imported core=executed preload=required "
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
