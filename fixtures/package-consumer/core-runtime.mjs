import {
  DEFAULT_ELECTRON_DOCK_SHELL_APPEARANCE,
  createDockLayout,
  createTabsNode,
  normalizeElectronDockShellAppearance,
} from "@tools-qweer/electron-dock/core";

const layout = createDockLayout(createTabsNode("tabs-1", ["panel-1"]));
if (
  layout.version !== 1
  || layout.root?.type !== "tabs"
  || layout.root.activePanelId !== "panel-1"
) {
  throw new Error(`Unexpected core runtime result: ${JSON.stringify(layout)}`);
}

const appearance = normalizeElectronDockShellAppearance({
  colors: { shellBackground: "#123456" },
});
if (
  appearance.colors.shellBackground !== "#123456"
  || appearance.tab.activeForeground
    !== DEFAULT_ELECTRON_DOCK_SHELL_APPEARANCE.tab.activeForeground
) {
  throw new Error(
    `Unexpected core appearance result: ${JSON.stringify(appearance)}`,
  );
}

process.stdout.write(`CORE_RUNTIME_OK ${JSON.stringify(layout)}\n`);
