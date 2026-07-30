import {
  createElectronDockRuntime,
  type ElectronDockRuntime,
  type ElectronDockShellAppearance,
  type ElectronDockWorkspaceOptions,
  type ElectronDockWindowOptions,
} from "@tools-qweer/electron-dock";
import type { BrowserWindow } from "electron";
import {
  createDockLayout,
  createTabsNode,
  normalizeElectronDockShellAppearance,
  type DockLayoutState,
  type DockPanelDefinition,
} from "@tools-qweer/electron-dock/core";
import {
  createElectronDockPreloadApi,
  type ElectronDockPreloadApi,
  type PanelStateMessage,
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
const panelStateIdentity = (state: PanelStateMessage): PanelStateMessage =>
  state;
const windowOptions: ElectronDockWindowOptions = {
  id: "consumer-window",
  panels,
  initialLayout: layout,
};
declare const ownerWindow: BrowserWindow;
const workspaceOptions: ElectronDockWorkspaceOptions = {
  id: "consumer-workspace",
  window: ownerWindow,
  bounds: { x: 20, y: 30, width: 800, height: 600 },
  panels,
  initialLayout: layout,
  shellAppearance: {
    colors: { shellBackground: "#121619" },
    titleBar: { background: "#1a2024", borderWidth: 0 },
  },
};
const appearance: ElectronDockShellAppearance = {
  tab: {
    activeBackground: "#173a34",
    activeForeground: "#00ffcc",
  },
};
const normalizedAppearance = normalizeElectronDockShellAppearance(appearance);
const attachWorkspace = runtimeFactory().attachWorkspace;

declare const panelApi: ElectronDockPreloadApi;
const hostState = panelApi.getHostState;
const hostChanges = panelApi.onHostChanged;
const panelState = panelApi.getPanelState;
const panelStateChanges = panelApi.onPanelStateChanged;
const floatPanel = panelApi.floatPanel;
const redockPanel = panelApi.redockPanel;
const floatResult: Promise<PanelStateMessage | null> = panelApi.floatPanel();
const redockResult: Promise<PanelStateMessage | null> = panelApi.redockPanel();

// @ts-expect-error Renderer snapshots are a smoke-only internal capability.
panelApi.readPanelSnapshot;

// @ts-expect-error Public panel preloads must not receive shell layout state.
panelApi.getWorkspaceState;
// @ts-expect-error Public panel preloads must not resize shell splitters.
panelApi.setSplitRatio;
// @ts-expect-error Public panel preloads must not start shell-owned drag flows.
panelApi.beginPanelDrag;

void runtimeFactory;
void preloadFactory;
void panelStateIdentity;
void windowOptions;
void workspaceOptions;
void appearance;
void normalizedAppearance;
void attachWorkspace;
void hostState;
void hostChanges;
void panelState;
void panelStateChanges;
void floatPanel;
void redockPanel;
void floatResult;
void redockResult;
