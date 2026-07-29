import electronDockPreload = require("@tools-qweer/electron-dock/preload");

const apiFactory: () => electronDockPreload.ElectronDockPreloadApi =
  electronDockPreload.createElectronDockPreloadApi;

declare const panelApi: electronDockPreload.ElectronDockPreloadApi;
const getHostState = panelApi.getHostState;

// @ts-expect-error The CommonJS public preload is panel-scoped too.
panelApi.onWorkspaceState;

void apiFactory;
void getHostState;
