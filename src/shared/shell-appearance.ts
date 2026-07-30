export type ElectronDockColorScheme = "dark" | "light";

export interface ElectronDockShellColors {
  readonly colorScheme?: ElectronDockColorScheme;
  readonly shellBackground?: string;
  readonly foreground?: string;
  readonly mutedForeground?: string;
  readonly loadingForeground?: string;
}

export interface ElectronDockShellFont {
  readonly family?: string;
  readonly size?: number;
  readonly weight?: number;
}

export interface ElectronDockShellTopBarAppearance {
  readonly background?: string;
  readonly foreground?: string;
  readonly mutedForeground?: string;
  readonly borderColor?: string;
  readonly borderWidth?: number;
  readonly gap?: number;
  readonly paddingInline?: number;
  readonly titleFontSize?: number;
  readonly subtitleFontSize?: number;
}

export interface ElectronDockShellTitleBarAppearance {
  readonly background?: string;
  readonly foreground?: string;
  readonly borderColor?: string;
  readonly borderWidth?: number;
  readonly bottomBorderColor?: string;
  readonly bottomBorderWidth?: number;
  readonly gap?: number;
  readonly paddingInline?: number;
  readonly fontSize?: number;
  readonly fontWeight?: number;
  readonly lineHeight?: number | "normal";
  readonly gripColor?: string;
  readonly gripFontSize?: number;
}

export interface ElectronDockShellTabBarAppearance {
  readonly background?: string;
  readonly borderColor?: string;
  readonly borderWidth?: number;
  readonly topBorderColor?: string;
  readonly topBorderWidth?: number;
  readonly gap?: number;
  readonly paddingInline?: number;
  readonly paddingTop?: number;
}

export interface ElectronDockShellTabAppearance {
  readonly background?: string;
  readonly foreground?: string;
  readonly hoverBackground?: string;
  readonly hoverForeground?: string;
  readonly activeBackground?: string;
  readonly activeForeground?: string;
  readonly minimumWidth?: number;
  readonly paddingInline?: number;
  readonly borderRadius?: number;
  readonly fontSize?: number;
  readonly fontWeight?: number;
}

export interface ElectronDockShellSplitterAppearance {
  readonly background?: string;
  readonly hoverBackground?: string;
}

/**
 * Structured presentation tokens for the library-owned Dock shell.
 *
 * Consumers supply semantic values only. Arbitrary stylesheets and access to
 * the private shell WebContents are deliberately not part of this API.
 * Geometry (title-bar height, tab-strip height and splitter thickness) remains
 * owned by Electron Dock so appearance changes cannot invalidate layout.
 */
export interface ElectronDockShellAppearance {
  readonly colors?: ElectronDockShellColors;
  readonly font?: ElectronDockShellFont;
  readonly topBar?: ElectronDockShellTopBarAppearance;
  readonly titleBar?: ElectronDockShellTitleBarAppearance;
  readonly tabBar?: ElectronDockShellTabBarAppearance;
  readonly tab?: ElectronDockShellTabAppearance;
  readonly splitter?: ElectronDockShellSplitterAppearance;
}

export interface NormalizedElectronDockShellAppearance {
  readonly colors: Required<ElectronDockShellColors>;
  readonly font: Required<ElectronDockShellFont>;
  readonly topBar: Required<ElectronDockShellTopBarAppearance>;
  readonly titleBar: Required<ElectronDockShellTitleBarAppearance>;
  readonly tabBar: Required<ElectronDockShellTabBarAppearance>;
  readonly tab: Required<ElectronDockShellTabAppearance>;
  readonly splitter: Required<ElectronDockShellSplitterAppearance>;
}

export const DEFAULT_ELECTRON_DOCK_SHELL_APPEARANCE =
  freezeAppearance({
    colors: {
      colorScheme: "dark",
      shellBackground: "#101313",
      foreground: "#eceff0",
      mutedForeground: "#788684",
      loadingForeground: "#788684",
    },
    font: {
      family: "\"Segoe UI\", \"Microsoft YaHei UI\", sans-serif",
      size: 16,
      weight: 400,
    },
    topBar: {
      background: "#151919",
      foreground: "#f2f6f5",
      mutedForeground: "#81908e",
      borderColor: "#303636",
      borderWidth: 1,
      gap: 14,
      paddingInline: 14,
      titleFontSize: 14,
      subtitleFontSize: 12,
    },
    titleBar: {
      background: "#181d1c",
      foreground: "#dce5e3",
      borderColor: "#2b3332",
      borderWidth: 1,
      bottomBorderColor: "#242b2a",
      bottomBorderWidth: 1,
      gap: 12,
      paddingInline: 10,
      fontSize: 13,
      fontWeight: 600,
      lineHeight: "normal",
      gripColor: "#5d6a68",
      gripFontSize: 14,
    },
    tabBar: {
      background: "#141817",
      borderColor: "#2b3332",
      borderWidth: 1,
      topBorderColor: "#2b3332",
      topBorderWidth: 1,
      gap: 1,
      paddingInline: 4,
      paddingTop: 2,
    },
    tab: {
      background: "transparent",
      foreground: "#82908e",
      hoverBackground: "#1c2422",
      hoverForeground: "#cbd5d3",
      activeBackground: "#234d45",
      activeForeground: "#00ffcc",
      minimumWidth: 76,
      paddingInline: 14,
      borderRadius: 3,
      fontSize: 12,
      fontWeight: 400,
    },
    splitter: {
      background: "#0b0e0e",
      hoverBackground: "#303030",
    },
  });

export function normalizeElectronDockShellAppearance(
  value?: ElectronDockShellAppearance | null,
): NormalizedElectronDockShellAppearance {
  if (value === null || value === undefined) {
    return DEFAULT_ELECTRON_DOCK_SHELL_APPEARANCE;
  }
  const defaults = DEFAULT_ELECTRON_DOCK_SHELL_APPEARANCE;
  const colors = objectValue(value.colors);
  const font = objectValue(value.font);
  const topBar = objectValue(value.topBar);
  const titleBar = objectValue(value.titleBar);
  const tabBar = objectValue(value.tabBar);
  const tab = objectValue(value.tab);
  const splitter = objectValue(value.splitter);
  return freezeAppearance({
    colors: {
      colorScheme: colors.colorScheme === "light" ? "light" : "dark",
      shellBackground: colorValue(
        colors.shellBackground,
        defaults.colors.shellBackground,
      ),
      foreground: colorValue(
        colors.foreground,
        defaults.colors.foreground,
      ),
      mutedForeground: colorValue(
        colors.mutedForeground,
        defaults.colors.mutedForeground,
      ),
      loadingForeground: colorValue(
        colors.loadingForeground,
        defaults.colors.loadingForeground,
      ),
    },
    font: {
      family: fontFamilyValue(font.family, defaults.font.family),
      size: numericValue(font.size, defaults.font.size, 8, 32),
      weight: fontWeightValue(font.weight, defaults.font.weight),
    },
    topBar: {
      background: colorValue(
        topBar.background,
        defaults.topBar.background,
      ),
      foreground: colorValue(
        topBar.foreground,
        defaults.topBar.foreground,
      ),
      mutedForeground: colorValue(
        topBar.mutedForeground,
        defaults.topBar.mutedForeground,
      ),
      borderColor: colorValue(
        topBar.borderColor,
        defaults.topBar.borderColor,
      ),
      borderWidth: numericValue(
        topBar.borderWidth,
        defaults.topBar.borderWidth,
        0,
        4,
      ),
      gap: numericValue(topBar.gap, defaults.topBar.gap, 0, 48),
      paddingInline: numericValue(
        topBar.paddingInline,
        defaults.topBar.paddingInline,
        0,
        48,
      ),
      titleFontSize: numericValue(
        topBar.titleFontSize,
        defaults.topBar.titleFontSize,
        8,
        32,
      ),
      subtitleFontSize: numericValue(
        topBar.subtitleFontSize,
        defaults.topBar.subtitleFontSize,
        8,
        32,
      ),
    },
    titleBar: {
      background: colorValue(
        titleBar.background,
        defaults.titleBar.background,
      ),
      foreground: colorValue(
        titleBar.foreground,
        defaults.titleBar.foreground,
      ),
      borderColor: colorValue(
        titleBar.borderColor,
        defaults.titleBar.borderColor,
      ),
      borderWidth: numericValue(
        titleBar.borderWidth,
        defaults.titleBar.borderWidth,
        0,
        4,
      ),
      bottomBorderColor: colorValue(
        titleBar.bottomBorderColor,
        defaults.titleBar.bottomBorderColor,
      ),
      bottomBorderWidth: numericValue(
        titleBar.bottomBorderWidth,
        defaults.titleBar.bottomBorderWidth,
        0,
        4,
      ),
      gap: numericValue(titleBar.gap, defaults.titleBar.gap, 0, 48),
      paddingInline: numericValue(
        titleBar.paddingInline,
        defaults.titleBar.paddingInline,
        0,
        48,
      ),
      fontSize: numericValue(
        titleBar.fontSize,
        defaults.titleBar.fontSize,
        8,
        32,
      ),
      fontWeight: fontWeightValue(
        titleBar.fontWeight,
        defaults.titleBar.fontWeight,
      ),
      lineHeight: lineHeightValue(
        titleBar.lineHeight,
        defaults.titleBar.lineHeight,
      ),
      gripColor: colorValue(
        titleBar.gripColor,
        defaults.titleBar.gripColor,
      ),
      gripFontSize: numericValue(
        titleBar.gripFontSize,
        defaults.titleBar.gripFontSize,
        8,
        32,
      ),
    },
    tabBar: {
      background: colorValue(
        tabBar.background,
        defaults.tabBar.background,
      ),
      borderColor: colorValue(
        tabBar.borderColor,
        defaults.tabBar.borderColor,
      ),
      borderWidth: numericValue(
        tabBar.borderWidth,
        defaults.tabBar.borderWidth,
        0,
        4,
      ),
      topBorderColor: colorValue(
        tabBar.topBorderColor,
        defaults.tabBar.topBorderColor,
      ),
      topBorderWidth: numericValue(
        tabBar.topBorderWidth,
        defaults.tabBar.topBorderWidth,
        0,
        4,
      ),
      gap: numericValue(tabBar.gap, defaults.tabBar.gap, 0, 24),
      paddingInline: numericValue(
        tabBar.paddingInline,
        defaults.tabBar.paddingInline,
        0,
        48,
      ),
      paddingTop: numericValue(
        tabBar.paddingTop,
        defaults.tabBar.paddingTop,
        0,
        16,
      ),
    },
    tab: {
      background: colorValue(
        tab.background,
        defaults.tab.background,
      ),
      foreground: colorValue(
        tab.foreground,
        defaults.tab.foreground,
      ),
      hoverBackground: colorValue(
        tab.hoverBackground,
        defaults.tab.hoverBackground,
      ),
      hoverForeground: colorValue(
        tab.hoverForeground,
        defaults.tab.hoverForeground,
      ),
      activeBackground: colorValue(
        tab.activeBackground,
        defaults.tab.activeBackground,
      ),
      activeForeground: colorValue(
        tab.activeForeground,
        defaults.tab.activeForeground,
      ),
      minimumWidth: numericValue(
        tab.minimumWidth,
        defaults.tab.minimumWidth,
        0,
        320,
      ),
      paddingInline: numericValue(
        tab.paddingInline,
        defaults.tab.paddingInline,
        0,
        64,
      ),
      borderRadius: numericValue(
        tab.borderRadius,
        defaults.tab.borderRadius,
        0,
        24,
      ),
      fontSize: numericValue(
        tab.fontSize,
        defaults.tab.fontSize,
        8,
        32,
      ),
      fontWeight: fontWeightValue(
        tab.fontWeight,
        defaults.tab.fontWeight,
      ),
    },
    splitter: {
      background: colorValue(
        splitter.background,
        defaults.splitter.background,
      ),
      hoverBackground: colorValue(
        splitter.hoverBackground,
        defaults.splitter.hoverBackground,
      ),
    },
  });
}

export function electronDockShellAppearancesEqual(
  left: NormalizedElectronDockShellAppearance,
  right: NormalizedElectronDockShellAppearance,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function colorValue(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const candidate = value.trim();
  if (
    candidate === "transparent"
    || /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu
      .test(candidate)
    || /^(?:rgb|rgba|hsl|hsla)\([\d\s.,%+-]+\)$/iu.test(candidate)
    || /^[a-z]+$/iu.test(candidate)
  ) {
    return candidate;
  }
  return fallback;
}

function fontFamilyValue(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const candidate = value.trim();
  return candidate.length > 0
    && candidate.length <= 240
    && /^[\p{L}\p{N}\s"',._-]+$/u.test(candidate)
    ? candidate
    : fallback;
}

function numericValue(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(
    Math.min(maximum, Math.max(minimum, value)) * 100,
  ) / 100;
}

function fontWeightValue(value: unknown, fallback: number): number {
  return Math.round(numericValue(value, fallback, 100, 900));
}

function lineHeightValue(
  value: unknown,
  fallback: number | "normal",
): number | "normal" {
  if (value === undefined) return fallback;
  return value === "normal"
    ? value
    : numericValue(value, typeof fallback === "number" ? fallback : 16, 8, 64);
}

function freezeAppearance(
  appearance: NormalizedElectronDockShellAppearance,
): NormalizedElectronDockShellAppearance {
  Object.freeze(appearance.colors);
  Object.freeze(appearance.font);
  Object.freeze(appearance.topBar);
  Object.freeze(appearance.titleBar);
  Object.freeze(appearance.tabBar);
  Object.freeze(appearance.tab);
  Object.freeze(appearance.splitter);
  return Object.freeze(appearance);
}
