// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkbenchLayout } from "../app/renderer/src/app/useWorkbenchLayout";

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

  it("preserves an explicit width change across later container resizes", () => {
    const { result } = mountLayout();
    resizeContainer(900);
    act(() => result.current.secondaryResize.onValueChange(312.8));
    resizeContainer(700);
    expect(result.current.secondaryResize.value).toBeLessThan(312.8);
    expect(Number(window.localStorage.getItem("agent-ppt:secondary-pane-width"))).toBeCloseTo(
      312.8,
    );
    resizeContainer(1300);
    expect(result.current.secondaryResize.value).toBeCloseTo(312.8);
  });
});
