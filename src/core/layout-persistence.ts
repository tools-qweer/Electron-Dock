import { restoreDockLayout } from "./layout.js";
import type { DockLayoutState, DockPanelDefinition } from "./types.js";

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

function readSupportedLayout(value: unknown): unknown | null {
  if (!isRecord(value)) return null;
  if (value.schema !== DOCK_LAYOUT_PERSISTENCE_SCHEMA) return null;
  if (value.schemaVersion !== DOCK_LAYOUT_PERSISTENCE_VERSION) return null;
  if (!isRecord(value.layout) || value.layout.version !== 1) return null;
  return value.layout;
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
  const serialized = JSON.stringify(createEnvelope(layout));
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    return fallback;
  }

  const persistedLayout = readSupportedLayout(parsed);
  if (persistedLayout === null) return fallback;
  return restoreDockLayout(persistedLayout, panels, fallback);
}
