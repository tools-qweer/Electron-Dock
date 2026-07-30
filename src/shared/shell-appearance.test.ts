import { describe, expect, it } from "vitest";
import {
  DEFAULT_ELECTRON_DOCK_SHELL_APPEARANCE,
  normalizeElectronDockShellAppearance,
} from "./shell-appearance.js";

describe("Electron Dock shell appearance", () => {
  it("retains the alpha.3 visual defaults when no appearance is supplied", () => {
    expect(normalizeElectronDockShellAppearance()).toBe(
      DEFAULT_ELECTRON_DOCK_SHELL_APPEARANCE,
    );
    expect(DEFAULT_ELECTRON_DOCK_SHELL_APPEARANCE).toMatchObject({
      colors: {
        colorScheme: "dark",
        shellBackground: "#101313",
        foreground: "#eceff0",
        loadingForeground: "#788684",
      },
      titleBar: {
        background: "#181d1c",
        foreground: "#dce5e3",
        borderWidth: 1,
        bottomBorderColor: "#242b2a",
      },
      tabBar: {
        background: "#141817",
        borderWidth: 1,
        paddingTop: 2,
      },
      tab: {
        activeBackground: "#234d45",
        activeForeground: "#00ffcc",
        minimumWidth: 76,
      },
      splitter: {
        background: "#0b0e0e",
        hoverBackground: "#303030",
      },
    });
  });

  it("normalizes only structured tokens and safely bounds metrics", () => {
    const appearance = normalizeElectronDockShellAppearance({
      colors: {
        colorScheme: "light",
        shellBackground: "#fafafa",
        foreground: "not;a;color",
      },
      font: {
        family: "\"Inter\", \"Microsoft YaHei UI\", sans-serif",
        size: 200,
      },
      titleBar: {
        borderWidth: -2,
        bottomBorderWidth: 20,
        lineHeight: 28,
      },
      tabBar: {
        borderWidth: 0,
        topBorderWidth: 1,
      },
      tab: {
        minimumWidth: 0,
        activeForeground: "rgb(0, 255, 204)",
      },
    });

    expect(appearance).toMatchObject({
      colors: {
        colorScheme: "light",
        shellBackground: "#fafafa",
        foreground: "#eceff0",
      },
      font: {
        family: "\"Inter\", \"Microsoft YaHei UI\", sans-serif",
        size: 32,
      },
      titleBar: {
        borderWidth: 0,
        bottomBorderWidth: 4,
        lineHeight: 28,
      },
      tabBar: {
        borderWidth: 0,
        topBorderWidth: 1,
      },
      tab: {
        minimumWidth: 0,
        activeForeground: "rgb(0, 255, 204)",
      },
    });
    expect(Object.isFrozen(appearance)).toBe(true);
    expect(Object.isFrozen(appearance.titleBar)).toBe(true);
  });

  it("does not treat arbitrary CSS or unsafe declaration values as appearance", () => {
    const appearance = normalizeElectronDockShellAppearance({
      css: ".dock-titlebar { display: none }",
      colors: {
        shellBackground: "red; display:none",
      },
      font: {
        family: "Inter; display:none",
      },
    } as never);

    expect(appearance.colors.shellBackground).toBe(
      DEFAULT_ELECTRON_DOCK_SHELL_APPEARANCE.colors.shellBackground,
    );
    expect(appearance.font.family).toBe(
      DEFAULT_ELECTRON_DOCK_SHELL_APPEARANCE.font.family,
    );
    expect(appearance).not.toHaveProperty("css");
  });
});
