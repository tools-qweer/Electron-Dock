import { describe, expect, it } from "vitest";
import {
  assertDockLayoutInvariants,
  collectDockedPanelIds,
  createDockLayout,
  createSplitNode,
  createTabsNode,
  dockPanel,
  findTabsNode,
  floatPanel,
  reorderTab,
  restoreDockLayout,
  setActivePanel,
  setSplitRatio,
} from "./layout.js";
import type { DockPanelDefinition } from "./types.js";

const panels: readonly DockPanelDefinition[] = [
  { id: "hierarchy", title: "Hierarchy" },
  { id: "story", title: "Story" },
  { id: "map", title: "Map" },
  { id: "inspector", title: "Inspector" },
];

function initialState() {
  return createDockLayout(
    createSplitNode(
      "split-1",
      "horizontal",
      0.22,
      createTabsNode("tabs-1", ["hierarchy"]),
      createSplitNode(
        "split-2",
        "horizontal",
        0.74,
        createTabsNode("tabs-2", ["story", "map"], "story"),
        createTabsNode("tabs-3", ["inspector"]),
      ),
    ),
    4,
  );
}

describe("dock layout", () => {
  it("floats and redocks without duplicating a panel", () => {
    const floated = floatPanel(
      initialState(),
      "hierarchy",
      { x: -700, y: 80, width: 320, height: 600 },
    );
    expect(collectDockedPanelIds(floated.root)).not.toContain("hierarchy");
    expect(floated.floating).toEqual([
      {
        panelId: "hierarchy",
        bounds: { x: -700, y: 80, width: 320, height: 600 },
      },
    ]);

    const redocked = dockPanel(floated, "hierarchy", {
      tabsNodeId: "tabs-2",
      position: "left",
    });
    expect(collectDockedPanelIds(redocked.root)).toContain("hierarchy");
    expect(redocked.floating).toHaveLength(0);
    expect(() => assertDockLayoutInvariants(redocked, panels)).not.toThrow();
  });

  it("tabifies a panel and makes it active", () => {
    const next = dockPanel(initialState(), "inspector", {
      tabsNodeId: "tabs-2",
      position: "center",
    });
    const active = setActivePanel(next, "tabs-2", "map");
    expect(active.root).not.toBeNull();
    expect(collectDockedPanelIds(active.root)).toEqual(
      expect.arrayContaining(["story", "map", "inspector"]),
    );
    expect(() => assertDockLayoutInvariants(active, panels)).not.toThrow();
  });

  it("reorders one tab inside its group without changing the active panel", () => {
    const state = initialState();
    const next = reorderTab(state, "tabs-2", "map", 0);

    expect(findTabsNode(state.root, "tabs-2")).toMatchObject({
      panelIds: ["story", "map"],
      activePanelId: "story",
    });
    expect(findTabsNode(next.root, "tabs-2")).toMatchObject({
      panelIds: ["map", "story"],
      activePanelId: "story",
    });
    expect(next.nextNodeSequence).toBe(state.nextNodeSequence);
    expect(next.floating).toBe(state.floating);
    expect(() => assertDockLayoutInvariants(next, panels)).not.toThrow();
  });

  it("clamps tab destinations and keeps invalid or unchanged moves referentially stable", () => {
    const state = initialState();

    expect(reorderTab(state, "tabs-2", "story", 99)).toMatchObject({
      root: expect.objectContaining({ type: "split" }),
    });
    expect(
      findTabsNode(
        reorderTab(state, "tabs-2", "story", 99).root,
        "tabs-2",
      )?.panelIds,
    ).toEqual(["map", "story"]);
    expect(reorderTab(state, "tabs-2", "story", 0)).toBe(state);
    expect(reorderTab(state, "missing", "story", 1)).toBe(state);
    expect(reorderTab(state, "tabs-2", "missing", 1)).toBe(state);
    expect(reorderTab(state, "tabs-2", "story", Number.NaN)).toBe(state);
  });

  it("wraps the complete workspace when a panel is dropped on a workspace edge", () => {
    const next = dockPanel(initialState(), "inspector", {
      tabsNodeId: null,
      position: "right",
    });

    expect(next.root).toMatchObject({
      type: "split",
      axis: "horizontal",
      ratio: 0.7,
    });
    if (next.root?.type !== "split") {
      throw new Error("Expected a root split");
    }
    expect(collectDockedPanelIds(next.root.first)).not.toContain("inspector");
    expect(collectDockedPanelIds(next.root.second)).toEqual(["inspector"]);
    expect(() => assertDockLayoutInvariants(next, panels)).not.toThrow();
  });

  it("preserves the inserted panel's requested share on every edge", () => {
    const state = createDockLayout(
      createTabsNode("target", ["story"]),
      2,
    );
    const cases = [
      { position: "left", expectedRatio: 0.25 },
      { position: "right", expectedRatio: 0.75 },
      { position: "top", expectedRatio: 0.25 },
      { position: "bottom", expectedRatio: 0.75 },
    ] as const;

    for (const entry of cases) {
      const next = dockPanel(
        state,
        "hierarchy",
        { tabsNodeId: "target", position: entry.position },
        { insertedRatio: 0.25 },
      );
      expect(next.root).toMatchObject({
        type: "split",
        ratio: entry.expectedRatio,
      });
    }
  });

  it("splits only the targeted tabs component for a local edge drop", () => {
    const next = dockPanel(initialState(), "inspector", {
      tabsNodeId: "tabs-2",
      position: "bottom",
    });

    expect(next.root).toMatchObject({
      type: "split",
      id: "split-1",
      second: {
        type: "split",
        id: "split-5",
        axis: "vertical",
        first: { type: "tabs", id: "tabs-2", panelIds: ["story", "map"] },
        second: { type: "tabs", id: "tabs-4", panelIds: ["inspector"] },
      },
    });
    expect(() => assertDockLayoutInvariants(next, panels)).not.toThrow();
  });

  it("clamps split ratios to preserve usable children", () => {
    const state = setSplitRatio(initialState(), "split-1", 0.99);
    expect(state.root?.type).toBe("split");
    if (state.root?.type === "split") expect(state.root.ratio).toBe(0.9);
  });

  it("normalizes stale and duplicate persisted panels", () => {
    const restored = restoreDockLayout(
      {
        version: 1,
        nextNodeSequence: 9,
        root: {
          type: "tabs",
          id: "tabs-restored",
          panelIds: ["story", "story", "removed"],
          activePanelId: "removed",
        },
        floating: [
          {
            panelId: "story",
            bounds: { x: 1, y: 2, width: 300, height: 200 },
          },
          {
            panelId: "map",
            bounds: { x: 3, y: 4, width: 20, height: 30 },
          },
        ],
      },
      panels,
      initialState(),
    );

    expect(collectDockedPanelIds(restored.root)).toEqual([
      "story",
      "hierarchy",
      "inspector",
    ]);
    expect(restored.floating).toEqual([
      {
        panelId: "map",
        bounds: { x: 3, y: 4, width: 160, height: 120 },
      },
    ]);
    expect(() => assertDockLayoutInvariants(restored, panels)).not.toThrow();
  });

  it("adds panels introduced after a layout was persisted", () => {
    const restored = restoreDockLayout(
      {
        version: 1,
        nextNodeSequence: 2,
        root: {
          type: "tabs",
          id: "tabs-7",
          panelIds: ["story"],
          activePanelId: "story",
        },
        floating: [],
      },
      panels,
      initialState(),
    );

    expect(collectDockedPanelIds(restored.root)).toEqual([
      "story",
      "hierarchy",
      "map",
      "inspector",
    ]);
    expect(restored.nextNodeSequence).toBe(8);
    expect(() => assertDockLayoutInvariants(restored, panels)).not.toThrow();
  });

  it("removes duplicate node IDs while restoring persisted layouts", () => {
    const restored = restoreDockLayout(
      {
        version: 1,
        nextNodeSequence: 3,
        root: {
          type: "split",
          id: "split-1",
          axis: "horizontal",
          ratio: 0.5,
          first: {
            type: "tabs",
            id: "tabs-shared",
            panelIds: ["story"],
            activePanelId: "story",
          },
          second: {
            type: "tabs",
            id: "tabs-shared",
            panelIds: ["map"],
            activePanelId: "map",
          },
        },
        floating: [],
      },
      panels,
      initialState(),
    );

    expect(restored.root).toMatchObject({ type: "tabs", id: "tabs-shared" });
    expect(() => assertDockLayoutInvariants(restored, panels)).not.toThrow();

    const duplicateIds = createDockLayout(
      createSplitNode(
        "split-1",
        "horizontal",
        0.5,
        createTabsNode("tabs-shared", ["story"]),
        createTabsNode("tabs-shared", ["map"]),
      ),
    );
    expect(() => assertDockLayoutInvariants(duplicateIds, panels)).toThrow(
      "Duplicate node ID tabs-shared",
    );
  });

  it("advances restored node sequences past existing generated IDs", () => {
    const restored = restoreDockLayout(
      {
        version: 1,
        nextNodeSequence: 2,
        root: {
          type: "tabs",
          id: "tabs-9",
          panelIds: ["story"],
          activePanelId: "story",
        },
        floating: [],
      },
      panels,
      initialState(),
    );
    const docked = dockPanel(restored, "map", {
      tabsNodeId: "tabs-9",
      position: "left",
    });

    expect(docked.root).toMatchObject({
      type: "split",
      id: "split-11",
      first: { type: "tabs", id: "tabs-10", panelIds: ["map"] },
    });
    expect(docked.nextNodeSequence).toBe(12);
    expect(() => assertDockLayoutInvariants(docked, panels)).not.toThrow();
  });

  it("rejects a registered panel that is absent from both docked and floating layout", () => {
    const incomplete = createDockLayout(createTabsNode("tabs-1", ["story"]));

    expect(() => assertDockLayoutInvariants(incomplete, panels)).toThrow(
      "Missing panel hierarchy",
    );
  });
});
