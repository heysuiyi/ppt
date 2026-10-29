// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UiColorScheme } from "../src/renderer/src/app/appBootstrap";
import {
  useAppearanceRuntime,
  useComputedScheme,
} from "../src/renderer/src/app/useAppearanceRuntime";

function Appearance({ mode }: { mode: UiColorScheme }) {
  const computedScheme = useComputedScheme(mode);
  useAppearanceRuntime({
    skin: "studio",
    uiThemeId: "studio",
    colorScheme: mode,
    computedScheme,
    uiFontFamily: "system",
    uiFontSize: 13,
    uiLineHeight: 1.6,
  });
  return null;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.skin;
  delete document.documentElement.dataset.colorScheme;
  document.documentElement.style.removeProperty("color-scheme");
});

it("tracks live system appearance, preserves explicit modes and resynchronizes on return", () => {
  let dark = false;
  const media = new EventTarget();
  Object.defineProperty(media, "matches", { get: () => dark });
  vi.stubGlobal("matchMedia", () => media);
  const changeSystemMode = (next: boolean) => {
    act(() => {
      dark = next;
      media.dispatchEvent(new Event("change"));
    });
  };

  const view = render(<Appearance mode="system" />);
  const root = document.documentElement;
  expect(root.dataset.colorScheme).toBe("light");
  changeSystemMode(true);
  expect(root.dataset.colorScheme).toBe("dark");
  expect(root.style.colorScheme).toBe("dark");

  view.rerender(<Appearance mode="light" />);
  changeSystemMode(false);
  changeSystemMode(true);
  expect(root.dataset.colorScheme).toBe("light");
  expect(root.style.colorScheme).toBe("light");

  view.rerender(<Appearance mode="system" />);
  expect(root.dataset.colorScheme).toBe("dark");
  changeSystemMode(false);
  expect(root.dataset.colorScheme).toBe("light");
});
