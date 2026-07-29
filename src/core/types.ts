export type PanelId = string;
export type DockNodeId = string;
export type DockAxis = "horizontal" | "vertical";
export type DockDropPosition = "left" | "right" | "top" | "bottom" | "center";
export type DockDropScope = "workspace" | "tabs";

export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DockPanelDefinition {
  readonly id: PanelId;
  readonly title: string;
  readonly minimumWidth?: number;
  readonly minimumHeight?: number;
  readonly allowedDropPositions?: readonly DockDropPosition[];
}

export interface DockTabsNode {
  readonly type: "tabs";
  readonly id: DockNodeId;
  readonly panelIds: readonly PanelId[];
  readonly activePanelId: PanelId;
}

export interface DockSplitNode {
  readonly type: "split";
  readonly id: DockNodeId;
  readonly axis: DockAxis;
  readonly ratio: number;
  readonly first: DockNode;
  readonly second: DockNode;
}

export type DockNode = DockTabsNode | DockSplitNode;

export interface FloatingDockPanel {
  readonly panelId: PanelId;
  readonly bounds: Rectangle;
}

export interface DockLayoutState {
  readonly version: 1;
  readonly nextNodeSequence: number;
  readonly root: DockNode | null;
  readonly floating: readonly FloatingDockPanel[];
}

export interface DockDropTarget {
  readonly tabsNodeId: DockNodeId | null;
  readonly position: DockDropPosition;
}

export interface DockDropZone extends DockDropTarget {
  readonly id: string;
  readonly scope: DockDropScope;
  readonly bounds: Rectangle;
  readonly previewBounds: Rectangle;
}

export interface DockPanelViewport {
  readonly panelId: PanelId;
  readonly bounds: Rectangle;
}

export interface DockRendererGeometry {
  readonly viewports: readonly DockPanelViewport[];
  readonly dropZones: readonly DockDropZone[];
}
