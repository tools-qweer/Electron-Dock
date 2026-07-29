import { describe, expect, it } from "vitest";
import {
  createDockLayout,
  createSplitNode,
  createTabsNode,
  dockPanel,
  setActivePanel,
} from "./layout.js";
import {
  computeDockInsertionRatio,
  resolveDockDropAt,
  solveDockLayoutGeometry,
} from "./layout-geometry.js";

const options = {
  splitterThickness: 8,
  tabStripHeight: 24,
  panelMinimumSizes: {
    hierarchy: { width: 180, height: 160 },
    story: { width: 320, height: 200 },
    map: { width: 260, height: 180 },
    inspector: { width: 200, height: 180 },
  },
} as const;

describe("solveDockLayoutGeometry", () => {
  it("turns a floating content size into a direction-independent inserted share", () => {
    const targetBounds = { x: 0, y: 0, width: 800, height: 600 };
    const preferred = { width: 300, height: 428 };

    expect(computeDockInsertionRatio(
      { tabsNodeId: "target", position: "left" },
      targetBounds,
      preferred,
      8,
    )).toBeCloseTo(300 / 792);
    expect(computeDockInsertionRatio(
      { tabsNodeId: "target", position: "right" },
      targetBounds,
      preferred,
      8,
    )).toBeCloseTo(300 / 792);
    expect(computeDockInsertionRatio(
      { tabsNodeId: "target", position: "top" },
      targetBounds,
      preferred,
      8,
    )).toBeCloseTo(428 / 592);
    expect(computeDockInsertionRatio(
      { tabsNodeId: "target", position: "center" },
      targetBounds,
      preferred,
      8,
    )).toBeUndefined();
  });

  it("solves the requested insertion size before enforcing subtree minimums", () => {
    const state = createDockLayout(
      createTabsNode("target", ["story"]),
      2,
    );
    const ratio = computeDockInsertionRatio(
      { tabsNodeId: "target", position: "left" },
      { x: 0, y: 0, width: 1_000, height: 500 },
      { width: 300, height: 300 },
      options.splitterThickness,
    );
    const next = dockPanel(
      state,
      "hierarchy",
      { tabsNodeId: "target", position: "left" },
      { insertedRatio: ratio },
    );
    const geometry = solveDockLayoutGeometry(
      next,
      { x: 0, y: 0, width: 1_000, height: 500 },
      options,
    );

    expect(geometry.splitters[0]?.bounds.x).toBeCloseTo(300);
    expect(geometry.dropZones.find((zone) => (
      zone.scope === "tabs"
      && zone.tabsNodeId === "tabs-2"
      && zone.position === "center"
    ))?.previewBounds.width).toBeCloseTo(300);
  });

  it("preserves the requested docked surface size in every edge direction", () => {
    const bounds = { x: 0, y: 0, width: 1_000, height: 700 };
    const preferred = { width: 300, height: 260 };
    const positions = ["left", "right", "top", "bottom"] as const;

    for (const position of positions) {
      const state = createDockLayout(
        createTabsNode("target", ["story"]),
        2,
      );
      const target = { tabsNodeId: "target", position } as const;
      const ratio = computeDockInsertionRatio(
        target,
        bounds,
        preferred,
        options.splitterThickness,
      );
      const next = dockPanel(
        state,
        "hierarchy",
        target,
        { insertedRatio: ratio },
      );
      const geometry = solveDockLayoutGeometry(next, bounds, options);
      const insertedBounds = geometry.dropZones.find((zone) => (
        zone.scope === "tabs"
        && zone.tabsNodeId === "tabs-2"
        && zone.position === "center"
      ))?.previewBounds;

      expect(insertedBounds).toBeDefined();
      if (position === "left" || position === "right") {
        expect(insertedBounds?.width).toBeCloseTo(preferred.width);
      } else {
        expect(insertedBounds?.height).toBeCloseTo(preferred.height);
      }
    }
  });

  it("lets subtree minimums clamp an undersized preferred surface", () => {
    const bounds = { x: 0, y: 0, width: 900, height: 700 };
    const positions = ["left", "right", "top", "bottom"] as const;

    for (const position of positions) {
      const state = createDockLayout(
        createTabsNode("target", ["story"]),
        2,
      );
      const target = { tabsNodeId: "target", position } as const;
      const ratio = computeDockInsertionRatio(
        target,
        bounds,
        { width: 100, height: 100 },
        options.splitterThickness,
      );
      const next = dockPanel(
        state,
        "hierarchy",
        target,
        { insertedRatio: ratio },
      );
      const geometry = solveDockLayoutGeometry(next, bounds, options);
      const insertedBounds = geometry.dropZones.find((zone) => (
        zone.scope === "tabs"
        && zone.tabsNodeId === "tabs-2"
        && zone.position === "center"
      ))?.previewBounds;

      expect(insertedBounds).toBeDefined();
      if (position === "left" || position === "right") {
        expect(insertedBounds?.width).toBeCloseTo(
          options.panelMinimumSizes.hierarchy.width,
        );
      } else {
        expect(insertedBounds?.height).toBeCloseTo(
          options.panelMinimumSizes.hierarchy.height
            + options.tabStripHeight,
        );
      }
    }
  });

  it("solves nested horizontal and vertical splits into active-panel rectangles", () => {
    const state = createDockLayout(
      createSplitNode(
        "root",
        "horizontal",
        0.25,
        createTabsNode("left-tabs", ["hierarchy"]),
        createSplitNode(
          "right-split",
          "vertical",
          0.6,
          createTabsNode("main-tabs", ["story", "map"], "story"),
          createTabsNode("bottom-tabs", ["inspector"]),
        ),
      ),
    );

    const geometry = solveDockLayoutGeometry(
      state,
      { x: 10, y: 20, width: 1_000, height: 700 },
      options,
    );

    expect(geometry.viewports).toEqual([
      { panelId: "hierarchy", bounds: { x: 10, y: 44, width: 248, height: 676 } },
      { panelId: "story", bounds: { x: 266, y: 44, width: 744, height: 391.2 } },
      { panelId: "inspector", bounds: { x: 266, y: 467.2, width: 744, height: 252.8 } },
    ]);
    expect(geometry.tabStrips.map((strip) => strip.tabsNodeId)).toEqual([
      "left-tabs",
      "main-tabs",
      "bottom-tabs",
    ]);
    expect(geometry.splitters).toEqual([
      {
        splitNodeId: "root",
        axis: "horizontal",
        bounds: { x: 258, y: 20, width: 8, height: 700 },
        containerBounds: { x: 10, y: 20, width: 1_000, height: 700 },
      },
      {
        splitNodeId: "right-split",
        axis: "vertical",
        bounds: { x: 266, y: 435.2, width: 744, height: 8 },
        containerBounds: { x: 266, y: 20, width: 744, height: 700 },
      },
    ]);
    expect(geometry.viewports.map((viewport) => viewport.panelId)).not.toContain("map");
    const workspaceZones = geometry.dropZones.filter((zone) => zone.scope === "workspace");
    const tabsZones = geometry.dropZones.filter((zone) => zone.scope === "tabs");
    expect(workspaceZones).toHaveLength(4);
    expect(workspaceZones.map((zone) => zone.position)).toEqual([
      "left",
      "right",
      "top",
      "bottom",
    ]);
    expect(workspaceZones.every((zone) => zone.tabsNodeId === null)).toBe(true);
    expect(tabsZones).toHaveLength(27);
    expect(tabsZones.filter((zone) => zone.tabsNodeId === "left-tabs"))
      .toHaveLength(9);
    expect(tabsZones.filter((zone) => zone.tabsNodeId === "main-tabs"))
      .toHaveLength(9);
    expect(tabsZones.filter((zone) => zone.tabsNodeId === "bottom-tabs"))
      .toHaveLength(9);
  });

  it("clamps split ratios against both global bounds and nested subtree minimum sizes", () => {
    const state = createDockLayout(
      createSplitNode(
        "root",
        "horizontal",
        0.99,
        createTabsNode("first", ["hierarchy"]),
        createSplitNode(
          "second",
          "horizontal",
          0.1,
          createTabsNode("second-a", ["story"]),
          createTabsNode("second-b", ["inspector"]),
        ),
      ),
    );

    const geometry = solveDockLayoutGeometry(
      state,
      { x: 0, y: 0, width: 900, height: 400 },
      options,
    );

    expect(geometry.splitters).toEqual([
      {
        splitNodeId: "root",
        axis: "horizontal",
        bounds: { x: 364, y: 0, width: 8, height: 400 },
        containerBounds: { x: 0, y: 0, width: 900, height: 400 },
      },
      {
        splitNodeId: "second",
        axis: "horizontal",
        bounds: { x: 692, y: 0, width: 8, height: 400 },
        containerBounds: { x: 372, y: 0, width: 528, height: 400 },
      },
    ]);
    expect(geometry.viewports.map((viewport) => viewport.bounds.width)).toEqual([364, 320, 200]);
  });

  it("uses the largest minimum from every tab and preserves bounds when active tabs change", () => {
    const state = createDockLayout(
      createSplitNode(
        "root",
        "horizontal",
        0.8,
        createTabsNode("first", ["hierarchy"]),
        createTabsNode("second", ["story", "map"], "story"),
      ),
    );
    const minimums = {
      ...options,
      panelMinimumSizes: {
        ...options.panelMinimumSizes,
        map: { width: 500, height: 300 },
      },
    };

    const storyGeometry = solveDockLayoutGeometry(
      state,
      { x: 0, y: 0, width: 900, height: 500 },
      minimums,
    );
    const mapGeometry = solveDockLayoutGeometry(
      setActivePanel(state, "second", "map"),
      { x: 0, y: 0, width: 900, height: 500 },
      minimums,
    );

    expect(storyGeometry.splitters[0]?.bounds.x).toBe(392);
    expect(storyGeometry.viewports).toEqual([
      { panelId: "hierarchy", bounds: { x: 0, y: 24, width: 392, height: 476 } },
      { panelId: "story", bounds: { x: 400, y: 24, width: 500, height: 476 } },
    ]);
    expect(mapGeometry.viewports).toEqual([
      { panelId: "hierarchy", bounds: { x: 0, y: 24, width: 392, height: 476 } },
      { panelId: "map", bounds: { x: 400, y: 24, width: 500, height: 476 } },
    ]);
    expect(mapGeometry.splitters).toEqual(storyGeometry.splitters);
  });

  it("creates nine Qt-style local segments for five targets plus thin workspace edges", () => {
    const state = createDockLayout(createTabsNode("tabs", ["story"]));
    const geometry = solveDockLayoutGeometry(
      state,
      { x: 100, y: 50, width: 400, height: 200 },
      options,
    );

    const workspaceZones = geometry.dropZones.filter(
      (zone) => zone.scope === "workspace",
    );
    const tabsZones = geometry.dropZones.filter(
      (zone) => zone.scope === "tabs",
    );
    expect(workspaceZones).toEqual([
      {
        id: "workspace:left",
        scope: "workspace",
        tabsNodeId: null,
        position: "left",
        bounds: { x: 100, y: 50, width: 24, height: 200 },
        previewBounds: { x: 100, y: 50, width: 120, height: 200 },
      },
      {
        id: "workspace:right",
        scope: "workspace",
        tabsNodeId: null,
        position: "right",
        bounds: { x: 476, y: 50, width: 24, height: 200 },
        previewBounds: { x: 380, y: 50, width: 120, height: 200 },
      },
      {
        id: "workspace:top",
        scope: "workspace",
        tabsNodeId: null,
        position: "top",
        bounds: { x: 124, y: 50, width: 352, height: 24 },
        previewBounds: { x: 100, y: 50, width: 400, height: 60 },
      },
      {
        id: "workspace:bottom",
        scope: "workspace",
        tabsNodeId: null,
        position: "bottom",
        bounds: { x: 124, y: 226, width: 352, height: 24 },
        previewBounds: { x: 100, y: 190, width: 400, height: 60 },
      },
    ]);
    expect(tabsZones).toHaveLength(9);
    expect(tabsZones.filter((zone) => zone.position === "left")).toHaveLength(3);
    expect(tabsZones.filter((zone) => zone.position === "right")).toHaveLength(3);
    expect(tabsZones.filter((zone) => zone.position === "top")).toHaveLength(1);
    expect(tabsZones.filter((zone) => zone.position === "bottom")).toHaveLength(1);
    const center = tabsZones.find((zone) => zone.position === "center");
    expect(center?.id).toBe("tabs:center");
    expect(center?.bounds.x).toBeCloseTo(166.666_666_666_7);
    expect(center?.bounds.y).toBeCloseTo(83.333_333_333_3);
    expect(center?.bounds.width).toBeCloseTo(266.666_666_666_7);
    expect(center?.bounds.height).toBeCloseTo(133.333_333_333_3);
    expect(center?.previewBounds).toEqual({
      x: 100,
      y: 50,
      width: 400,
      height: 200,
    });
    expect(resolveDockDropAt(geometry.dropZones, { x: 200, y: 80 }))
      .toMatchObject({ target: { tabsNodeId: "tabs", position: "left" } });
    expect(resolveDockDropAt(geometry.dropZones, { x: 300, y: 80 }))
      .toMatchObject({ target: { tabsNodeId: "tabs", position: "top" } });
    expect(resolveDockDropAt(geometry.dropZones, { x: 400, y: 80 }))
      .toMatchObject({ target: { tabsNodeId: "tabs", position: "right" } });
  });

  it("keeps a workspace target available when every panel is floating", () => {
    const geometry = solveDockLayoutGeometry(
      createDockLayout(null),
      { x: 20, y: 30, width: 600, height: 400 },
      options,
    );

    expect(geometry.dropZones).toHaveLength(5);
    expect(geometry.dropZones.every((zone) => (
      zone.tabsNodeId === null && zone.scope === "workspace"
    ))).toBe(true);
    expect(geometry.dropZones.find((zone) => zone.position === "center"))
      .toMatchObject({
        bounds: { x: 170, y: 130, width: 300, height: 200 },
        previewBounds: { x: 20, y: 30, width: 600, height: 400 },
      });
  });

  it("keeps geometry finite when the container cannot satisfy all minimum sizes", () => {
    const state = createDockLayout(
      createSplitNode(
        "root",
        "vertical",
        -5,
        createTabsNode("top", ["story"]),
        createTabsNode("bottom", ["inspector"]),
      ),
    );

    const geometry = solveDockLayoutGeometry(
      state,
      { x: Number.NaN, y: Number.POSITIVE_INFINITY, width: 20, height: 10 },
      options,
    );

    expect(geometry.splitters[0]?.bounds).toEqual({ x: 0, y: 0.2, width: 20, height: 8 });
    for (const rectangle of [
      ...geometry.viewports.map((viewport) => viewport.bounds),
      ...geometry.tabStrips.map((strip) => strip.bounds),
      ...geometry.splitters.map((splitter) => splitter.bounds),
      ...geometry.dropZones.map((zone) => zone.bounds),
      ...geometry.dropZones.map((zone) => zone.previewBounds),
      ...geometry.boundaryDropZones.map((zone) => zone.bounds),
      ...geometry.boundaryDropZones.map((zone) => zone.previewBounds),
    ]) {
      expect(Object.values(rectangle).every(Number.isFinite)).toBe(true);
      expect(rectangle.width).toBeGreaterThanOrEqual(0);
      expect(rectangle.height).toBeGreaterThanOrEqual(0);
    }
  });

  it("can place tab strips below persistent panel content", () => {
    const state = createDockLayout(
      createTabsNode("tabs", ["story", "map"], "map"),
    );
    const geometry = solveDockLayoutGeometry(
      state,
      { x: 30, y: 40, width: 500, height: 300 },
      { ...options, tabStripPlacement: "bottom" },
    );

    expect(geometry.viewports).toEqual([
      { panelId: "map", bounds: { x: 30, y: 40, width: 500, height: 276 } },
    ]);
    expect(geometry.tabStrips[0]?.bounds).toEqual({
      x: 30,
      y: 316,
      width: 500,
      height: 24,
    });
  });

  it("resolves any tabs surface center and each local edge deterministically", () => {
    const geometry = solveDockLayoutGeometry(
      createDockLayout(
        createSplitNode(
          "root",
          "horizontal",
          0.5,
          createTabsNode("left-tabs", ["hierarchy"]),
          createTabsNode("right-tabs", ["story"]),
        ),
      ),
      { x: 0, y: 0, width: 800, height: 600 },
      options,
    );

    expect(resolveDockDropAt(geometry, { x: 200, y: 300 }))
      .toMatchObject({ target: { tabsNodeId: "left-tabs", position: "center" } });
    expect(resolveDockDropAt(geometry, { x: 600, y: 300 }))
      .toMatchObject({ target: { tabsNodeId: "right-tabs", position: "center" } });
    expect(resolveDockDropAt(geometry, { x: 60, y: 300 }))
      .toMatchObject({ target: { tabsNodeId: "left-tabs", position: "left" } });
    expect(resolveDockDropAt(geometry, { x: 350, y: 300 }))
      .toMatchObject({ target: { tabsNodeId: "left-tabs", position: "right" } });
    expect(resolveDockDropAt(geometry, { x: 200, y: 60 }))
      .toMatchObject({ target: { tabsNodeId: "left-tabs", position: "top" } });
    expect(resolveDockDropAt(geometry, { x: 200, y: 550 }))
      .toMatchObject({ target: { tabsNodeId: "left-tabs", position: "bottom" } });
  });

  it("canonicalizes both sides and the splitter of one horizontal seam", () => {
    const geometry = solveDockLayoutGeometry(
      createDockLayout(
        createSplitNode(
          "root",
          "horizontal",
          0.5,
          createTabsNode("left-tabs", ["hierarchy"]),
          createTabsNode("right-tabs", ["story"]),
        ),
      ),
      { x: 0, y: 0, width: 800, height: 600 },
      options,
    );
    const points = [
      { x: 350, y: 300 },
      { x: 398, y: 300 },
      { x: 440, y: 300 },
    ];

    const resolutions = points.map((point) => (
      resolveDockDropAt(geometry, point)
    ));
    expect(resolutions.map((resolution) => resolution?.target)).toEqual([
      { tabsNodeId: "left-tabs", position: "right" },
      { tabsNodeId: "left-tabs", position: "right" },
      { tabsNodeId: "left-tabs", position: "right" },
    ]);
    expect(new Set(
      resolutions.map((resolution) => JSON.stringify(resolution?.previewBounds)),
    )).toHaveLength(1);
    expect(resolveDockDropAt(
      geometry,
      { x: 440, y: 300 },
      new Set(["left"]),
    )).toBeNull();
    expect(resolveDockDropAt(
      geometry,
      { x: 440, y: 300 },
      undefined,
      { tabsNodeId: "right-tabs", position: "left" },
      5,
    )).toMatchObject({
      target: { tabsNodeId: "left-tabs", position: "right" },
    });
  });

  it("canonicalizes both sides and the splitter of one vertical seam", () => {
    const geometry = solveDockLayoutGeometry(
      createDockLayout(
        createSplitNode(
          "root",
          "vertical",
          0.5,
          createTabsNode("top-tabs", ["story"]),
          createTabsNode("bottom-tabs", ["inspector"]),
        ),
      ),
      { x: 0, y: 0, width: 600, height: 800 },
      options,
    );

    for (const point of [
      { x: 300, y: 350 },
      { x: 300, y: 398 },
      { x: 300, y: 440 },
    ]) {
      expect(resolveDockDropAt(geometry, point)).toMatchObject({
        target: { tabsNodeId: "top-tabs", position: "bottom" },
      });
    }
  });

  it("selects the touching first-branch leaf along a nested T boundary", () => {
    const geometry = solveDockLayoutGeometry(
      createDockLayout(
        createSplitNode(
          "root",
          "horizontal",
          0.5,
          createSplitNode(
            "left-stack",
            "vertical",
            0.5,
            createTabsNode("left-top", ["hierarchy"]),
            createTabsNode("left-bottom", ["inspector"]),
          ),
          createTabsNode("right-tabs", ["story"]),
        ),
      ),
      { x: 0, y: 0, width: 900, height: 600 },
      options,
    );

    expect(resolveDockDropAt(geometry, { x: 490, y: 150 }))
      .toMatchObject({
        target: { tabsNodeId: "left-top", position: "right" },
      });
    expect(resolveDockDropAt(geometry, { x: 490, y: 450 }))
      .toMatchObject({
        target: { tabsNodeId: "left-bottom", position: "right" },
      });
  });

  it("uses the proportional Qt center inset instead of a capped edge band on wide panels", () => {
    const geometry = solveDockLayoutGeometry(
      createDockLayout(createTabsNode("tabs", ["story"])),
      { x: 0, y: 0, width: 900, height: 600 },
      options,
    );

    // The point is only 10 DIP beyond the Qt center inset. The former
    // max-96-DIP edge band incorrectly treated it as a center/tab merge.
    expect(resolveDockDropAt(geometry.dropZones, { x: 760, y: 110 }))
      .toMatchObject({ target: { tabsNodeId: "tabs", position: "right" } });
    expect(resolveDockDropAt(geometry.dropZones, { x: 450, y: 300 }))
      .toMatchObject({ target: { tabsNodeId: "tabs", position: "center" } });
    expect(resolveDockDropAt(
      geometry.dropZones,
      { x: 760, y: 110 },
      undefined,
      { tabsNodeId: "tabs", position: "center" },
      5,
    )).toMatchObject({
      target: { tabsNodeId: "tabs", position: "right" },
    });
  });

  it("matches Qt corner precedence to the target leaf parent orientation", () => {
    const horizontal = solveDockLayoutGeometry(
      createDockLayout(
        createSplitNode(
          "horizontal-root",
          "horizontal",
          0.5,
          createTabsNode("target", ["story"]),
          createTabsNode("other", ["inspector"]),
        ),
      ),
      { x: 0, y: 0, width: 808, height: 400 },
      options,
    );
    const vertical = solveDockLayoutGeometry(
      createDockLayout(
        createSplitNode(
          "vertical-root",
          "vertical",
          0.5,
          createTabsNode("target", ["story"]),
          createTabsNode("other", ["inspector"]),
        ),
      ),
      { x: 0, y: 0, width: 400, height: 808 },
      options,
    );

    expect(resolveDockDropAt(horizontal.dropZones, { x: 100, y: 60 }))
      .toMatchObject({ target: { tabsNodeId: "target", position: "left" } });
    expect(resolveDockDropAt(vertical.dropZones, { x: 100, y: 60 }))
      .toMatchObject({ target: { tabsNodeId: "target", position: "top" } });
  });

  it("preserves a frozen parent direction after source removal collapses a split", () => {
    const geometry = solveDockLayoutGeometry(
      createDockLayout(createTabsNode("target", ["story"])),
      { x: 0, y: 0, width: 400, height: 400 },
      {
        ...options,
        tabsParentOrientations: { target: "vertical" },
      },
    );

    expect(resolveDockDropAt(geometry.dropZones, { x: 100, y: 60 }))
      .toMatchObject({ target: { tabsNodeId: "target", position: "top" } });
  });

  it("prioritizes the outer workspace band, owns splitter gaps, and honors allowed positions", () => {
    const geometry = solveDockLayoutGeometry(
      createDockLayout(
        createSplitNode(
          "root",
          "horizontal",
          0.5,
          createTabsNode("left-tabs", ["hierarchy"]),
          createTabsNode("right-tabs", ["story"]),
        ),
      ),
      { x: 0, y: 0, width: 800, height: 600 },
      options,
    );

    expect(resolveDockDropAt(geometry, { x: 10, y: 300 }))
      .toMatchObject({ target: { tabsNodeId: null, position: "left" } });
    expect(resolveDockDropAt(geometry, { x: 398, y: 300 }))
      .toMatchObject({
        target: { tabsNodeId: "left-tabs", position: "right" },
      });
    expect(resolveDockDropAt(
      geometry,
      { x: 60, y: 300 },
      new Set(["center"]),
    )).toBeNull();
    expect(resolveDockDropAt(
      geometry,
      { x: 200, y: 300 },
      new Set(["center"]),
    )).toMatchObject({ target: { tabsNodeId: "left-tabs", position: "center" } });
  });

  it("retains a prior target for five DIP before switching or clearing, without bypassing allowed positions", () => {
    const zones = [
      {
        id: "tabs:left",
        scope: "tabs",
        tabsNodeId: "tabs",
        position: "left",
        bounds: { x: 100, y: 100, width: 100, height: 100 },
        previewBounds: { x: 100, y: 100, width: 30, height: 100 },
      },
      {
        id: "tabs:center",
        scope: "tabs",
        tabsNodeId: "tabs",
        position: "center",
        bounds: { x: 200, y: 100, width: 100, height: 100 },
        previewBounds: { x: 100, y: 100, width: 200, height: 100 },
      },
    ] as const;
    const retainedTarget = { tabsNodeId: "tabs", position: "left" } as const;

    expect(resolveDockDropAt(
      zones,
      { x: 204, y: 150 },
      undefined,
      retainedTarget,
      5,
    )).toMatchObject({ target: retainedTarget });
    expect(resolveDockDropAt(
      zones,
      { x: 206, y: 150 },
      undefined,
      retainedTarget,
      5,
    )).toMatchObject({
      target: { tabsNodeId: "tabs", position: "center" },
    });
    expect(resolveDockDropAt(
      zones,
      { x: 306, y: 150 },
      undefined,
      retainedTarget,
      5,
    )).toBeNull();
    expect(resolveDockDropAt(
      zones,
      { x: 204, y: 150 },
      new Set(["center"]),
      retainedTarget,
      5,
    )).toMatchObject({
      target: { tabsNodeId: "tabs", position: "center" },
    });
  });
});
