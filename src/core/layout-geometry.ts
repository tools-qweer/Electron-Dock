import type {
  DockDropPosition,
  DockDropScope,
  DockDropTarget,
  DockDropZone,
  DockLayoutState,
  DockNode,
  DockPanelViewport,
  DockSplitNode,
  DockTabsNode,
  PanelId,
  Rectangle,
} from "./types.js";

const MINIMUM_SPLIT_RATIO = 0.1;
const MAXIMUM_SPLIT_RATIO = 0.9;

/** The minimum usable content size for a panel. */
export interface DockPanelMinimumSize {
  readonly width: number;
  readonly height: number;
}

/** Inputs which affect layout, but are deliberately independent of any UI toolkit. */
export interface DockLayoutGeometryOptions {
  readonly splitterThickness: number;
  readonly titleBarHeight?: number;
  readonly tabStripHeight: number;
  readonly tabStripPlacement?: "top" | "bottom";
  readonly showSingleTab?: boolean;
  readonly panelMinimumSizes: Readonly<Record<PanelId, DockPanelMinimumSize | undefined>>;
  /**
   * Frozen parent directions from the pre-drag tree. They preserve Qt corner
   * precedence when removing the source panel temporarily collapses a split.
   */
  readonly tabsParentOrientations?: Readonly<
    Record<string, DockSplitNode["axis"] | undefined>
  >;
}

export interface DockTitleBarGeometry {
  readonly tabsNodeId: string;
  readonly panelId: PanelId;
  readonly bounds: Rectangle;
}

export interface DockTabStripGeometry {
  readonly tabsNodeId: string;
  readonly panelIds: readonly PanelId[];
  readonly activePanelId: PanelId;
  readonly bounds: Rectangle;
}

export interface DockSplitterGeometry {
  readonly splitNodeId: string;
  readonly axis: DockSplitNode["axis"];
  readonly bounds: Rectangle;
  readonly containerBounds: Rectangle;
}

/**
 * One structural gap shared by two adjacent layout branches.
 *
 * Both facing leaf-edge hit regions and the splitter between them point to the
 * same canonical target. This mirrors Qt's single gap path and prevents a
 * pointer crossing one visual seam from producing two different future trees.
 */
export interface DockBoundaryDropZone extends DockDropZone {
  readonly splitNodeId: string;
  readonly depth: number;
}

export interface DockLayoutGeometry {
  /** One viewport for every visible (active) tab only. */
  readonly viewports: readonly DockPanelViewport[];
  readonly titleBars: readonly DockTitleBarGeometry[];
  readonly tabStrips: readonly DockTabStripGeometry[];
  readonly splitters: readonly DockSplitterGeometry[];
  /**
   * Invisible hit regions used by the native drag controller. Every tabs
   * surface contributes nine non-overlapping Qt-style segments representing
   * five final targets; the workspace contributes only its four outer-edge
   * regions (or five recovery regions when empty).
   */
  readonly dropZones: readonly DockDropZone[];
  /**
   * Canonical aliases for internal structural boundaries. They are kept
   * separate from ordinary leaf zones so they can take precedence without
   * changing the public meaning of a tabs-local drop zone.
   */
  readonly boundaryDropZones: readonly DockBoundaryDropZone[];
}

export interface DockDropResolution {
  readonly target: DockDropTarget;
  readonly previewBounds: Rectangle;
  /**
   * Preferred share of the target surface occupied by the inserted panel.
   * Undefined for center/tab merges and for legacy callers using default sizing.
   */
  readonly insertedRatio?: number | undefined;
}

/**
 * Converts a floating panel's preferred docked surface size into a split ratio.
 *
 * The returned share belongs to the inserted panel for every edge direction.
 * The normal layout solver remains responsible for enforcing both subtrees'
 * minimum sizes, so this helper contains no application-specific policy.
 */
export function computeDockInsertionRatio(
  target: DockDropTarget,
  targetBounds: Rectangle,
  preferredSurfaceSize: Readonly<{ width: number; height: number }>,
  splitterThickness: number,
): number | undefined {
  if (target.position === "center") return undefined;
  const horizontal = target.position === "left" || target.position === "right";
  const targetExtent = horizontal ? targetBounds.width : targetBounds.height;
  const preferredExtent = horizontal
    ? preferredSurfaceSize.width
    : preferredSurfaceSize.height;
  const available = Math.max(
    0,
    positiveOrZero(targetExtent) - positiveOrZero(splitterThickness),
  );
  if (available === 0 || !Number.isFinite(preferredExtent)) return 0.3;
  return clampRatio(Math.max(0, preferredExtent) / available);
}

/**
 * Solves the complete dock tree into renderer-ready rectangles.  This function
 * does not mutate the state or require Electron, DOM, or React APIs.
 */
export function solveDockLayoutGeometry(
  state: DockLayoutState,
  container: Rectangle,
  options: DockLayoutGeometryOptions,
): DockLayoutGeometry {
  const normalizedOptions = normalizeOptions(options);
  const normalizedContainer = normalizeRectangle(container);
  const geometry: MutableGeometry = {
    viewports: [],
    titleBars: [],
    tabStrips: [],
    splitters: [],
    dropZones: [],
    boundaryDropZones: [],
    tabsBounds: [],
  };
  if (state.root !== null) {
    solveNode(
      state.root,
      normalizedContainer,
      normalizedOptions,
      geometry,
      "horizontal",
    );
  }
  geometry.dropZones.push(
    ...createWorkspaceDropZones(
      normalizedContainer,
      geometry.tabsBounds.length === 0,
    ),
  );
  for (const tabs of geometry.tabsBounds) {
    geometry.dropZones.push(...createTabsDropZones(tabs));
  }
  geometry.boundaryDropZones.push(
    ...createBoundaryDropZones(
      state.root,
      geometry.tabsBounds,
      geometry.splitters,
      geometry.dropZones,
    ),
  );
  return {
    viewports: geometry.viewports,
    titleBars: geometry.titleBars,
    tabStrips: geometry.tabStrips,
    splitters: geometry.splitters,
    dropZones: geometry.dropZones,
    boundaryDropZones: geometry.boundaryDropZones,
  };
}

interface NormalizedOptions {
  readonly splitterThickness: number;
  readonly titleBarHeight: number;
  readonly tabStripHeight: number;
  readonly tabStripPlacement: "top" | "bottom";
  readonly showSingleTab: boolean;
  readonly panelMinimumSizes: Readonly<Record<PanelId, DockPanelMinimumSize | undefined>>;
  readonly tabsParentOrientations: Readonly<
    Record<string, DockSplitNode["axis"] | undefined>
  >;
}

interface MinimumSize {
  readonly width: number;
  readonly height: number;
}

interface MutableGeometry {
  readonly viewports: DockPanelViewport[];
  readonly titleBars: DockTitleBarGeometry[];
  readonly tabStrips: DockTabStripGeometry[];
  readonly splitters: DockSplitterGeometry[];
  readonly dropZones: DockDropZone[];
  readonly boundaryDropZones: DockBoundaryDropZone[];
  readonly tabsBounds: TabsBounds[];
}

interface TabsBounds {
  readonly tabsNodeId: string;
  readonly bounds: Rectangle;
  readonly orientation: DockSplitNode["axis"];
}

function solveNode(
  node: DockNode,
  bounds: Rectangle,
  options: NormalizedOptions,
  geometry: MutableGeometry,
  parentOrientation: DockSplitNode["axis"],
): void {
  if (node.type === "tabs") {
    solveTabsNode(node, bounds, options, geometry, parentOrientation);
    return;
  }

  const splitterThickness = Math.min(
    options.splitterThickness,
    node.axis === "horizontal" ? bounds.width : bounds.height,
  );
  const available = Math.max(
    0,
    (node.axis === "horizontal" ? bounds.width : bounds.height) - splitterThickness,
  );
  const firstLength = solveFirstLength(node, available, options);
  const secondLength = available - firstLength;

  if (node.axis === "horizontal") {
    solveNode(
      node.first,
      { ...bounds, width: firstLength },
      options,
      geometry,
      node.axis,
    );
    geometry.splitters.push({
      splitNodeId: node.id,
      axis: node.axis,
      bounds: { x: bounds.x + firstLength, y: bounds.y, width: splitterThickness, height: bounds.height },
      containerBounds: bounds,
    });
    solveNode(
      node.second,
      {
        x: bounds.x + firstLength + splitterThickness,
        y: bounds.y,
        width: secondLength,
        height: bounds.height,
      },
      options,
      geometry,
      node.axis,
    );
    return;
  }

  solveNode(
    node.first,
    { ...bounds, height: firstLength },
    options,
    geometry,
    node.axis,
  );
  geometry.splitters.push({
    splitNodeId: node.id,
    axis: node.axis,
    bounds: { x: bounds.x, y: bounds.y + firstLength, width: bounds.width, height: splitterThickness },
    containerBounds: bounds,
  });
  solveNode(
    node.second,
    {
      x: bounds.x,
      y: bounds.y + firstLength + splitterThickness,
      width: bounds.width,
      height: secondLength,
    },
    options,
    geometry,
    node.axis,
  );
}

function solveTabsNode(
  node: DockTabsNode,
  bounds: Rectangle,
  options: NormalizedOptions,
  geometry: MutableGeometry,
  orientation: DockSplitNode["axis"],
): void {
  geometry.tabsBounds.push({
    tabsNodeId: node.id,
    bounds,
    orientation: options.tabsParentOrientations[node.id] ?? orientation,
  });
  const titleBarHeight = Math.min(options.titleBarHeight, bounds.height);
  const remainingAfterTitle = Math.max(0, bounds.height - titleBarHeight);
  const tabStripHeight = options.showSingleTab || node.panelIds.length > 1
    ? Math.min(options.tabStripHeight, remainingAfterTitle)
    : 0;
  if (titleBarHeight > 0) {
    geometry.titleBars.push({
      tabsNodeId: node.id,
      panelId: node.activePanelId,
      bounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: titleBarHeight,
      },
    });
  }
  const tabStrip: Rectangle = {
    x: bounds.x,
    y: options.tabStripPlacement === "top"
      ? bounds.y + titleBarHeight
      : bounds.y + Math.max(0, bounds.height - tabStripHeight),
    width: bounds.width,
    height: tabStripHeight,
  };
  if (tabStripHeight > 0) {
    geometry.tabStrips.push({
      tabsNodeId: node.id,
      panelIds: [...node.panelIds],
      activePanelId: node.activePanelId,
      bounds: tabStrip,
    });
  }
  geometry.viewports.push({
    panelId: node.activePanelId,
    bounds: {
      x: bounds.x,
      y: options.tabStripPlacement === "top"
        ? bounds.y + titleBarHeight + tabStripHeight
        : bounds.y + titleBarHeight,
      width: bounds.width,
      height: Math.max(
        0,
        bounds.height - titleBarHeight - tabStripHeight,
      ),
    },
  });
}

function solveFirstLength(
  node: DockSplitNode,
  available: number,
  options: NormalizedOptions,
): number {
  const ratio = clampRatio(node.ratio);
  const requested = available * ratio;
  const firstMinimum = nodeMinimumSize(node.first, options);
  const secondMinimum = nodeMinimumSize(node.second, options);
  const minimumFirst = node.axis === "horizontal" ? firstMinimum.width : firstMinimum.height;
  const minimumSecond = node.axis === "horizontal" ? secondMinimum.width : secondMinimum.height;
  const lowerBound = Math.min(available, minimumFirst);
  const upperBound = Math.max(0, available - minimumSecond);

  // When both subtree minima fit, honour both. When they do not, preserve the
  // clamped ratio while still ensuring neither child receives a negative size.
  return lowerBound <= upperBound
    ? clamp(requested, lowerBound, upperBound)
    : clamp(requested, 0, available);
}

function nodeMinimumSize(node: DockNode, options: NormalizedOptions): MinimumSize {
  if (node.type === "tabs") {
    let minimumWidth = 0;
    let minimumHeight = 0;
    for (const panelId of node.panelIds) {
      const panelMinimum = options.panelMinimumSizes[panelId];
      minimumWidth = Math.max(minimumWidth, positiveOrZero(panelMinimum?.width));
      minimumHeight = Math.max(minimumHeight, positiveOrZero(panelMinimum?.height));
    }
    return {
      width: minimumWidth,
      height: minimumHeight
        + options.titleBarHeight
        + (
          options.showSingleTab || node.panelIds.length > 1
            ? options.tabStripHeight
            : 0
        ),
    };
  }
  const first = nodeMinimumSize(node.first, options);
  const second = nodeMinimumSize(node.second, options);
  if (node.axis === "horizontal") {
    return {
      width: first.width + options.splitterThickness + second.width,
      height: Math.max(first.height, second.height),
    };
  }
  return {
    width: Math.max(first.width, second.width),
    height: first.height + options.splitterThickness + second.height,
  };
}

function createWorkspaceDropZones(
  bounds: Rectangle,
  empty: boolean,
): DockDropZone[] {
  const sideWidth = empty
    ? bounds.width * 0.25
    : adaptiveBand(bounds.width, 0.06, 24, 64);
  const sideHeight = empty
    ? bounds.height * 0.25
    : adaptiveBand(bounds.height, 0.06, 24, 64);
  const centerWidth = Math.max(0, bounds.width - sideWidth * 2);
  const centerHeight = Math.max(0, bounds.height - sideHeight * 2);
  const centerX = bounds.x + sideWidth;
  const centerY = bounds.y + sideHeight;
  const horizontalPreviewWidth = bounds.width * 0.3;
  const verticalPreviewHeight = bounds.height * 0.3;
  const fullPreview = empty ? bounds : null;
  const zones = [
    dropZone(
      "workspace",
      null,
      "left",
      { x: bounds.x, y: bounds.y, width: sideWidth, height: bounds.height },
      fullPreview ?? { ...bounds, width: horizontalPreviewWidth },
    ),
    dropZone(
      "workspace",
      null,
      "right",
      {
        x: centerX + centerWidth,
        y: bounds.y,
        width: sideWidth,
        height: bounds.height,
      },
      fullPreview ?? {
        ...bounds,
        x: bounds.x + bounds.width - horizontalPreviewWidth,
        width: horizontalPreviewWidth,
      },
    ),
    dropZone(
      "workspace",
      null,
      "top",
      { x: centerX, y: bounds.y, width: centerWidth, height: sideHeight },
      fullPreview ?? { ...bounds, height: verticalPreviewHeight },
    ),
    dropZone(
      "workspace",
      null,
      "bottom",
      {
        x: centerX,
        y: centerY + centerHeight,
        width: centerWidth,
        height: sideHeight,
      },
      fullPreview ?? {
        ...bounds,
        y: bounds.y + bounds.height - verticalPreviewHeight,
        height: verticalPreviewHeight,
      },
    ),
  ];
  if (empty) {
    zones.push(
      dropZone(
        "workspace",
        null,
        "center",
        {
          x: centerX,
          y: centerY,
          width: centerWidth,
          height: centerHeight,
        },
        bounds,
      ),
    );
  }
  return zones;
}

function createTabsDropZones(tabs: TabsBounds): DockDropZone[] {
  const bounds = tabs.bounds;
  const sixthWidth = bounds.width / 6;
  const sixthHeight = bounds.height / 6;
  const thirdWidth = bounds.width / 3;
  const thirdHeight = bounds.height / 3;
  const centerBounds = {
    x: bounds.x + sixthWidth,
    y: bounds.y + sixthHeight,
    width: thirdWidth * 2,
    height: thirdHeight * 2,
  };
  const horizontalPreviewWidth = bounds.width * 0.3;
  const verticalPreviewHeight = bounds.height * 0.3;
  const previews: Record<DockDropPosition, Rectangle> = {
    left: { ...bounds, width: horizontalPreviewWidth },
    right: {
      ...bounds,
      x: bounds.x + bounds.width - horizontalPreviewWidth,
      width: horizontalPreviewWidth,
    },
    top: { ...bounds, height: verticalPreviewHeight },
    bottom: {
      ...bounds,
      y: bounds.y + bounds.height - verticalPreviewHeight,
      height: verticalPreviewHeight,
    },
    center: bounds,
  };
  const segments: Array<{
    readonly position: DockDropPosition;
    readonly bounds: Rectangle;
    readonly segment?: string;
  }> = tabs.orientation === "horizontal"
    ? [
      {
        position: "left",
        bounds: { ...bounds, width: sixthWidth },
      },
      {
        position: "left",
        segment: "upper",
        bounds: {
          x: bounds.x + sixthWidth,
          y: bounds.y,
          width: sixthWidth,
          height: sixthHeight,
        },
      },
      {
        position: "left",
        segment: "lower",
        bounds: {
          x: bounds.x + sixthWidth,
          y: bounds.y + bounds.height - sixthHeight,
          width: sixthWidth,
          height: sixthHeight,
        },
      },
      {
        position: "right",
        bounds: {
          ...bounds,
          x: bounds.x + bounds.width - sixthWidth,
          width: sixthWidth,
        },
      },
      {
        position: "right",
        segment: "upper",
        bounds: {
          x: bounds.x + bounds.width - thirdWidth,
          y: bounds.y,
          width: sixthWidth,
          height: sixthHeight,
        },
      },
      {
        position: "right",
        segment: "lower",
        bounds: {
          x: bounds.x + bounds.width - thirdWidth,
          y: bounds.y + bounds.height - sixthHeight,
          width: sixthWidth,
          height: sixthHeight,
        },
      },
      {
        position: "top",
        bounds: {
          x: bounds.x + thirdWidth,
          y: bounds.y,
          width: thirdWidth,
          height: sixthHeight,
        },
      },
      {
        position: "bottom",
        bounds: {
          x: bounds.x + thirdWidth,
          y: bounds.y + bounds.height - sixthHeight,
          width: thirdWidth,
          height: sixthHeight,
        },
      },
      {
        position: "center",
        bounds: centerBounds,
      },
    ]
    : [
      {
        position: "top",
        bounds: { ...bounds, height: sixthHeight },
      },
      {
        position: "top",
        segment: "left",
        bounds: {
          x: bounds.x,
          y: bounds.y + sixthHeight,
          width: sixthWidth,
          height: sixthHeight,
        },
      },
      {
        position: "top",
        segment: "right",
        bounds: {
          x: bounds.x + bounds.width - sixthWidth,
          y: bounds.y + sixthHeight,
          width: sixthWidth,
          height: sixthHeight,
        },
      },
      {
        position: "bottom",
        bounds: {
          ...bounds,
          y: bounds.y + bounds.height - sixthHeight,
          height: sixthHeight,
        },
      },
      {
        position: "bottom",
        segment: "left",
        bounds: {
          x: bounds.x,
          y: bounds.y + bounds.height - thirdHeight,
          width: sixthWidth,
          height: sixthHeight,
        },
      },
      {
        position: "bottom",
        segment: "right",
        bounds: {
          x: bounds.x + bounds.width - sixthWidth,
          y: bounds.y + bounds.height - thirdHeight,
          width: sixthWidth,
          height: sixthHeight,
        },
      },
      {
        position: "left",
        bounds: {
          x: bounds.x,
          y: bounds.y + thirdHeight,
          width: sixthWidth,
          height: thirdHeight,
        },
      },
      {
        position: "right",
        bounds: {
          x: bounds.x + bounds.width - sixthWidth,
          y: bounds.y + thirdHeight,
          width: sixthWidth,
          height: thirdHeight,
        },
      },
      {
        position: "center",
        bounds: centerBounds,
      },
    ];
  return segments.map((segment) => (
    dropZone(
      "tabs",
      tabs.tabsNodeId,
      segment.position,
      segment.bounds,
      previews[segment.position],
      segment.segment,
    )
  ));
}

function createBoundaryDropZones(
  root: DockNode | null,
  tabsBounds: readonly TabsBounds[],
  splitters: readonly DockSplitterGeometry[],
  dropZones: readonly DockDropZone[],
): DockBoundaryDropZone[] {
  if (root === null) return [];
  const tabsById = new Map(
    tabsBounds.map((tabs) => [tabs.tabsNodeId, tabs]),
  );
  const splitterById = new Map(
    splitters.map((splitter) => [splitter.splitNodeId, splitter]),
  );
  const zones: DockBoundaryDropZone[] = [];

  const visit = (node: DockNode, depth: number): void => {
    if (node.type === "tabs") return;
    const splitter = splitterById.get(node.id);
    if (splitter !== undefined) {
      const firstTabs = collectTabsNodeIds(node.first)
        .map((tabsNodeId) => tabsById.get(tabsNodeId))
        .filter((tabs): tabs is TabsBounds => tabs !== undefined);
      const secondTabs = collectTabsNodeIds(node.second)
        .map((tabsNodeId) => tabsById.get(tabsNodeId))
        .filter((tabs): tabs is TabsBounds => tabs !== undefined);
      for (const first of firstTabs) {
        for (const second of secondTabs) {
          const contact = boundaryContact(first, second, splitter);
          if (contact === null) continue;
          const canonicalPosition = node.axis === "horizontal"
            ? "right"
            : "bottom";
          const canonicalPreview = dropZones.find((zone) => (
            zone.scope === "tabs"
            && zone.tabsNodeId === first.tabsNodeId
            && zone.position === canonicalPosition
          ))?.previewBounds;
          if (canonicalPreview === undefined) continue;
          const firstPosition = canonicalPosition;
          const secondPosition = node.axis === "horizontal"
            ? "left"
            : "top";
          const facingZones = dropZones.filter((zone) => (
            zone.scope === "tabs"
            && (
              (
                zone.tabsNodeId === first.tabsNodeId
                && zone.position === firstPosition
              )
              || (
                zone.tabsNodeId === second.tabsNodeId
                && zone.position === secondPosition
              )
            )
          ));
          let segmentSequence = 0;
          for (const facingZone of facingZones) {
            const clipped = intersectRectangles(facingZone.bounds, contact.corridor);
            if (clipped === null) continue;
            zones.push({
              id: `boundary:${node.id}:${first.tabsNodeId}:${second.tabsNodeId}:${segmentSequence++}`,
              scope: "tabs",
              tabsNodeId: first.tabsNodeId,
              position: canonicalPosition,
              bounds: clipped,
              previewBounds: canonicalPreview,
              splitNodeId: node.id,
              depth,
            });
          }
          const splitterSegment = intersectRectangles(
            splitter.bounds,
            contact.corridor,
          );
          if (splitterSegment !== null) {
            zones.push({
              id: `boundary:${node.id}:${first.tabsNodeId}:${second.tabsNodeId}:splitter`,
              scope: "tabs",
              tabsNodeId: first.tabsNodeId,
              position: canonicalPosition,
              bounds: splitterSegment,
              previewBounds: canonicalPreview,
              splitNodeId: node.id,
              depth,
            });
          }
        }
      }
    }
    visit(node.first, depth + 1);
    visit(node.second, depth + 1);
  };

  visit(root, 0);
  return zones;
}

function collectTabsNodeIds(node: DockNode): string[] {
  if (node.type === "tabs") return [node.id];
  return [
    ...collectTabsNodeIds(node.first),
    ...collectTabsNodeIds(node.second),
  ];
}

function boundaryContact(
  first: TabsBounds,
  second: TabsBounds,
  splitter: DockSplitterGeometry,
): { readonly corridor: Rectangle } | null {
  const epsilon = 0.001;
  if (splitter.axis === "horizontal") {
    const firstEdge = first.bounds.x + first.bounds.width;
    const secondEdge = second.bounds.x;
    const splitterEnd = splitter.bounds.x + splitter.bounds.width;
    if (
      Math.abs(firstEdge - splitter.bounds.x) > epsilon
      || Math.abs(secondEdge - splitterEnd) > epsilon
    ) {
      return null;
    }
    const start = Math.max(first.bounds.y, second.bounds.y);
    const end = Math.min(
      first.bounds.y + first.bounds.height,
      second.bounds.y + second.bounds.height,
    );
    if (end - start <= epsilon) return null;
    return {
      corridor: {
        x: first.bounds.x,
        y: start,
        width: second.bounds.x + second.bounds.width - first.bounds.x,
        height: end - start,
      },
    };
  }

  const firstEdge = first.bounds.y + first.bounds.height;
  const secondEdge = second.bounds.y;
  const splitterEnd = splitter.bounds.y + splitter.bounds.height;
  if (
    Math.abs(firstEdge - splitter.bounds.y) > epsilon
    || Math.abs(secondEdge - splitterEnd) > epsilon
  ) {
    return null;
  }
  const start = Math.max(first.bounds.x, second.bounds.x);
  const end = Math.min(
    first.bounds.x + first.bounds.width,
    second.bounds.x + second.bounds.width,
  );
  if (end - start <= epsilon) return null;
  return {
    corridor: {
      x: start,
      y: first.bounds.y,
      width: end - start,
      height: second.bounds.y + second.bounds.height - first.bounds.y,
    },
  };
}

function intersectRectangles(
  first: Rectangle,
  second: Rectangle,
): Rectangle | null {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const right = Math.min(
    first.x + first.width,
    second.x + second.width,
  );
  const bottom = Math.min(
    first.y + first.height,
    second.y + second.height,
  );
  if (right <= x || bottom <= y) return null;
  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

function dropZone(
  scope: DockDropScope,
  tabsNodeId: string | null,
  position: DockDropPosition,
  bounds: Rectangle,
  previewBounds: Rectangle,
  segment?: string,
): DockDropZone {
  const segmentSuffix = segment === undefined ? "" : `:${segment}`;
  return {
    id: scope === "workspace"
      ? `workspace:${position}`
      : `${tabsNodeId}:${position}${segmentSuffix}`,
    scope,
    tabsNodeId,
    position,
    bounds,
    previewBounds,
  };
}

/**
 * Resolves one deterministic target from invisible hit regions. A pointer
 * within the thin outer workspace band takes precedence over a local tabs
 * target. Internal split boundaries then take precedence over ordinary leaf
 * zones so both sides of one visual seam resolve to one structural gap.
 */
export function resolveDockDropAt(
  source: readonly DockDropZone[] | DockLayoutGeometry,
  point: { readonly x: number; readonly y: number },
  allowedPositions?: ReadonlySet<DockDropPosition>,
  retainedTarget?: DockDropTarget,
  hysteresis = 0,
): DockDropResolution | null {
  const geometry = isDockLayoutGeometry(source) ? source : null;
  const zones: readonly DockDropZone[] = geometry === null
    ? source as readonly DockDropZone[]
    : geometry.dropZones;
  const boundaryDropZones = geometry?.boundaryDropZones ?? [];
  const workspaceZone = zones.find((zone) => (
    zone.scope === "workspace"
    && pointIsInside(point, zone.bounds)
    && (
      allowedPositions === undefined
      || allowedPositions.has(zone.position)
    )
  ));
  if (workspaceZone !== undefined) return resolutionForZone(workspaceZone);

  // Boundary aliases are generated in Qt tree order: shallower common
  // ancestors first, then the first/left-or-top branch before the second.
  // Check permission only after selecting that canonical identity; a forbidden
  // canonical direction must not fall through to its mirrored leaf target.
  const boundaryZone = boundaryDropZones.find((zone) => (
    pointIsInside(point, zone.bounds)
  ));
  if (boundaryZone !== undefined) {
    if (
      allowedPositions !== undefined
      && !allowedPositions.has(boundaryZone.position)
    ) {
      return null;
    }
    return resolutionForZone(boundaryZone);
  }

  if (retainedTarget !== undefined && hysteresis > 0) {
    const retainedZone = [...boundaryDropZones, ...zones].find((zone) => (
      sameDropTarget(zone, retainedTarget)
      && (
        allowedPositions === undefined
        || allowedPositions.has(zone.position)
      )
      && pointIsInside(
        point,
        expandRectangle(zone.bounds, hysteresis),
      )
    ));
    if (retainedZone !== undefined) {
      return resolutionForZone(retainedZone);
    }
  }

  const matching = zones
    .filter((zone) => (
      zone.scope !== "workspace"
      &&
      pointIsInside(point, zone.bounds)
      && (
        allowedPositions === undefined
        || allowedPositions.has(zone.position)
      )
    ))
    .sort((first, second) => (
      dropScopePriority(first.scope) - dropScopePriority(second.scope)
      || rectangleArea(first.bounds) - rectangleArea(second.bounds)
      || first.id.localeCompare(second.id)
    ));
  const zone = matching[0];
  return zone === undefined
    ? null
    : resolutionForZone(zone);
}

function isDockLayoutGeometry(
  source: readonly DockDropZone[] | DockLayoutGeometry,
): source is DockLayoutGeometry {
  return !Array.isArray(source);
}

function resolutionForZone(zone: DockDropZone): DockDropResolution {
  return {
    target: {
      tabsNodeId: zone.tabsNodeId,
      position: zone.position,
    },
    previewBounds: zone.previewBounds,
  };
}

function sameDropTarget(
  zone: DockDropZone,
  target: DockDropTarget,
): boolean {
  return zone.tabsNodeId === target.tabsNodeId
    && zone.position === target.position;
}

function expandRectangle(
  bounds: Rectangle,
  amount: number,
): Rectangle {
  const margin = Math.max(0, amount);
  return {
    x: bounds.x - margin,
    y: bounds.y - margin,
    width: bounds.width + margin * 2,
    height: bounds.height + margin * 2,
  };
}

function dropScopePriority(scope: DockDropScope): number {
  return scope === "workspace" ? 0 : 1;
}

function pointIsInside(
  point: { readonly x: number; readonly y: number },
  bounds: Rectangle,
): boolean {
  return point.x >= bounds.x
    && point.y >= bounds.y
    && point.x < bounds.x + bounds.width
    && point.y < bounds.y + bounds.height;
}

function rectangleArea(bounds: Rectangle): number {
  return bounds.width * bounds.height;
}

function adaptiveBand(
  length: number,
  fraction: number,
  minimum: number,
  maximum: number,
): number {
  const half = Math.max(0, length / 2);
  return Math.min(
    half,
    Math.max(
      Math.min(minimum, half),
      Math.min(maximum, Math.max(0, length * fraction)),
    ),
  );
}

function normalizeOptions(options: DockLayoutGeometryOptions): NormalizedOptions {
  return {
    splitterThickness: positiveOrZero(options.splitterThickness),
    titleBarHeight: positiveOrZero(options.titleBarHeight),
    tabStripHeight: positiveOrZero(options.tabStripHeight),
    tabStripPlacement: options.tabStripPlacement === "bottom" ? "bottom" : "top",
    showSingleTab: options.showSingleTab !== false,
    panelMinimumSizes: options.panelMinimumSizes,
    tabsParentOrientations: options.tabsParentOrientations ?? {},
  };
}

function normalizeRectangle(bounds: Rectangle): Rectangle {
  return {
    x: finiteOrZero(bounds.x),
    y: finiteOrZero(bounds.y),
    width: positiveOrZero(bounds.width),
    height: positiveOrZero(bounds.height),
  };
}

function clampRatio(ratio: number): number {
  return Number.isFinite(ratio)
    ? clamp(ratio, MINIMUM_SPLIT_RATIO, MAXIMUM_SPLIT_RATIO)
    : 0.5;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function positiveOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
