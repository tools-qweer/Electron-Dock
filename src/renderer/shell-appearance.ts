import {
  normalizeElectronDockShellAppearance,
  type NormalizedElectronDockShellAppearance,
} from "../shared/shell-appearance.js";

export const SHELL_APPEARANCE_SEARCH_PARAMETER = "shellAppearance";

export function shellAppearanceFromSearch(
  search: string,
): NormalizedElectronDockShellAppearance {
  const serialized = new URLSearchParams(search).get(
    SHELL_APPEARANCE_SEARCH_PARAMETER,
  );
  if (serialized === null) return normalizeElectronDockShellAppearance();
  try {
    return normalizeElectronDockShellAppearance(JSON.parse(serialized));
  } catch {
    return normalizeElectronDockShellAppearance();
  }
}

export function shellAppearanceCssVariables(
  appearance: NormalizedElectronDockShellAppearance,
): Readonly<Record<string, string>> {
  return {
    "--electron-dock-color-scheme": appearance.colors.colorScheme,
    "--electron-dock-shell-background": appearance.colors.shellBackground,
    "--electron-dock-foreground": appearance.colors.foreground,
    "--electron-dock-muted-foreground": appearance.colors.mutedForeground,
    "--electron-dock-loading-foreground":
      appearance.colors.loadingForeground,
    "--electron-dock-font-family": appearance.font.family,
    "--electron-dock-font-size": pixels(appearance.font.size),
    "--electron-dock-font-weight": String(appearance.font.weight),
    "--electron-dock-topbar-background": appearance.topBar.background,
    "--electron-dock-topbar-foreground": appearance.topBar.foreground,
    "--electron-dock-topbar-muted-foreground":
      appearance.topBar.mutedForeground,
    "--electron-dock-topbar-border-color": appearance.topBar.borderColor,
    "--electron-dock-topbar-border-width":
      pixels(appearance.topBar.borderWidth),
    "--electron-dock-topbar-gap": pixels(appearance.topBar.gap),
    "--electron-dock-topbar-padding-inline":
      pixels(appearance.topBar.paddingInline),
    "--electron-dock-topbar-title-font-size":
      pixels(appearance.topBar.titleFontSize),
    "--electron-dock-topbar-subtitle-font-size":
      pixels(appearance.topBar.subtitleFontSize),
    "--electron-dock-titlebar-background": appearance.titleBar.background,
    "--electron-dock-titlebar-foreground": appearance.titleBar.foreground,
    "--electron-dock-titlebar-border-color":
      appearance.titleBar.borderColor,
    "--electron-dock-titlebar-border-width":
      pixels(appearance.titleBar.borderWidth),
    "--electron-dock-titlebar-bottom-border-color":
      appearance.titleBar.bottomBorderColor,
    "--electron-dock-titlebar-bottom-border-width":
      pixels(appearance.titleBar.bottomBorderWidth),
    "--electron-dock-titlebar-gap": pixels(appearance.titleBar.gap),
    "--electron-dock-titlebar-padding-inline":
      pixels(appearance.titleBar.paddingInline),
    "--electron-dock-titlebar-font-size":
      pixels(appearance.titleBar.fontSize),
    "--electron-dock-titlebar-font-weight":
      String(appearance.titleBar.fontWeight),
    "--electron-dock-titlebar-line-height":
      appearance.titleBar.lineHeight === "normal"
        ? "normal"
        : pixels(appearance.titleBar.lineHeight),
    "--electron-dock-titlebar-grip-color":
      appearance.titleBar.gripColor,
    "--electron-dock-titlebar-grip-font-size":
      pixels(appearance.titleBar.gripFontSize),
    "--electron-dock-tabbar-background": appearance.tabBar.background,
    "--electron-dock-tabbar-border-color": appearance.tabBar.borderColor,
    "--electron-dock-tabbar-border-width":
      pixels(appearance.tabBar.borderWidth),
    "--electron-dock-tabbar-top-border-color":
      appearance.tabBar.topBorderColor,
    "--electron-dock-tabbar-top-border-width":
      pixels(appearance.tabBar.topBorderWidth),
    "--electron-dock-tabbar-gap": pixels(appearance.tabBar.gap),
    "--electron-dock-tabbar-padding-inline":
      pixels(appearance.tabBar.paddingInline),
    "--electron-dock-tabbar-padding-top":
      pixels(appearance.tabBar.paddingTop),
    "--electron-dock-tab-background": appearance.tab.background,
    "--electron-dock-tab-foreground": appearance.tab.foreground,
    "--electron-dock-tab-hover-background": appearance.tab.hoverBackground,
    "--electron-dock-tab-hover-foreground": appearance.tab.hoverForeground,
    "--electron-dock-tab-active-background":
      appearance.tab.activeBackground,
    "--electron-dock-tab-active-foreground":
      appearance.tab.activeForeground,
    "--electron-dock-tab-minimum-width":
      pixels(appearance.tab.minimumWidth),
    "--electron-dock-tab-padding-inline":
      pixels(appearance.tab.paddingInline),
    "--electron-dock-tab-border-radius":
      pixels(appearance.tab.borderRadius),
    "--electron-dock-tab-font-size": pixels(appearance.tab.fontSize),
    "--electron-dock-tab-font-weight": String(appearance.tab.fontWeight),
    "--electron-dock-splitter-background":
      appearance.splitter.background,
    "--electron-dock-splitter-hover-background":
      appearance.splitter.hoverBackground,
  };
}

export function applyShellAppearanceVariables(
  style: Pick<CSSStyleDeclaration, "setProperty">,
  appearance: NormalizedElectronDockShellAppearance,
): void {
  for (const [name, value] of Object.entries(
    shellAppearanceCssVariables(appearance),
  )) {
    style.setProperty(name, value);
  }
}

function pixels(value: number): string {
  return `${String(value)}px`;
}
