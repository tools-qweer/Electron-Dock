export {
  createElectronDockRuntime,
  type ElectronDockPanelDefinition,
  type ElectronDockPanelState,
  type ElectronDockPanelWebContentsCreatedEvent,
  type ElectronDockPanelWebContentsDisposedEvent,
  type ElectronDockRuntime,
  type ElectronDockWindow,
  type ElectronDockWindowOptions,
  type ElectronDockWorkspace,
  type ElectronDockWorkspaceChangeListener,
  type ElectronDockWorkspaceOptions,
  type ElectronDockWorkspaceSnapshot,
} from "../main/public-runtime.js";
export type { DockPanelContentOptions } from "../main/dock-host.js";
export type {
  AtomicLayoutTextStorage,
  DockLayoutPersistenceEnvelopeV1,
} from "../core/layout-persistence.js";
export type {
  DockDropPosition,
  DockDropTarget,
  DockLayoutState,
  DockPanelDefinition,
  DockSplitNode,
  DockTabsNode,
  FloatingDockPanel,
  PanelId,
  Rectangle,
} from "../core/types.js";
