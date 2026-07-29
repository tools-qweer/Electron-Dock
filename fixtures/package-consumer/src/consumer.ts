import {
  createElectronDockRuntime,
  type ElectronDockRuntime,
  type ElectronDockWindowOptions,
} from "@tools-qweer/electron-dock";
import {
  createDockLayout,
  createTabsNode,
  type DockLayoutState,
  type DockPanelDefinition,
} from "@tools-qweer/electron-dock/core";
import {
  createElectronDockPreloadApi,
  type ElectronDockPreloadApi,
} from "@tools-qweer/electron-dock/preload";

const panels: readonly DockPanelDefinition[] = [
  { id: "outline", title: "Outline" },
];
const layout: DockLayoutState = createDockLayout(
  createTabsNode("tabs-1", panels.map((panel) => panel.id)),
);
const runtimeFactory: () => ElectronDockRuntime = createElectronDockRuntime;
const preloadFactory: () => ElectronDockPreloadApi =
  createElectronDockPreloadApi;
const windowOptions: ElectronDockWindowOptions = {
  id: "consumer-window",
  panels,
  initialLayout: layout,
};

declare const panelApi: ElectronDockPreloadApi;
const hostState = panelApi.getHostState;
const hostChanges = panelApi.onHostChanged;
const floatPanel = panelApi.floatPanel;
const redockPanel = panelApi.redockPanel;
const readPanelSnapshot = panelApi.readPanelSnapshot;

// @ts-expect-error Public panel preloads must not receive shell layout state.
panelApi.getWorkspaceState;
// @ts-expect-error Public panel preloads must not resize shell splitters.
panelApi.setSplitRatio;
// @ts-expect-error Public panel preloads must not start shell-owned drag flows.
panelApi.beginPanelDrag;

void runtimeFactory;
void preloadFactory;
void windowOptions;
void hostState;
void hostChanges;
void floatPanel;
void redockPanel;
void readPanelSnapshot;
