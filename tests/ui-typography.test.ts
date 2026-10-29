// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  applyUiTypography,
  DEFAULT_UI_FONT_FAMILY,
  DEFAULT_UI_FONT_SIZE,
  DEFAULT_UI_LINE_HEIGHT,
  MAX_UI_FONT_SIZE,
  MIN_UI_LINE_HEIGHT,
  normalizePersistedUiFontFamily,
  normalizePersistedUiFontSize,
  normalizePersistedUiLineHeight,
} from "../src/renderer/src/app/uiTypography";

describe("ui typography helpers", () => {
  afterEach(() => {
    applyUiTypography(DEFAULT_UI_FONT_FAMILY, DEFAULT_UI_FONT_SIZE, DEFAULT_UI_LINE_HEIGHT);
  });

  it("normalizes invalid persisted font family", () => {
    expect(normalizePersistedUiFontFamily(undefined)).toBe("system");
    expect(normalizePersistedUiFontFamily("comic")).toBe("system");
    expect(normalizePersistedUiFontFamily("yahei")).toBe("yahei");
  });

  it("clamps font size and line height into supported ranges", () => {
    expect(normalizePersistedUiFontSize(undefined)).toBe(DEFAULT_UI_FONT_SIZE);
    expect(normalizePersistedUiFontSize("not a number")).toBe(DEFAULT_UI_FONT_SIZE);
    expect(normalizePersistedUiFontSize("14.5")).toBe(14.5);
    expect(normalizePersistedUiFontSize(999)).toBe(MAX_UI_FONT_SIZE);

    expect(normalizePersistedUiLineHeight(undefined)).toBe(DEFAULT_UI_LINE_HEIGHT);
    expect(normalizePersistedUiLineHeight("1.8")).toBe(1.8);
    expect(normalizePersistedUiLineHeight(0.4)).toBe(MIN_UI_LINE_HEIGHT);
  });

  it("scales the whole text ladder from base size and leading", () => {
    applyUiTypography("yahei", 26, 1.6);
    const style = document.documentElement.style;

    expect(style.getPropertyValue("--font-body")).toContain("Microsoft YaHei UI");
    // 26px base is exactly 2x the 13px default, so every step doubles.
    expect(style.getPropertyValue("--text-base")).toBe("26px");
    expect(style.getPropertyValue("--text-base-lh")).toBe("42px");
    expect(style.getPropertyValue("--text-2xs")).toBe("20px");
    expect(style.getPropertyValue("--text-2xl")).toBe("48px");
  });

  it("applies the leading multiplier without changing sizes", () => {
    applyUiTypography("system", DEFAULT_UI_FONT_SIZE, 3.2);
    const style = document.documentElement.style;

    expect(style.getPropertyValue("--text-base")).toBe("13px");
    // 3.2 is 2x the 1.6 default leading.
    expect(style.getPropertyValue("--text-base-lh")).toBe("42px");
  });

  it("removes inline overrides when returning to defaults", () => {
    applyUiTypography("segoe", 15, 1.8);
    applyUiTypography(DEFAULT_UI_FONT_FAMILY, DEFAULT_UI_FONT_SIZE, DEFAULT_UI_LINE_HEIGHT);
    const style = document.documentElement.style;

    expect(style.getPropertyValue("--font-body")).toBe("");
    expect(style.getPropertyValue("--font-display")).toBe("");
    expect(style.getPropertyValue("--text-base")).toBe("");
    expect(style.getPropertyValue("--text-base-lh")).toBe("");
  });

  it("restores theme typography after a personal override without replacing defaults", () => {
    const theme = document.createElement("style");
    theme.textContent = ":root { --text-base: 17px; --text-base-lh: 28px; }";
    document.head.append(theme);
    try {
      applyUiTypography("system", 20, 2);
      expect(getComputedStyle(document.documentElement).getPropertyValue("--text-base")).toBe(
        "20px",
      );
      applyUiTypography(DEFAULT_UI_FONT_FAMILY, DEFAULT_UI_FONT_SIZE, DEFAULT_UI_LINE_HEIGHT);
      expect(getComputedStyle(document.documentElement).getPropertyValue("--text-base")).toBe(
        "17px",
      );
      expect(getComputedStyle(document.documentElement).getPropertyValue("--text-base-lh")).toBe(
        "28px",
      );
    } finally {
      theme.remove();
    }
    expect(getComputedStyle(document.documentElement).getPropertyValue("--text-base")).toBe(
      `${DEFAULT_UI_FONT_SIZE}px`,
    );
  });
});
