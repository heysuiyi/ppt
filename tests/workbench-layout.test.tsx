// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkbenchLayout } from "../src/renderer/src/app/useWorkbenchLayout";

let resize: ResizeObserverCallback;

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mountLayout() {
  const hook = renderHook(() =>
    useWorkbenchLayout({
      location: { area: "workspace", page: "chat" },
      previewOpen: true,
      previewExpanded: false,
    }),
  );
  act(() => hook.result.current.workspaceRef(document.createElement("div")));
  return hook;
}

function resizeContainer(width: number) {
  act(() => {
    resize([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
  });
}

describe("container-driven workbench layout", () => {
  it("fits a resized container without overwriting the user's preferred preview width", () => {
    const { result } = mountLayout();
    resizeContainer(1300);
    expect(result.current.isPrimarySidebarCollapsed).toBe(false);
    expect(
      result.current.workspaceStyle[
        "--secondary-pane-width" as keyof typeof result.current.workspaceStyle
      ],
    ).toBe("380px");

    resizeContainer(900);
    expect(result.current.isPrimarySidebarCollapsed).toBe(true);
    const fittedWidth = Number.parseFloat(
      String(
        result.current.workspaceStyle[
          "--secondary-pane-width" as keyof typeof result.current.workspaceStyle
        ],
      ),
    );
    expect(fittedWidth).toBeCloseTo(332.8);
    expect(window.localStorage.getItem("agent-ppt:secondary-pane-width")).toBe("380");

    resizeContainer(1300);
    expect(
      result.current.workspaceStyle[
        "--secondary-pane-width" as keyof typeof result.current.workspaceStyle
      ],
    ).toBe("380px");
  });

  it("starts dragging from the fitted width rather than the larger saved preference", () => {
    const { result } = mountLayout();
    resizeContainer(900);
    act(() => result.current.startPanelResize("secondary", 500));
    act(() => window.dispatchEvent(new MouseEvent("pointermove", { clientX: 520 })));
    expect(Number(window.localStorage.getItem("agent-ppt:secondary-pane-width"))).toBeCloseTo(
      312.8,
    );
    act(() => window.dispatchEvent(new Event("pointerup")));
    expect(document.documentElement.classList.contains("is-resizing-panels")).toBe(false);
  });

  it("stops an active drag when the layout unmounts", () => {
    const { result, unmount } = mountLayout();
    resizeContainer(1300);
    act(() => result.current.startPanelResize("secondary", 500));
    unmount();
    expect(document.documentElement.classList.contains("is-resizing-panels")).toBe(false);
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 400 }));
    expect(window.localStorage.getItem("agent-ppt:secondary-pane-width")).toBe("380");
  });
});
