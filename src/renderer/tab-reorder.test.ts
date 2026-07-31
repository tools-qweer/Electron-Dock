import { describe, expect, it } from "vitest";
import {
  completeTabReorderSession,
  createTabReorderSession,
  reorderPanelIds,
  resolveTabFlipTranslations,
  updateTabReorderSession,
} from "./tab-reorder.js";

describe("Dock tab reorder gesture", () => {
  it("waits for four DIP of Manhattan movement before starting", () => {
    const initial = createTabReorderSession("map", 120, 30, 1);

    expect(
      updateTabReorderSession(initial, 122, 31, [50, 150, 250]),
    ).toMatchObject({
      started: false,
      currentIndex: 1,
    });
    expect(
      updateTabReorderSession(initial, 123, 31, [50, 150, 250]),
    ).toMatchObject({
      started: true,
      currentIndex: 1,
    });
  });

  it("moves across adjacent tab midpoints in either direction", () => {
    const initial = createTabReorderSession("story", 40, 20, 0);
    const movedRight = updateTabReorderSession(
      initial,
      260,
      20,
      [50, 150, 250],
    );
    const movedBack = updateTabReorderSession(
      movedRight,
      40,
      20,
      [50, 150, 250],
    );

    expect(movedRight).toMatchObject({
      started: true,
      currentIndex: 2,
    });
    expect(movedBack.currentIndex).toBe(0);
    expect(reorderPanelIds(["story", "map", "inspector"], "story", 2))
      .toEqual(["map", "inspector", "story"]);
  });

  it("commits only a changed completed drag and suppresses its trailing click", () => {
    const initial = createTabReorderSession("map", 140, 20, 1);
    const moved = updateTabReorderSession(
      initial,
      40,
      20,
      [50, 150],
    );

    expect(completeTabReorderSession(moved, false)).toEqual({
      targetIndex: 0,
      suppressClick: true,
    });
    expect(completeTabReorderSession(moved, true)).toEqual({
      targetIndex: null,
      suppressClick: true,
    });
    expect(completeTabReorderSession(initial, false)).toEqual({
      targetIndex: null,
      suppressClick: false,
    });
  });

  it("computes stable FLIP offsets for every tab displaced by a preview reorder", () => {
    expect(resolveTabFlipTranslations(
      [
        { panelId: "story", left: 12 },
        { panelId: "map", left: 96 },
        { panelId: "inspector", left: 180 },
      ],
      [
        { panelId: "map", left: 12 },
        { panelId: "story", left: 96 },
        { panelId: "inspector", left: 180 },
      ],
    )).toEqual([
      { panelId: "map", translateX: 84 },
      { panelId: "story", translateX: -84 },
    ]);
  });

  it("ignores missing, invalid and sub-pixel stationary FLIP entries", () => {
    expect(resolveTabFlipTranslations(
      [
        { panelId: "story", left: 10 },
        { panelId: "invalid", left: Number.NaN },
      ],
      [
        { panelId: "story", left: 10.4 },
        { panelId: "map", left: 80 },
      ],
    )).toEqual([]);
  });
});
