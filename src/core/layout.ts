import type {
  DockDropTarget,
  DockLayoutState,
  DockNode,
  DockPanelDefinition,
  DockSplitNode,
  DockTabsNode,
  FloatingDockPanel,
  PanelId,
  Rectangle,
} from "./types.js";

const MINIMUM_SPLIT_RATIO = 0.1;
const MAXIMUM_SPLIT_RATIO = 0.9;

/**
 * Optional geometry preference for one edge insertion.
 *
 * The ratio always describes the share requested by the inserted panel,
 * independent of whether it lands before or after the target node.
 */
export interface DockPanelInsertionOptions {
  readonly insertedRatio?: number | undefined;
}

export function createDockLayout(
  root: DockNode | null,
  nextNodeSequence = 1,
): DockLayoutState {
  return {
    version: 1,
    nextNodeSequence,
    root,
    floating: [],
  };
}

export function createTabsNode(
  id: string,
  panelIds: readonly PanelId[],
  activePanelId: PanelId = requireFirstPanel(panelIds),
): DockTabsNode {
  if (!panelIds.includes(activePanelId)) {
    throw new Error(`Active panel ${activePanelId} is not part of ${id}`);
  }
  return {
    type: "tabs",
    id,
    panelIds: [...panelIds],
    activePanelId,
  };
}

export function createSplitNode(
  id: string,
  axis: DockSplitNode["axis"],
  ratio: number,
  first: DockNode,
  second: DockNode,
): DockSplitNode {
  return {
    type: "split",
    id,
    axis,
    ratio: clampSplitRatio(ratio),
    first,
    second,
  };
}

export function collectDockedPanelIds(root: DockNode | null): PanelId[] {
  if (root === null) return [];
  if (root.type === "tabs") return [...root.panelIds];
  return [
    ...collectDockedPanelIds(root.first),
    ...collectDockedPanelIds(root.second),
  ];
}

export function findTabsNode(
  root: DockNode | null,
  nodeId: string,
): DockTabsNode | null {
  if (root === null) return null;
  if (root.type === "tabs") return root.id === nodeId ? root : null;
  return (
    findTabsNode(root.first, nodeId)
    ?? findTabsNode(root.second, nodeId)
  );
}

export function setActivePanel(
  state: DockLayoutState,
  tabsNodeId: string,
  panelId: PanelId,
): DockLayoutState {
  return {
    ...state,
    root: mapDockNode(state.root, (node) => {
      if (node.type !== "tabs" || node.id !== tabsNodeId) return node;
      if (!node.panelIds.includes(panelId)) return node;
      return { ...node, activePanelId: panelId };
    }),
  };
}

/**
 * Moves one panel inside an existing tab group.
 *
 * The destination is the panel's final zero-based index. Invalid identities,
 * non-integer destinations and no-op moves preserve the original state
 * reference so callers can avoid publishing or persisting redundant layouts.
 */
export function reorderTab(
  state: DockLayoutState,
  tabsNodeId: string,
  panelId: PanelId,
  targetIndex: number,
): DockLayoutState {
  if (!Number.isSafeInteger(targetIndex)) return state;
  let changed = false;
  const root = mapDockNode(state.root, (node) => {
    if (node.type !== "tabs" || node.id !== tabsNodeId) return node;
    const sourceIndex = node.panelIds.indexOf(panelId);
    if (sourceIndex < 0) return node;
    const destination = Math.min(
      node.panelIds.length - 1,
      Math.max(0, targetIndex),
    );
    if (sourceIndex === destination) return node;
    const panelIds = [...node.panelIds];
    const [movedPanelId] = panelIds.splice(sourceIndex, 1);
    if (movedPanelId === undefined) return node;
    panelIds.splice(destination, 0, movedPanelId);
    changed = true;
    return { ...node, panelIds };
  });
  return changed ? { ...state, root } : state;
}

export function setSplitRatio(
  state: DockLayoutState,
  splitNodeId: string,
  ratio: number,
): DockLayoutState {
  return {
    ...state,
    root: mapDockNode(state.root, (node) => (
      node.type === "split" && node.id === splitNodeId
        ? { ...node, ratio: clampSplitRatio(ratio) }
        : node
    )),
  };
}

export function floatPanel(
  state: DockLayoutState,
  panelId: PanelId,
  bounds: Rectangle,
): DockLayoutState {
  const stripped = removePanelFromNode(state.root, panelId);
  const floating = state.floating.filter((entry) => entry.panelId !== panelId);
  return {
    ...state,
    root: stripped,
    floating: [...floating, { panelId, bounds: sanitizeBounds(bounds) }],
  };
}

export function updateFloatingBounds(
  state: DockLayoutState,
  panelId: PanelId,
  bounds: Rectangle,
): DockLayoutState {
  let found = false;
  const floating = state.floating.map((entry) => {
    if (entry.panelId !== panelId) return entry;
    found = true;
    return { panelId, bounds: sanitizeBounds(bounds) };
  });
  return found ? { ...state, floating } : state;
}

export function dockPanel(
  state: DockLayoutState,
  panelId: PanelId,
  target: DockDropTarget,
  options: DockPanelInsertionOptions = {},
): DockLayoutState {
  const existingTarget = target.tabsNodeId === null
    ? null
    : findTabsNode(state.root, target.tabsNodeId);
  if (
    target.position === "center"
    && existingTarget?.panelIds.includes(panelId) === true
  ) {
    return setActivePanel(state, existingTarget.id, panelId);
  }

  let nextSequence = state.nextNodeSequence;
  const nextId = (prefix: "tabs" | "split"): string => {
    const id = `${prefix}-${nextSequence}`;
    nextSequence += 1;
    return id;
  };

  const withoutPanel = removePanelFromNode(state.root, panelId);
  const withoutFloating = state.floating.filter((entry) => entry.panelId !== panelId);
  const newTabs = createTabsNode(nextId("tabs"), [panelId]);

  let root: DockNode;
  if (withoutPanel === null) {
    root = newTabs;
  } else if (target.tabsNodeId === null) {
    root = wrapNodeForDrop(
      withoutPanel,
      newTabs,
      target.position,
      nextId,
      options.insertedRatio,
    );
  } else {
    const targetStillExists = findTabsNode(withoutPanel, target.tabsNodeId);
    root = targetStillExists === null
      ? wrapNodeForDrop(
        withoutPanel,
        newTabs,
        target.position,
        nextId,
        options.insertedRatio,
      )
      : insertAtTabsNode(
        withoutPanel,
        targetStillExists.id,
        panelId,
        target.position,
        newTabs,
        nextId,
        options.insertedRatio,
      );
  }

  return {
    ...state,
    nextNodeSequence: nextSequence,
    root,
    floating: withoutFloating,
  };
}

export function removePanel(
  state: DockLayoutState,
  panelId: PanelId,
): DockLayoutState {
  return {
    ...state,
    root: removePanelFromNode(state.root, panelId),
    floating: state.floating.filter((entry) => entry.panelId !== panelId),
  };
}

export function restoreDockLayout(
  value: unknown,
  panels: readonly DockPanelDefinition[],
  fallback: DockLayoutState,
): DockLayoutState {
  const allowedIds = new Set(panels.map((panel) => panel.id));
  if (!isRecord(value) || value.version !== 1) return fallback;
  const seen = new Set<PanelId>();
  const nodeIds = new Set<string>();
  const root = normalizeNode(value.root, allowedIds, seen, nodeIds);
  const floating = normalizeFloating(value.floating, allowedIds, seen);
  if (root === null && floating.length === 0) return fallback;
  const missingPanelIds: PanelId[] = [];
  for (const panel of panels) {
    if (seen.has(panel.id)) continue;
    seen.add(panel.id);
    missingPanelIds.push(panel.id);
  }
  let nextNodeSequence = Math.max(
    requireFiniteInteger(value.nextNodeSequence, 1),
    getNextNodeSequence(root),
  );
  const supplementedRoot = root === null
    ? missingPanelIds.length === 0
      ? null
      : createTabsNode(`tabs-${nextNodeSequence++}`, missingPanelIds)
    : appendPanelsToFirstTabsNode(root, missingPanelIds);
  return {
    version: 1,
    nextNodeSequence,
    root: supplementedRoot,
    floating,
  };
}

export function assertDockLayoutInvariants(
  state: DockLayoutState,
  panels: readonly DockPanelDefinition[],
): void {
  const allowed = new Set(panels.map((panel) => panel.id));
  const ids = [
    ...collectDockedPanelIds(state.root),
    ...state.floating.map((entry) => entry.panelId),
  ];
  const seen = new Set<string>();
  for (const panelId of ids) {
    if (!allowed.has(panelId)) throw new Error(`Unknown panel ${panelId}`);
    if (seen.has(panelId)) throw new Error(`Duplicate panel ${panelId}`);
    seen.add(panelId);
  }
  validateNode(state.root);
  for (const panelId of allowed) {
    if (!seen.has(panelId)) throw new Error(`Missing panel ${panelId}`);
  }
}

function insertAtTabsNode(
  node: DockNode,
  targetId: string,
  panelId: PanelId,
  position: DockDropTarget["position"],
  newTabs: DockTabsNode,
  nextId: (prefix: "tabs" | "split") => string,
  insertedRatio?: number,
): DockNode {
  if (node.type === "tabs") {
    if (node.id !== targetId) return node;
    if (position === "center") {
      return {
        ...node,
        panelIds: [...node.panelIds, panelId],
        activePanelId: panelId,
      };
    }
    return wrapNodeForDrop(node, newTabs, position, nextId, insertedRatio);
  }
  return {
    ...node,
    first: insertAtTabsNode(
      node.first,
      targetId,
      panelId,
      position,
      newTabs,
      nextId,
      insertedRatio,
    ),
    second: insertAtTabsNode(
      node.second,
      targetId,
      panelId,
      position,
      newTabs,
      nextId,
      insertedRatio,
    ),
  };
}

function wrapNodeForDrop(
  target: DockNode,
  inserted: DockNode,
  position: DockDropTarget["position"],
  nextId: (prefix: "tabs" | "split") => string,
  insertedRatio?: number,
): DockNode {
  if (position === "center") {
    if (target.type !== "tabs") {
      return createSplitNode(nextId("split"), "horizontal", 0.5, target, inserted);
    }
    const insertedPanel = requireFirstPanel(inserted.type === "tabs" ? inserted.panelIds : []);
    return {
      ...target,
      panelIds: [...target.panelIds, insertedPanel],
      activePanelId: insertedPanel,
    };
  }
  const horizontal = position === "left" || position === "right";
  const insertedFirst = position === "left" || position === "top";
  const requestedInsertedRatio = normalizeInsertedRatio(insertedRatio);
  return createSplitNode(
    nextId("split"),
    horizontal ? "horizontal" : "vertical",
    insertedFirst ? requestedInsertedRatio : 1 - requestedInsertedRatio,
    insertedFirst ? inserted : target,
    insertedFirst ? target : inserted,
  );
}

function normalizeInsertedRatio(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clampSplitRatio(value)
    : 0.3;
}

function removePanelFromNode(
  node: DockNode | null,
  panelId: PanelId,
): DockNode | null {
  if (node === null) return null;
  if (node.type === "tabs") {
    if (!node.panelIds.includes(panelId)) return node;
    const panelIds = node.panelIds.filter((candidate) => candidate !== panelId);
    if (panelIds.length === 0) return null;
    return {
      ...node,
      panelIds,
      activePanelId: node.activePanelId === panelId
        ? requireFirstPanel(panelIds)
        : node.activePanelId,
    };
  }
  const first = removePanelFromNode(node.first, panelId);
  const second = removePanelFromNode(node.second, panelId);
  if (first === null) return second;
  if (second === null) return first;
  return { ...node, first, second };
}

function mapDockNode(
  node: DockNode | null,
  mapper: (node: DockNode) => DockNode,
): DockNode | null {
  if (node === null) return null;
  const mapped = node.type === "split"
    ? {
      ...node,
      first: mapDockNode(node.first, mapper) as DockNode,
      second: mapDockNode(node.second, mapper) as DockNode,
    }
    : node;
  return mapper(mapped);
}

function normalizeNode(
  value: unknown,
  allowed: ReadonlySet<PanelId>,
  seen: Set<PanelId>,
  nodeIds: Set<string>,
): DockNode | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  if (value.type !== "tabs" && value.type !== "split") return null;
  if (nodeIds.has(value.id)) return null;
  nodeIds.add(value.id);
  if (value.type === "tabs") {
    if (!Array.isArray(value.panelIds)) return null;
    const panelIds = value.panelIds.filter((panelId): panelId is string => {
      if (typeof panelId !== "string" || !allowed.has(panelId) || seen.has(panelId)) {
        return false;
      }
      seen.add(panelId);
      return true;
    });
    if (panelIds.length === 0) return null;
    const activePanelId = typeof value.activePanelId === "string"
      && panelIds.includes(value.activePanelId)
      ? value.activePanelId
      : requireFirstPanel(panelIds);
    return createTabsNode(value.id, panelIds, activePanelId);
  }
  const first = normalizeNode(value.first, allowed, seen, nodeIds);
  const second = normalizeNode(value.second, allowed, seen, nodeIds);
  if (first === null) return second;
  if (second === null) return first;
  return createSplitNode(
    value.id,
    value.axis === "vertical" ? "vertical" : "horizontal",
    typeof value.ratio === "number" ? value.ratio : 0.5,
    first,
    second,
  );
}

function normalizeFloating(
  value: unknown,
  allowed: ReadonlySet<PanelId>,
  seen: Set<PanelId>,
): FloatingDockPanel[] {
  if (!Array.isArray(value)) return [];
  const result: FloatingDockPanel[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.panelId !== "string") continue;
    if (!allowed.has(entry.panelId) || seen.has(entry.panelId)) continue;
    const bounds = parseBounds(entry.bounds);
    if (bounds === null) continue;
    seen.add(entry.panelId);
    result.push({ panelId: entry.panelId, bounds });
  }
  return result;
}

function appendPanelsToFirstTabsNode(
  node: DockNode,
  panelIds: readonly PanelId[],
): DockNode {
  if (panelIds.length === 0) return node;
  if (node.type === "tabs") {
    return { ...node, panelIds: [...node.panelIds, ...panelIds] };
  }
  return {
    ...node,
    first: appendPanelsToFirstTabsNode(node.first, panelIds),
  };
}

function getNextNodeSequence(root: DockNode | null): number {
  let highestSequence = 0;
  const visit = (node: DockNode | null): void => {
    if (node === null) return;
    const match = /^(?:node|tabs|split)-(\d+)$/.exec(node.id);
    if (match !== null) {
      const sequence = Number(match[1]);
      if (Number.isSafeInteger(sequence)) {
        highestSequence = Math.max(highestSequence, sequence);
      }
    }
    if (node.type === "split") {
      visit(node.first);
      visit(node.second);
    }
  };
  visit(root);
  return highestSequence + 1;
}

function parseBounds(value: unknown): Rectangle | null {
  if (!isRecord(value)) return null;
  const coordinates = [value.x, value.y, value.width, value.height];
  if (!coordinates.every((coordinate) => (
    typeof coordinate === "number" && Number.isFinite(coordinate)
  ))) {
    return null;
  }
  return sanitizeBounds({
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number,
  });
}

function validateNode(node: DockNode | null): void {
  validateNodeIds(node, new Set<string>());
}

function validateNodeIds(node: DockNode | null, seen: Set<string>): void {
  if (node === null) return;
  if (seen.has(node.id)) throw new Error(`Duplicate node ID ${node.id}`);
  seen.add(node.id);
  if (node.type === "tabs") {
    if (node.panelIds.length === 0) throw new Error(`Empty tabs node ${node.id}`);
    if (!node.panelIds.includes(node.activePanelId)) {
      throw new Error(`Invalid active panel in ${node.id}`);
    }
    return;
  }
  if (node.ratio < MINIMUM_SPLIT_RATIO || node.ratio > MAXIMUM_SPLIT_RATIO) {
    throw new Error(`Invalid ratio in ${node.id}`);
  }
  validateNodeIds(node.first, seen);
  validateNodeIds(node.second, seen);
}

function sanitizeBounds(bounds: Rectangle): Rectangle {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(160, Math.round(bounds.width)),
    height: Math.max(120, Math.round(bounds.height)),
  };
}

function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAXIMUM_SPLIT_RATIO, Math.max(MINIMUM_SPLIT_RATIO, ratio));
}

function requireFirstPanel(panelIds: readonly PanelId[]): PanelId {
  const first = panelIds[0];
  if (first === undefined) throw new Error("A tabs node requires at least one panel");
  return first;
}

function requireFiniteInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
