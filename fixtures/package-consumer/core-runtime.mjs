import {
  createDockLayout,
  createTabsNode,
} from "@tools-qweer/electron-dock/core";

const layout = createDockLayout(createTabsNode("tabs-1", ["panel-1"]));
if (
  layout.version !== 1
  || layout.root?.type !== "tabs"
  || layout.root.activePanelId !== "panel-1"
) {
  throw new Error(`Unexpected core runtime result: ${JSON.stringify(layout)}`);
}

process.stdout.write(`CORE_RUNTIME_OK ${JSON.stringify(layout)}\n`);
