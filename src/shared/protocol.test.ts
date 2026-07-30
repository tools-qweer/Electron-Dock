import { describe, expect, it } from "vitest";
import {
  isReorderTabMessage,
  type ReorderTabMessage,
} from "./protocol.js";

describe("Electron Dock internal protocol", () => {
  it("accepts only safe non-negative tab reorder destinations", () => {
    const valid: ReorderTabMessage = {
      tabsNodeId: "tabs-scenes",
      panelId: "map",
      targetIndex: 0,
    };

    expect(isReorderTabMessage(valid)).toBe(true);
    expect(isReorderTabMessage({ ...valid, targetIndex: -1 })).toBe(false);
    expect(isReorderTabMessage({ ...valid, targetIndex: 0.5 })).toBe(false);
    expect(isReorderTabMessage({
      ...valid,
      targetIndex: Number.MAX_SAFE_INTEGER + 1,
    })).toBe(false);
    expect(isReorderTabMessage({ ...valid, panelId: null })).toBe(false);
    expect(isReorderTabMessage(null)).toBe(false);
  });
});
