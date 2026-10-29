import type { WindowThemeMode } from "@shared/ipc";
import { BrowserWindow, nativeTheme } from "electron";

type WindowThemePreset = Exclude<WindowThemeMode, "system">;

const WINDOW_FRAME_BY_THEME: Record<WindowThemePreset, { background: string; symbol: string }> = {
  light: {
    background: "#e8eaed",
    symbol: "#0f1217",
  },
  dark: {
    background: "#181818",
    symbol: "#ffffff",
  },
};

let activeWindowThemeMode: WindowThemeMode = "dark";

export function resolveWindowThemeMode(
  themeMode: WindowThemeMode = activeWindowThemeMode,
): WindowThemePreset {
  if (themeMode === "system") {
    return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  }
  return themeMode;
}

export function normalizeWindowThemeMode(themeMode: unknown): WindowThemeMode {
  if (themeMode === "light" || themeMode === "dark" || themeMode === "system") {
    return themeMode;
  }
  /* Legacy cyan/orange theme modes map to light chrome. */
  if (themeMode === "cyan" || themeMode === "orange") {
    return "light";
  }
  return "dark";
}

export function getWindowBackgroundColor(): string {
  return WINDOW_FRAME_BY_THEME[resolveWindowThemeMode()].background;
}

export function getWindowTitleBarOverlay(): Electron.TitleBarOverlay {
  const frame = WINDOW_FRAME_BY_THEME[resolveWindowThemeMode()];
  return {
    color: frame.background,
    symbolColor: frame.symbol,
    height: 30,
  };
}

function applyWindowBackgroundColor(): void {
  const backgroundColor = getWindowBackgroundColor();
  const titleBarOverlay = getWindowTitleBarOverlay();

  for (const browserWindow of BrowserWindow.getAllWindows()) {
    browserWindow.setBackgroundColor(backgroundColor);
    browserWindow.setTitleBarOverlay(titleBarOverlay);
  }
}

export function applyWindowThemeMode(themeMode: WindowThemeMode): "light" | "dark" {
  activeWindowThemeMode = themeMode;
  nativeTheme.themeSource = themeMode;
  const resolvedTheme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  applyWindowBackgroundColor();
  return resolvedTheme;
}

nativeTheme.on("updated", () => {
  if (activeWindowThemeMode === "system") applyWindowBackgroundColor();
});
