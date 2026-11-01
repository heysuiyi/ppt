import { expect, it, vi } from "vitest";

const platform = vi.hoisted(() => {
  const events = new EventTarget();
  const state = {
    source: "dark" as "light" | "dark" | "system",
    systemDark: false,
    background: "",
    overlay: { color: "", symbolColor: "", height: 0 },
  };
  return {
    state,
    changeSystem(dark: boolean) {
      state.systemDark = dark;
      events.dispatchEvent(new Event("updated"));
    },
    nativeTheme: {
      get themeSource() {
        return state.source;
      },
      set themeSource(source: "light" | "dark" | "system") {
        state.source = source;
      },
      get shouldUseDarkColors() {
        return state.source === "dark" || (state.source === "system" && state.systemDark);
      },
      on(_event: string, listener: () => void) {
        events.addEventListener("updated", listener);
      },
    },
    window: {
      setBackgroundColor(color: string) {
        state.background = color;
      },
      setTitleBarOverlay(overlay: typeof state.overlay) {
        state.overlay = overlay;
      },
    },
  };
});

vi.mock("electron", () => ({
  nativeTheme: platform.nativeTheme,
  BrowserWindow: { getAllWindows: () => [platform.window] },
}));

import { applyWindowThemeMode } from "../app/main/window/theme";

it("follows OS changes after leaving an explicit mode and keeps caption colors synchronized", () => {
  const frame = () => ({
    background: platform.state.background,
    ...platform.state.overlay,
  });
  applyWindowThemeMode("light");
  const light = frame();
  applyWindowThemeMode("dark");
  const dark = frame();
  expect(dark.background).not.toBe(light.background);

  platform.changeSystem(false);
  expect(frame()).toEqual(dark);
  expect(applyWindowThemeMode("system")).toBe("light");
  expect(frame()).toEqual(light);

  platform.changeSystem(true);
  expect(frame()).toEqual(dark);

  applyWindowThemeMode("light");
  platform.changeSystem(false);
  platform.changeSystem(true);
  expect(frame()).toEqual(light);
});
