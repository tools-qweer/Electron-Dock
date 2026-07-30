import { app, BrowserWindow } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createElectronDockRuntime } from "@tools-qweer/electron-dock";
import {
  createDockLayout,
  createTabsNode,
} from "@tools-qweer/electron-dock/core";

const exampleRoot = import.meta.dirname;
const topBarHeight = 56;
const sidebarWidth = 220;

await app.whenReady();

const owner = new BrowserWindow({
  width: 1180,
  height: 760,
  minWidth: 760,
  minHeight: 520,
  backgroundColor: "#0f1212",
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
});
owner.setMenu(null);
await owner.loadFile(path.join(exampleRoot, "host.html"));

const runtime = createElectronDockRuntime();
const panelPreload = path.join(
  exampleRoot,
  ".generated",
  "panel-preload.cjs",
);

function panelUrl(panelId, title) {
  const url = pathToFileURL(path.join(exampleRoot, "panel.html"));
  url.searchParams.set("panelId", panelId);
  url.searchParams.set("title", title);
  return url.href;
}

function currentWorkspaceBounds() {
  const [width, height] = owner.getContentSize();
  return {
    x: sidebarWidth,
    y: topBarHeight,
    width: Math.max(1, width - sidebarWidth),
    height: Math.max(1, height - topBarHeight),
  };
}

const workspace = await runtime.attachWorkspace({
  id: "attach-existing-window-example",
  window: owner,
  bounds: currentWorkspaceBounds(),
  panels: [
    {
      id: "outline",
      title: "Outline",
      content: {
        url: panelUrl("outline", "Outline panel"),
        preload: panelPreload,
      },
    },
    {
      id: "inspector",
      title: "Inspector",
      content: {
        url: panelUrl("inspector", "Inspector panel"),
        preload: panelPreload,
      },
    },
  ],
  initialLayout: createDockLayout(
    createTabsNode(
      "tabs-example",
      ["outline", "inspector"],
      "outline",
    ),
  ),
  layoutFilePath: path.join(
    app.getPath("userData"),
    "attach-example-layout.json",
  ),
});

owner.on("resize", () => {
  workspace.setBounds(currentWorkspaceBounds());
});

let shuttingDown = false;
owner.on("closed", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void runtime.dispose()
    .catch((error) => {
      process.stderr.write(`Electron Dock disposal failed: ${String(error)}\n`);
    })
    .finally(() => {
      app.quit();
    });
});
