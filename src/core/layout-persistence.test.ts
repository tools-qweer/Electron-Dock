import { describe, expect, it } from "vitest";
import {
  DOCK_LAYOUT_PERSISTENCE_SCHEMA,
  DOCK_LAYOUT_PERSISTENCE_VERSION,
  parseDockLayoutPersistence,
  persistDockLayout,
  restorePersistedDockLayout,
  serializeDockLayoutPersistence,
  type AtomicLayoutTextStorage,
} from "./layout-persistence.js";
import {
  collectDockedPanelIds,
  createDockLayout,
  createTabsNode,
  floatPanel,
  findTabsNode,
  reorderTab,
} from "./layout.js";
import type { DockLayoutState, DockPanelDefinition } from "./types.js";

const panels: readonly DockPanelDefinition[] = [
  { id: "hierarchy", title: "Hierarchy" },
  { id: "story", title: "Story" },
  { id: "map", title: "Map" },
];

function createFallback(): DockLayoutState {
  return createDockLayout(
    createTabsNode("tabs-fallback", ["hierarchy", "story", "map"]),
    1,
  );
}

class MemoryAtomicStorage implements AtomicLayoutTextStorage {
  committed: string | null;
  reads = 0;
  writes = 0;
  failRead = false;
  failNextWrite = false;

  constructor(initial: string | null = null) {
    this.committed = initial;
  }

  readText(): string | null {
    this.reads += 1;
    if (this.failRead) throw new Error("simulated read failure");
    return this.committed;
  }

  writeTextAtomically(value: string): void {
    this.writes += 1;
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("simulated atomic replace failure");
    }
    this.committed = value;
  }
}

describe("layout persistence", () => {
  it("keeps the exact v1 JSON byte representation", () => {
    expect(serializeDockLayoutPersistence(createFallback())).toBe(
      '{"schema":"electron-native-dock/layout","schemaVersion":1,"layout":{"version":1,"nextNodeSequence":1,"root":{"type":"tabs","id":"tabs-fallback","panelIds":["hierarchy","story","map"],"activePanelId":"hierarchy"},"floating":[]}}',
    );
  });

  it("writes one complete versioned document through the atomic storage API", async () => {
    const storage = new MemoryAtomicStorage();
    const layout = floatPanel(
      createFallback(),
      "hierarchy",
      { x: -600, y: 80, width: 320, height: 640 },
    );

    await persistDockLayout(storage, layout);

    expect(storage.writes).toBe(1);
    expect(storage.committed).toBe(serializeDockLayoutPersistence(layout));
    expect(JSON.parse(storage.committed!)).toEqual({
      schema: DOCK_LAYOUT_PERSISTENCE_SCHEMA,
      schemaVersion: DOCK_LAYOUT_PERSISTENCE_VERSION,
      layout,
    });
  });

  it("safely parses supported documents without retaining object references", () => {
    const source = {
      schema: DOCK_LAYOUT_PERSISTENCE_SCHEMA,
      schemaVersion: DOCK_LAYOUT_PERSISTENCE_VERSION,
      layout: createFallback(),
    };

    const parsed = parseDockLayoutPersistence(source);

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(parsed?.layout).not.toBe(source.layout);
    expect(parsed?.layout.root).not.toBe(source.layout.root);

    const sourceRoot = source.layout.root;
    if (sourceRoot?.type !== "tabs") {
      throw new Error("Expected the test fixture to contain one tabs node");
    }
    (sourceRoot.panelIds as string[])[0] = "mutated-source";
    expect(parsed?.layout.root).toMatchObject({
      type: "tabs",
      panelIds: ["hierarchy", "story", "map"],
    });
  });

  it.each([
    ["malformed JSON", "{not-json"],
    ["non-JSON value", undefined],
    [
      "wrong schema",
      {
        schema: "another-library/layout",
        schemaVersion: DOCK_LAYOUT_PERSISTENCE_VERSION,
        layout: createFallback(),
      },
    ],
    [
      "unknown persistence version",
      {
        schema: DOCK_LAYOUT_PERSISTENCE_SCHEMA,
        schemaVersion: 2,
        layout: createFallback(),
      },
    ],
    [
      "unknown layout version",
      {
        schema: DOCK_LAYOUT_PERSISTENCE_SCHEMA,
        schemaVersion: DOCK_LAYOUT_PERSISTENCE_VERSION,
        layout: { ...createFallback(), version: 2 },
      },
    ],
    [
      "incomplete layout",
      {
        schema: DOCK_LAYOUT_PERSISTENCE_SCHEMA,
        schemaVersion: DOCK_LAYOUT_PERSISTENCE_VERSION,
        layout: { version: 1 },
      },
    ],
    [
      "malformed nested node",
      {
        schema: DOCK_LAYOUT_PERSISTENCE_SCHEMA,
        schemaVersion: DOCK_LAYOUT_PERSISTENCE_VERSION,
        layout: {
          ...createFallback(),
          root: {
            type: "split",
            id: "split-invalid",
            axis: "horizontal",
            ratio: 0.5,
            first: createFallback().root,
          },
        },
      },
    ],
    [
      "non-finite floating bounds",
      {
        schema: DOCK_LAYOUT_PERSISTENCE_SCHEMA,
        schemaVersion: DOCK_LAYOUT_PERSISTENCE_VERSION,
        layout: {
          ...createFallback(),
          root: null,
          floating: [{
            panelId: "hierarchy",
            bounds: { x: 0, y: 0, width: Number.NaN, height: 400 },
          }],
        },
      },
    ],
  ])("returns null for %s", (_label, value) => {
    expect(parseDockLayoutPersistence(value)).toBeNull();
  });

  it("does not replace the committed document when an atomic write fails", async () => {
    const previous = '{"already":"committed"}';
    const storage = new MemoryAtomicStorage(previous);
    storage.failNextWrite = true;

    await expect(persistDockLayout(storage, createFallback())).rejects.toThrow(
      "simulated atomic replace failure",
    );
    expect(storage.committed).toBe(previous);
    expect(storage.writes).toBe(1);
  });

  it("serializes before touching storage", async () => {
    const storage = new MemoryAtomicStorage("previous");
    const cyclic = createFallback() as DockLayoutState & {
      loop?: unknown;
    };
    cyclic.loop = cyclic;

    await expect(persistDockLayout(storage, cyclic)).rejects.toThrow();
    expect(storage.writes).toBe(0);
    expect(storage.committed).toBe("previous");
  });

  it("restores a valid envelope through restoreDockLayout normalization", async () => {
    const persisted = createDockLayout(
      createTabsNode("tabs-persisted", ["story"]),
      8,
    );
    const storage = new MemoryAtomicStorage(
      JSON.stringify({
        schema: DOCK_LAYOUT_PERSISTENCE_SCHEMA,
        schemaVersion: DOCK_LAYOUT_PERSISTENCE_VERSION,
        layout: persisted,
      }),
    );

    const restored = await restorePersistedDockLayout(
      storage,
      panels,
      createFallback(),
    );

    // Existing restoreDockLayout supplements panels added after the save.
    expect(collectDockedPanelIds(restored.root)).toEqual([
      "story",
      "hierarchy",
      "map",
    ]);
    expect(restored.nextNodeSequence).toBe(8);
    expect(storage.reads).toBe(1);
  });

  it("persists and restores tab order together with the active panel", async () => {
    const storage = new MemoryAtomicStorage();
    const reordered = reorderTab(
      createDockLayout(
        createTabsNode(
          "tabs-scenes",
          ["hierarchy", "story", "map"],
          "story",
        ),
      ),
      "tabs-scenes",
      "map",
      0,
    );

    await persistDockLayout(storage, reordered);
    const restored = await restorePersistedDockLayout(
      storage,
      panels,
      createFallback(),
    );

    expect(findTabsNode(restored.root, "tabs-scenes")).toMatchObject({
      panelIds: ["map", "hierarchy", "story"],
      activePanelId: "story",
    });
  });

  it.each([
    ["missing data", null],
    ["malformed JSON", "{not-json"],
    [
      "wrong schema",
      JSON.stringify({
        schema: "another-library/layout",
        schemaVersion: 1,
        layout: createFallback(),
      }),
    ],
    [
      "unsupported persistence version",
      JSON.stringify({
        schema: DOCK_LAYOUT_PERSISTENCE_SCHEMA,
        schemaVersion: 2,
        layout: createFallback(),
      }),
    ],
    [
      "unsupported layout version",
      JSON.stringify({
        schema: DOCK_LAYOUT_PERSISTENCE_SCHEMA,
        schemaVersion: DOCK_LAYOUT_PERSISTENCE_VERSION,
        layout: { ...createFallback(), version: 2 },
      }),
    ],
    [
      "missing layout",
      JSON.stringify({
        schema: DOCK_LAYOUT_PERSISTENCE_SCHEMA,
        schemaVersion: DOCK_LAYOUT_PERSISTENCE_VERSION,
      }),
    ],
  ])("returns the exact fallback for %s", async (_label, serialized) => {
    const fallback = createFallback();
    const storage = new MemoryAtomicStorage(serialized);

    const restored = await restorePersistedDockLayout(
      storage,
      panels,
      fallback,
    );

    expect(restored).toBe(fallback);
    expect(storage.reads).toBe(1);
  });

  it("returns the fallback when the storage read itself fails", async () => {
    const fallback = createFallback();
    const storage = new MemoryAtomicStorage();
    storage.failRead = true;

    await expect(
      restorePersistedDockLayout(storage, panels, fallback),
    ).resolves.toBe(fallback);
    expect(storage.reads).toBe(1);
  });

  it("accepts asynchronous storage adapters", async () => {
    let committed: string | null = null;
    const storage: AtomicLayoutTextStorage = {
      readText: async () => committed,
      writeTextAtomically: async (value) => {
        committed = value;
      },
    };
    const fallback = createFallback();

    await persistDockLayout(storage, fallback);
    await expect(
      restorePersistedDockLayout(storage, panels, createDockLayout(null)),
    ).resolves.toEqual(fallback);
  });
});
