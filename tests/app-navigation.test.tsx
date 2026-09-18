// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppNavigation } from "../src/renderer/src/app/useAppNavigation";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("application navigation", () => {
  it("returns to the originating workspace page after changing settings categories", () => {
    const { result } = renderHook(useAppNavigation);
    act(() => result.current.actions.showWorkspacePage("files"));
    act(() => result.current.actions.openSettings("templates"));
    act(() => result.current.actions.selectSettingsCategory("appearance"));
    expect(result.current.location).toEqual({
      area: "settings",
      category: "appearance",
      returnTo: "files",
    });
    act(() => result.current.actions.backToWorkspace());
    expect(result.current.location).toEqual({ area: "workspace", page: "files" });
  });

  it("blocks both chat and settings navigation when file discard is rejected", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { result } = renderHook(useAppNavigation);
    act(() => result.current.actions.showWorkspacePage("files"));
    act(() => result.current.actions.setProjectFilesDirty(true));
    act(() => {
      expect(result.current.actions.showWorkspacePage("chat")).toBe(false);
    });
    act(() => result.current.actions.openSettings("templates"));
    expect(result.current.location).toEqual({ area: "workspace", page: "files" });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(result.current.actions.confirmLeaveProjectFiles()).toBe(false);
  });

  it("does not discard files when clicking the already selected page", () => {
    const confirm = vi.spyOn(window, "confirm");
    const { result } = renderHook(useAppNavigation);
    act(() => result.current.actions.showWorkspacePage("files"));
    act(() => result.current.actions.setProjectFilesDirty(true));
    act(() => {
      expect(result.current.actions.showWorkspacePage("files")).toBe(true);
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("allows confirmed departure and preserves the return page across settings shortcuts", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { result } = renderHook(useAppNavigation);
    act(() => result.current.actions.showWorkspacePage("files"));
    act(() => result.current.actions.setProjectFilesDirty(true));
    act(() => result.current.actions.openSettings());
    act(() => result.current.actions.openSettings("templates"));
    expect(result.current.location).toEqual({
      area: "settings",
      category: "templates",
      returnTo: "files",
    });
  });

  it("ignores settings category events while in the workspace", () => {
    const { result } = renderHook(useAppNavigation);
    act(() => result.current.actions.selectSettingsCategory("data"));
    act(() => result.current.actions.backToWorkspace());
    expect(result.current.location).toEqual({ area: "workspace", page: "chat" });
  });
});
