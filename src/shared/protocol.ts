import type {
  DockDropTarget,
  DockLayoutState,
  DockPanelDefinition,
  Rectangle,
} from "../core/types.js";
import type { DockLayoutGeometry } from "../core/layout-geometry.js";

export const IPC = {
  workspaceState: "electron-dock:workspace-state",
  getWorkspaceState: "electron-dock:get-workspace-state",
  setActivePanel: "electron-dock:set-active-panel",
  setSplitRatio: "electron-dock:set-split-ratio",
  floatPanel: "electron-dock:float-panel",
  redockPanel: "electron-dock:redock-panel",
  panelSnapshot: "electron-dock:panel-snapshot",
  hostChanged: "electron-dock:host-changed",
  getHostState: "electron-dock:get-host-state",
  panelStateChanged: "electron-dock:panel-state-changed",
  getPanelState: "electron-dock:get-panel-state",
  beginPanelDrag: "electron-dock:begin-panel-drag",
  dragPreview: "electron-dock:drag-preview",
} as const;

export type DockHostKind = "docked" | "floating";

export interface WorkspaceStateMessage {
  readonly panels: readonly DockPanelDefinition[];
  readonly layout: DockLayoutState;
  readonly geometry: DockLayoutGeometry;
  readonly interactionEnabled: boolean;
}

export interface SetActivePanelMessage {
  readonly tabsNodeId: string;
  readonly panelId: string;
}

export interface SetSplitRatioMessage {
  readonly splitNodeId: string;
  readonly ratio: number;
}

export interface PanelSnapshot {
  readonly panelId: string;
  readonly webContentsId: number;
  readonly host: DockHostKind;
  readonly counter: number;
  readonly inputValue: string;
  readonly scrollTop: number;
  readonly webglContextId: string;
}

export interface HostChangedMessage {
  readonly panelId: string;
  readonly host: DockHostKind;
  readonly webContentsId: number;
}

export interface PanelStateMessage {
  readonly panelId: string;
  readonly host: DockHostKind;
  readonly active: boolean;
  /**
   * Stable user visibility preference controlled by setPanelVisible().
   * Unlike visible, this does not become false merely for an inactive tab.
   */
  readonly requestedVisible: boolean;
  /**
   * Whether the panel is currently rendered to the user.
   */
  readonly visible: boolean;
  readonly webContentsId: number;
}

export interface BeginPanelDragMessage {
  readonly panelId: string;
  readonly anchor: {
    readonly x: number;
    readonly y: number;
  };
}

export interface DragPreviewMessage {
  readonly panelId: string;
  readonly active: boolean;
  readonly target: DockDropTarget | null;
  readonly previewBounds: Rectangle | null;
}

export function isRectangle(value: unknown): value is Rectangle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((key) => (
    typeof record[key] === "number" && Number.isFinite(record[key])
  ));
}

export function sanitizeRectangle(value: Rectangle): Rectangle {
  return {
    x: Math.round(value.x),
    y: Math.round(value.y),
    width: Math.max(1, Math.round(value.width)),
    height: Math.max(1, Math.round(value.height)),
  };
}

export function isBeginPanelDragMessage(
  value: unknown,
): value is BeginPanelDragMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const message = value as Partial<BeginPanelDragMessage>;
  if (typeof message.panelId !== "string") return false;
  if (
    typeof message.anchor !== "object"
    || message.anchor === null
    || Array.isArray(message.anchor)
  ) {
    return false;
  }
  return Number.isFinite(message.anchor.x) && Number.isFinite(message.anchor.y);
}

export function isSetActivePanelMessage(
  value: unknown,
): value is SetActivePanelMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const message = value as Partial<SetActivePanelMessage>;
  return typeof message.tabsNodeId === "string"
    && typeof message.panelId === "string";
}

export function isSetSplitRatioMessage(
  value: unknown,
): value is SetSplitRatioMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const message = value as Partial<SetSplitRatioMessage>;
  return typeof message.splitNodeId === "string"
    && typeof message.ratio === "number"
    && Number.isFinite(message.ratio);
}
