import { describe, expect, it } from "vitest";
import {
  hasAccessibleTitleArea,
  recoverWindowBounds,
  type DipDisplayWorkArea,
} from "./display-bounds.js";
import type { Rectangle } from "./types.js";

const primary: DipDisplayWorkArea = {
  id: "primary",
  primary: true,
  scaleFactor: 1,
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};

describe("recoverWindowBounds", () => {
  it("keeps valid negative coordinates on a connected left display", () => {
    const leftDisplay: DipDisplayWorkArea = {
      id: "left",
      scaleFactor: 1.25,
      workArea: { x: -1280, y: -80, width: 1280, height: 984 },
    };
    const persisted = { x: -1180, y: -20, width: 760, height: 620 };

    expect(recoverWindowBounds(persisted, [primary, leftDisplay])).toEqual(
      persisted,
    );
    expect(hasAccessibleTitleArea(persisted, [primary, leftDisplay])).toBe(
      true,
    );
  });

  it("uses DIP coordinates directly on a mixed-DPI display", () => {
    const highDpiDisplay: DipDisplayWorkArea = {
      id: "high-dpi",
      scaleFactor: 2,
      workArea: { x: 1920, y: -120, width: 1280, height: 900 },
    };
    const persisted = { x: 2080, y: 40, width: 640, height: 500 };

    expect(recoverWindowBounds(persisted, [primary, highDpiDisplay])).toEqual(
      persisted,
    );
  });

  it("moves a window from a removed left display wholly onto the nearest display", () => {
    const persisted = { x: -1400, y: 120, width: 720, height: 560 };

    expect(recoverWindowBounds(persisted, [primary])).toEqual({
      x: 0,
      y: 120,
      width: 720,
      height: 560,
    });
  });

  it("moves a window from a removed right display to the nearest current edge", () => {
    const persisted = { x: 2500, y: 160, width: 600, height: 500 };

    expect(recoverWindowBounds(persisted, [primary])).toEqual({
      x: 1320,
      y: 160,
      width: 600,
      height: 500,
    });
  });

  it("moves a partially visible window only enough to expose title width", () => {
    const persisted = { x: -570, y: 100, width: 600, height: 500 };
    const recovered = recoverWindowBounds(persisted, [primary]);

    expect(recovered).toEqual({
      x: -504,
      y: 100,
      width: 600,
      height: 500,
    });
    expect(hasAccessibleTitleArea(recovered, [primary])).toBe(true);
  });

  it("recovers an inaccessible title above the work area while preserving the body", () => {
    const persisted = { x: 200, y: -100, width: 700, height: 600 };
    const recovered = recoverWindowBounds(persisted, [primary]);

    expect(recovered).toEqual({
      x: 200,
      y: -8,
      width: 700,
      height: 600,
    });
    expect(hasAccessibleTitleArea(recovered, [primary])).toBe(true);
  });

  it("uses the display with the largest existing window intersection", () => {
    const rightDisplay: DipDisplayWorkArea = {
      id: "right",
      scaleFactor: 1.5,
      workArea: { x: 1920, y: 0, width: 1440, height: 900 },
    };
    const persisted = { x: 1890, y: -80, width: 900, height: 600 };
    const recovered = recoverWindowBounds(persisted, [primary, rightDisplay]);

    expect(recovered).toEqual({
      x: 1890,
      y: -8,
      width: 900,
      height: 600,
    });
    expect(hasAccessibleTitleArea(recovered, [primary, rightDisplay])).toBe(
      true,
    );
  });

  it("preserves an oversized window and restores its title to the work area", () => {
    const persisted = { x: 2300, y: 1300, width: 2400, height: 1400 };
    const recovered = recoverWindowBounds(persisted, [primary]);

    expect(recovered).toEqual({
      x: 0,
      y: 0,
      width: 2400,
      height: 1400,
    });
    expect(hasAccessibleTitleArea(recovered, [primary])).toBe(true);
  });

  it("normalizes corrupt persisted geometry without display information", () => {
    const corruptBounds = {
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
      width: -1,
      height: 0,
    };

    expect(recoverWindowBounds(corruptBounds, [])).toEqual({
      x: 0,
      y: 0,
      width: 160,
      height: 120,
    });
  });

  it("ignores unusable display work areas", () => {
    const unusable: DipDisplayWorkArea = {
      id: "invalid",
      workArea: { x: -900, y: 0, width: 0, height: 800 },
    };
    const persisted = { x: -500, y: 50, width: 400, height: 300 };

    expect(recoverWindowBounds(persisted, [unusable])).toEqual(persisted);
  });

  it("honors custom title reachability requirements", () => {
    const persisted = { x: -460, y: -30, width: 500, height: 400 };
    const options = {
      titleBarHeight: 40,
      minimumVisibleTitleWidth: 120,
      minimumVisibleTitleHeight: 30,
    };
    const recovered = recoverWindowBounds(persisted, [primary], options);

    expect(recovered).toEqual({
      x: -380,
      y: -10,
      width: 500,
      height: 400,
    });
    expect(hasAccessibleTitleArea(recovered, [primary], options)).toBe(true);
  });

  it("keeps the result reachable for every cardinal off-screen direction", () => {
    const cases: readonly Rectangle[] = [
      { x: -3000, y: 200, width: 640, height: 480 },
      { x: 3000, y: 200, width: 640, height: 480 },
      { x: 200, y: -2000, width: 640, height: 480 },
      { x: 200, y: 2000, width: 640, height: 480 },
    ];

    for (const persisted of cases) {
      const recovered = recoverWindowBounds(persisted, [primary]);
      expect(hasAccessibleTitleArea(recovered, [primary])).toBe(true);
    }
  });
});
