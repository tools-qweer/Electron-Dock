import { restoreDockLayout } from "./layout.js";
import type {
  DockLayoutState,
  DockNode,
  DockPanelDefinition,
  Rectangle,
} from "./types.js";

export const DOCK_LAYOUT_PERSISTENCE_SCHEMA =
  "electron-native-dock/layout" as const;
export const DOCK_LAYOUT_PERSISTENCE_VERSION = 1 as const;

type MaybePromise<T> = T | Promise<T>;

/**
 * Storage adapter owned by the host application.
 *
 * Implementations backed by files must write to a sibling temporary file,
 * flush it, and rename/replace it in `writeTextAtomically`. The persistence
 * core deliberately owns no Node or Electron dependency, so it can also be
 * backed by IndexedDB, a test double, or another transactional store.
 */
export interface AtomicLayoutTextStorage {
  readonly readText: () => MaybePromise<string | null>;
  readonly writeTextAtomically: (value: string) => MaybePromise<void>;
}

export interface DockLayoutPersistenceEnvelopeV1 {
  readonly schema: typeof DOCK_LAYOUT_PERSISTENCE_SCHEMA;
  readonly schemaVersion: typeof DOCK_LAYOUT_PERSISTENCE_VERSION;
  readonly layout: DockLayoutState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createEnvelope(
  layout: DockLayoutState,
): DockLayoutPersistenceEnvelopeV1 {
  return {
    schema: DOCK_LAYOUT_PERSISTENCE_SCHEMA,
    schemaVersion: DOCK_LAYOUT_PERSISTENCE_VERSION,
    layout,
  };
}

function readSupportedLayout(value: unknown): DockLayoutState | null {
  if (!isRecord(value)) return null;
  if (value.schema !== DOCK_LAYOUT_PERSISTENCE_SCHEMA) return null;
  if (value.schemaVersion !== DOCK_LAYOUT_PERSISTENCE_VERSION) return null;
  return isDockLayoutState(value.layout) ? value.layout : null;
}

/**
 * Serializes the stable v1 persistence envelope used by Electron Dock.
 *
 * The property order intentionally matches every v1 document written before
 * this helper became public, so existing byte-for-byte snapshots remain valid.
 */
export function serializeDockLayoutPersistence(
  layout: DockLayoutState,
): string {
  return JSON.stringify(createEnvelope(layout));
}

/**
 * Parses a serialized persistence document or clones an already parsed value.
 *
 * Invalid JSON, non-JSON values, unknown schemas and unsupported versions
 * return `null` instead of throwing. The returned envelope is always detached
 * from object input, preventing callers from mutating the source document
 * through the parsed result.
 */
export function parseDockLayoutPersistence(
  value: unknown,
): DockLayoutPersistenceEnvelopeV1 | null {
  let parsed: unknown;
  try {
    parsed = typeof value === "string"
      ? JSON.parse(value) as unknown
      : JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return null;
  }

  const layout = readSupportedLayout(parsed);
  if (layout === null || !isRecord(parsed)) return null;
  return {
    schema: DOCK_LAYOUT_PERSISTENCE_SCHEMA,
    schemaVersion: DOCK_LAYOUT_PERSISTENCE_VERSION,
    layout,
  };
}

/**
 * Serializes a complete, versioned document before asking the storage adapter
 * to replace its committed value. A serialization error therefore cannot
 * trigger a partial or empty write.
 */
export async function persistDockLayout(
  storage: AtomicLayoutTextStorage,
  layout: DockLayoutState,
): Promise<void> {
  const serialized = serializeDockLayoutPersistence(layout);
  await storage.writeTextAtomically(serialized);
}

/**
 * Loads a versioned layout document and delegates layout normalization to the
 * existing `restoreDockLayout` state-machine boundary.
 *
 * Missing data, read failures, malformed JSON, unknown schemas and unsupported
 * versions all return `fallback`. The storage adapter is read at most once.
 */
export async function restorePersistedDockLayout(
  storage: AtomicLayoutTextStorage,
  panels: readonly DockPanelDefinition[],
  fallback: DockLayoutState,
): Promise<DockLayoutState> {
  let serialized: string | null;
  try {
    serialized = await storage.readText();
  } catch {
    return fallback;
  }
  if (serialized === null) return fallback;

  const parsed = parseDockLayoutPersistence(serialized);
  if (parsed === null) return fallback;
  return restoreDockLayout(parsed.layout, panels, fallback);
}

function isDockLayoutState(value: unknown): value is DockLayoutState {
  if (
    !isRecord(value)
    || value.version !== 1
    || !Number.isSafeInteger(value.nextNodeSequence)
    || (value.nextNodeSequence as number) < 1
    || !Array.isArray(value.floating)
  ) {
    return false;
  }
  const nodeIds = new Set<string>();
  const panelIds = new Set<string>();
  if (
    value.root !== null
    && !isDockNode(value.root, nodeIds, panelIds, 0)
  ) {
    return false;
  }
  return value.floating.every((entry) => (
    isRecord(entry)
    && typeof entry.panelId === "string"
    && !panelIds.has(entry.panelId)
    && isRectangle(entry.bounds)
    && addPanelId(panelIds, entry.panelId)
  ));
}

function isDockNode(
  value: unknown,
  nodeIds: Set<string>,
  panelIds: Set<string>,
  depth: number,
): value is DockNode {
  if (
    depth > 512
    || !isRecord(value)
    || typeof value.id !== "string"
    || nodeIds.has(value.id)
  ) {
    return false;
  }
  nodeIds.add(value.id);
  if (value.type === "tabs") {
    if (
      !Array.isArray(value.panelIds)
      || value.panelIds.length === 0
      || typeof value.activePanelId !== "string"
      || !value.panelIds.includes(value.activePanelId)
    ) {
      return false;
    }
    return value.panelIds.every((panelId) => (
      typeof panelId === "string"
      && !panelIds.has(panelId)
      && addPanelId(panelIds, panelId)
    ));
  }
  if (
    value.type !== "split"
    || (value.axis !== "horizontal" && value.axis !== "vertical")
    || typeof value.ratio !== "number"
    || !Number.isFinite(value.ratio)
  ) {
    return false;
  }
  return isDockNode(value.first, nodeIds, panelIds, depth + 1)
    && isDockNode(value.second, nodeIds, panelIds, depth + 1);
}

function isRectangle(value: unknown): value is Rectangle {
  return isRecord(value)
    && ["x", "y", "width", "height"].every((key) => (
      typeof value[key] === "number"
      && Number.isFinite(value[key])
    ));
}

function addPanelId(panelIds: Set<string>, panelId: string): true {
  panelIds.add(panelId);
  return true;
}
