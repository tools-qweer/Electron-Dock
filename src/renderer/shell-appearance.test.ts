import { describe, expect, it, vi } from "vitest";
import {
  normalizeElectronDockShellAppearance,
} from "../shared/shell-appearance.js";
import {
  applyShellAppearanceVariables,
  shellAppearanceCssVariables,
  shellAppearanceFromSearch,
} from "./shell-appearance.js";

describe("Dock shell appearance renderer projection", () => {
  it("hydrates the initial appearance from the shell URL", () => {
    const source = normalizeElectronDockShellAppearance({
      colors: { shellBackground: "#112233" },
      tab: { activeForeground: "#abcdef" },
    });
    const search = new URLSearchParams({
      shellAppearance: JSON.stringify(source),
    });

    expect(shellAppearanceFromSearch(`?${search.toString()}`)).toEqual(source);
    expect(shellAppearanceFromSearch("?shellAppearance=%7Bbroken")).toEqual(
      normalizeElectronDockShellAppearance(),
    );
  });

  it("projects stable CSS variables without accepting selectors or rules", () => {
    const variables = shellAppearanceCssVariables(
      normalizeElectronDockShellAppearance({
        titleBar: {
          background: "#202020",
          borderWidth: 0,
          bottomBorderWidth: 1,
          lineHeight: 28,
        },
        tabBar: {
          borderWidth: 0,
          topBorderWidth: 1,
        },
      }),
    );

    expect(variables).toMatchObject({
      "--electron-dock-titlebar-background": "#202020",
      "--electron-dock-titlebar-border-width": "0px",
      "--electron-dock-titlebar-bottom-border-width": "1px",
      "--electron-dock-titlebar-line-height": "28px",
      "--electron-dock-tabbar-border-width": "0px",
      "--electron-dock-tabbar-top-border-width": "1px",
    });
    expect(Object.keys(variables).every((name) => (
      name.startsWith("--electron-dock-")
    ))).toBe(true);
  });

  it("applies dynamic values through style properties only", () => {
    const setProperty = vi.fn();
    applyShellAppearanceVariables(
      { setProperty },
      normalizeElectronDockShellAppearance({
        splitter: { hoverBackground: "#445566" },
      }),
    );

    expect(setProperty).toHaveBeenCalledWith(
      "--electron-dock-splitter-hover-background",
      "#445566",
    );
  });
});
