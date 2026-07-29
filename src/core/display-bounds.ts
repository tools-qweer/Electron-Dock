import type { Rectangle } from "./types.js";

/**
 * Display geometry as reported by Electron's `screen` module.
 *
 * `workArea` and persisted window bounds must both be expressed in DIP. The
 * optional scale factor is deliberately metadata-only: converting either
 * rectangle with it would mix physical pixels with DIP and move a restored
 * window to the wrong monitor.
 */
export interface DipDisplayWorkArea {
  readonly id?: string | number;
  readonly workArea: Rectangle;
  readonly primary?: boolean;
  readonly scaleFactor?: number;
}

export interface WindowBoundsRecoveryOptions {
  /** Minimum accepted persisted window width, in DIP. */
  readonly minimumWidth?: number;
  /** Minimum accepted persisted window height, in DIP. */
  readonly minimumHeight?: number;
  /** Height of the draggable title area, in DIP. */
  readonly titleBarHeight?: number;
  /** Minimum horizontal title area that must remain reachable, in DIP. */
  readonly minimumVisibleTitleWidth?: number;
  /** Minimum vertical title area that must remain reachable, in DIP. */
  readonly minimumVisibleTitleHeight?: number;
}

const DEFAULT_OPTIONS = {
  minimumWidth: 160,
  minimumHeight: 120,
  titleBarHeight: 32,
  minimumVisibleTitleWidth: 96,
  minimumVisibleTitleHeight: 24,
} as const;

interface NormalizedOptions {
  readonly minimumWidth: number;
  readonly minimumHeight: number;
  readonly titleBarHeight: number;
  readonly minimumVisibleTitleWidth: number;
  readonly minimumVisibleTitleHeight: number;
}

interface DisplayCandidate {
  readonly display: DipDisplayWorkArea;
  readonly titleIntersectionArea: number;
  readonly windowIntersectionArea: number;
  readonly distanceSquared: number;
  readonly index: number;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  const candidate = Math.round(finiteOr(value, fallback));
  return candidate > 0 ? candidate : fallback;
}

function normalizeOptions(
  options: WindowBoundsRecoveryOptions | undefined,
): NormalizedOptions {
  return {
    minimumWidth: positiveIntegerOr(
      options?.minimumWidth,
      DEFAULT_OPTIONS.minimumWidth,
    ),
    minimumHeight: positiveIntegerOr(
      options?.minimumHeight,
      DEFAULT_OPTIONS.minimumHeight,
    ),
    titleBarHeight: positiveIntegerOr(
      options?.titleBarHeight,
      DEFAULT_OPTIONS.titleBarHeight,
    ),
    minimumVisibleTitleWidth: positiveIntegerOr(
      options?.minimumVisibleTitleWidth,
      DEFAULT_OPTIONS.minimumVisibleTitleWidth,
    ),
    minimumVisibleTitleHeight: positiveIntegerOr(
      options?.minimumVisibleTitleHeight,
      DEFAULT_OPTIONS.minimumVisibleTitleHeight,
    ),
  };
}

function normalizeRectangle(
  rectangle: Rectangle,
  minimumWidth: number,
  minimumHeight: number,
): Rectangle {
  return {
    x: Math.round(finiteOr(rectangle.x, 0)),
    y: Math.round(finiteOr(rectangle.y, 0)),
    width: Math.max(
      minimumWidth,
      Math.round(finiteOr(rectangle.width, minimumWidth)),
    ),
    height: Math.max(
      minimumHeight,
      Math.round(finiteOr(rectangle.height, minimumHeight)),
    ),
  };
}

function isUsableWorkArea(display: DipDisplayWorkArea): boolean {
  const { x, y, width, height } = display.workArea;
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  );
}

function normalizeWorkArea(display: DipDisplayWorkArea): DipDisplayWorkArea {
  return {
    ...display,
    workArea: {
      x: Math.round(display.workArea.x),
      y: Math.round(display.workArea.y),
      width: Math.max(1, Math.round(display.workArea.width)),
      height: Math.max(1, Math.round(display.workArea.height)),
    },
  };
}

function intersectionArea(first: Rectangle, second: Rectangle): number {
  const width = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width) -
      Math.max(first.x, second.x),
  );
  const height = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) -
      Math.max(first.y, second.y),
  );
  return width * height;
}

function titleRectangle(
  bounds: Rectangle,
  options: NormalizedOptions,
): Rectangle {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: Math.min(bounds.height, options.titleBarHeight),
  };
}

function titleVisibilityRequirements(
  bounds: Rectangle,
  workArea: Rectangle,
  options: NormalizedOptions,
): { readonly width: number; readonly height: number } {
  return {
    width: Math.min(
      bounds.width,
      workArea.width,
      options.minimumVisibleTitleWidth,
    ),
    height: Math.min(
      bounds.height,
      workArea.height,
      options.titleBarHeight,
      options.minimumVisibleTitleHeight,
    ),
  };
}

function titleIsAccessibleOnDisplay(
  bounds: Rectangle,
  workArea: Rectangle,
  options: NormalizedOptions,
): boolean {
  const title = titleRectangle(bounds, options);
  const intersectionWidth = Math.max(
    0,
    Math.min(title.x + title.width, workArea.x + workArea.width) -
      Math.max(title.x, workArea.x),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(title.y + title.height, workArea.y + workArea.height) -
      Math.max(title.y, workArea.y),
  );
  const required = titleVisibilityRequirements(bounds, workArea, options);
  return (
    intersectionWidth >= required.width &&
    intersectionHeight >= required.height
  );
}

function squaredDistanceFromPointToRectangle(
  x: number,
  y: number,
  rectangle: Rectangle,
): number {
  const right = rectangle.x + rectangle.width;
  const bottom = rectangle.y + rectangle.height;
  const dx =
    x < rectangle.x ? rectangle.x - x : x > right ? x - right : 0;
  const dy =
    y < rectangle.y ? rectangle.y - y : y > bottom ? y - bottom : 0;
  return dx * dx + dy * dy;
}

function compareCandidates(
  first: DisplayCandidate,
  second: DisplayCandidate,
): number {
  if (first.titleIntersectionArea !== second.titleIntersectionArea) {
    return second.titleIntersectionArea - first.titleIntersectionArea;
  }
  if (first.windowIntersectionArea !== second.windowIntersectionArea) {
    return second.windowIntersectionArea - first.windowIntersectionArea;
  }
  if (first.distanceSquared !== second.distanceSquared) {
    return first.distanceSquared - second.distanceSquared;
  }
  if (Boolean(first.display.primary) !== Boolean(second.display.primary)) {
    return first.display.primary ? -1 : 1;
  }
  return first.index - second.index;
}

function selectTargetDisplay(
  bounds: Rectangle,
  displays: readonly DipDisplayWorkArea[],
  options: NormalizedOptions,
): DisplayCandidate {
  const title = titleRectangle(bounds, options);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const candidates = displays.map(
    (display, index): DisplayCandidate => ({
      display,
      titleIntersectionArea: intersectionArea(title, display.workArea),
      windowIntersectionArea: intersectionArea(bounds, display.workArea),
      distanceSquared: squaredDistanceFromPointToRectangle(
        centerX,
        centerY,
        display.workArea,
      ),
      index,
    }),
  );
  candidates.sort(compareCandidates);
  return candidates[0]!;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampWholeWindowAxis(
  position: number,
  size: number,
  workAreaStart: number,
  workAreaSize: number,
): number {
  if (size > workAreaSize) return workAreaStart;
  return clamp(
    position,
    workAreaStart,
    workAreaStart + workAreaSize - size,
  );
}

function moveWholeWindowIntoWorkArea(
  bounds: Rectangle,
  workArea: Rectangle,
): Rectangle {
  return {
    ...bounds,
    x: clampWholeWindowAxis(
      bounds.x,
      bounds.width,
      workArea.x,
      workArea.width,
    ),
    y: clampWholeWindowAxis(
      bounds.y,
      bounds.height,
      workArea.y,
      workArea.height,
    ),
  };
}

function moveTitleIntoReach(
  bounds: Rectangle,
  workArea: Rectangle,
  options: NormalizedOptions,
): Rectangle {
  const required = titleVisibilityRequirements(bounds, workArea, options);
  const titleHeight = Math.min(bounds.height, options.titleBarHeight);
  const minimumX = workArea.x + required.width - bounds.width;
  const maximumX = workArea.x + workArea.width - required.width;
  const minimumY = workArea.y + required.height - titleHeight;
  const maximumY = workArea.y + workArea.height - required.height;
  return {
    ...bounds,
    x: clamp(bounds.x, minimumX, maximumX),
    y: clamp(bounds.y, minimumY, maximumY),
  };
}

/**
 * Returns whether the persisted window already has a reachable title area on
 * at least one current display. All arguments are interpreted as DIP.
 */
export function hasAccessibleTitleArea(
  bounds: Rectangle,
  displays: readonly DipDisplayWorkArea[],
  options?: WindowBoundsRecoveryOptions,
): boolean {
  const normalizedOptions = normalizeOptions(options);
  const normalizedBounds = normalizeRectangle(
    bounds,
    normalizedOptions.minimumWidth,
    normalizedOptions.minimumHeight,
  );
  return displays
    .filter(isUsableWorkArea)
    .map(normalizeWorkArea)
    .some((display) =>
      titleIsAccessibleOnDisplay(
        normalizedBounds,
        display.workArea,
        normalizedOptions,
      ),
    );
}

/**
 * Restores persisted floating-window bounds against the displays currently
 * connected to Windows.
 *
 * - Bounds and display work areas are DIP; scale factors are never applied.
 * - A still-reachable window is left exactly where it was.
 * - A partially visible window is moved only enough to expose a draggable
 *   portion of its title.
 * - A completely off-screen window (for example after unplugging a monitor)
 *   is moved wholly into the nearest work area when its size permits.
 * - If no usable display information is available, only invalid persisted
 *   size/coordinates are normalized.
 */
export function recoverWindowBounds(
  persistedBounds: Rectangle,
  displays: readonly DipDisplayWorkArea[],
  options?: WindowBoundsRecoveryOptions,
): Rectangle {
  const normalizedOptions = normalizeOptions(options);
  const bounds = normalizeRectangle(
    persistedBounds,
    normalizedOptions.minimumWidth,
    normalizedOptions.minimumHeight,
  );
  const usableDisplays = displays
    .filter(isUsableWorkArea)
    .map(normalizeWorkArea);

  if (usableDisplays.length === 0) return bounds;
  if (
    usableDisplays.some((display) =>
      titleIsAccessibleOnDisplay(
        bounds,
        display.workArea,
        normalizedOptions,
      ),
    )
  ) {
    return bounds;
  }

  const target = selectTargetDisplay(bounds, usableDisplays, normalizedOptions);
  if (target.windowIntersectionArea === 0) {
    return moveWholeWindowIntoWorkArea(bounds, target.display.workArea);
  }
  return moveTitleIntoReach(
    bounds,
    target.display.workArea,
    normalizedOptions,
  );
}
