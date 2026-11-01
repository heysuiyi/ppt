// @vitest-environment jsdom

import { CATNIP_UI_THEME_ID, DEFAULT_UI_THEME_ID } from "@shared/ui-themes";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyUserUiThemeCss,
  getBuiltinUiThemeCss,
  normalizePersistedUiThemeId,
  USER_UI_THEME_STYLE_ID,
} from "../app/renderer/src/app/userUiTheme";

describe("user UI theme helpers", () => {
  afterEach(() => {
    document.getElementById(USER_UI_THEME_STYLE_ID)?.remove();
  });

  it("normalizes missing or invalid persisted ids to studio", () => {
    expect(normalizePersistedUiThemeId(undefined)).toBe(DEFAULT_UI_THEME_ID);
    expect(normalizePersistedUiThemeId("")).toBe(DEFAULT_UI_THEME_ID);
    expect(normalizePersistedUiThemeId("studio")).toBe(DEFAULT_UI_THEME_ID);
  });

  it("keeps bundled theme ids even when they are absent from the user directory", () => {
    expect(normalizePersistedUiThemeId(CATNIP_UI_THEME_ID, new Set(["example"]))).toBe(
      CATNIP_UI_THEME_ID,
    );
    expect(getBuiltinUiThemeCss(DEFAULT_UI_THEME_ID)).toBeNull();
    // Vitest stubs CSS modules to an empty string; the production Vite build
    // resolves the ?raw import to the bundled stylesheet text.
    expect(getBuiltinUiThemeCss(CATNIP_UI_THEME_ID)).toBeTypeOf("string");
    expect(getBuiltinUiThemeCss("example")).toBeUndefined();
  });

  it("keeps custom ids until an availability set proves they are gone", () => {
    expect(normalizePersistedUiThemeId("midnight")).toBe("midnight");
    expect(normalizePersistedUiThemeId("midnight", new Set(["example"]))).toBe(DEFAULT_UI_THEME_ID);
    expect(normalizePersistedUiThemeId("example", new Set(["example"]))).toBe("example");
  });

  it("injects and removes the user theme style element", () => {
    applyUserUiThemeCss(":root { --surface-canvas: #010203; }");
    const injected = document.getElementById(USER_UI_THEME_STYLE_ID);
    expect(injected).toBeInstanceOf(HTMLStyleElement);
    expect(injected?.textContent).toContain("--surface-canvas");

    applyUserUiThemeCss(":root { --surface-canvas: #abcdef; }");
    expect(document.querySelectorAll(`#${USER_UI_THEME_STYLE_ID}`)).toHaveLength(1);
    expect(document.getElementById(USER_UI_THEME_STYLE_ID)?.textContent).toContain("#abcdef");

    applyUserUiThemeCss(null);
    expect(document.getElementById(USER_UI_THEME_STYLE_ID)).toBeNull();
  });
});
