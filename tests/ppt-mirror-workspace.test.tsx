// @vitest-environment jsdom

import {
  clearAllDisplayCardManagers,
  ingestDisplayEvent,
} from "@shared/cards/display-card-managers";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDeckExport } from "../app/renderer/src/app/presentation/useDeckExport";
import { ArtifactCardHost } from "../app/renderer/src/cards/hosts/ArtifactCardHost";
import { PPTMirror } from "../app/renderer/src/components/PPTMirror";
import { DEFAULT_DESIGN_SYSTEM } from "../src/design-system";
import type { DisplayEvent } from "../src/shared/card-display-protocol";
import type { Presentation } from "../src/shared/presentation";
import { createSvgTestSlide } from "../src/shared/presentation-fixtures";

type SlidePreviewEvent = Extract<DisplayEvent, { kind: "artifact.slide-preview" }>;

const presentation: Presentation = {
  id: "deck-1",
  title: "右侧预览升级",
  revision: 2,
  designSystem: DEFAULT_DESIGN_SYSTEM,
  slides: [
    createSvgTestSlide({ id: "slide-1", title: "封面", sourcePath: "slides/svg/P01.svg" }),
    createSvgTestSlide({ id: "slide-2", title: "核心结论", sourcePath: "slides/svg/P02.svg" }),
  ],
};

function preview(index: number): SlidePreviewEvent {
  return {
    protocolVersion: 1,
    eventId: `preview-${index}`,
    emittedAt: "2026-07-26T00:00:00.000Z",
    kind: "artifact.slide-preview",
    category: "artifact",
    source: { kind: "tool", toolName: "PreviewSvgPage", toolCallId: `call-${index}` },
    scope: { sessionId: "session-1", runId: "run-1" },
    semantics: { blocking: false, requiresResponse: false, priority: "normal" },
    payload: {
      slideId: `slide-${index}`,
      title: index === 1 ? "封面" : "核心结论",
      description: `第 ${index} 页检查说明`,
      thumbnail: {
        pngBase64: "aGVsbG8=",
        width: 640,
        height: 360,
        mimeType: "image/png",
      },
    },
  };
}

function MirrorHarness() {
  const [selectedSlideId, setSelectedSlideId] = useState("slide-1");
  const { isExportingDeck, exportDeck } = useDeckExport({ sessionId: "session-1", presentation });
  return (
    <>
      <input aria-label="聊天输入" />
      <button disabled={isExportingDeck} onClick={() => void exportDeck(() => undefined)}>
        聊天导出
      </button>
      <PPTMirror
        isExporting={isExportingDeck}
        onExport={() => void exportDeck(() => undefined)}
        presentation={presentation}
        selectedSlideId={selectedSlideId}
        onSelectSlide={setSelectedSlideId}
        onCloseMirror={() => undefined}
        highlightSlideId={null}
      />
    </>
  );
}

describe("PPTMirror preview workspace", () => {
  const exportPresentation = vi.fn(async () => null);

  beforeEach(() => {
    clearAllDisplayCardManagers();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { exportPresentation },
    });
    Object.defineProperty(window, "confirm", {
      configurable: true,
      value: vi.fn(() => true),
    });
    exportPresentation.mockClear();
    ingestDisplayEvent(preview(1));
    ingestDisplayEvent(preview(2));
  });

  afterEach(() => {
    cleanup();
    clearAllDisplayCardManagers();
    vi.unstubAllGlobals();
  });

  it("hosts the latest inspection batch in the right preview and syncs page selection", () => {
    render(<MirrorHarness />);

    expect(screen.getByText("PPT 预览")).not.toBeNull();
    expect(screen.getByRole("tab", { name: /检查结果\s*2/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByText(/覆盖 2 \/ 2 /)).not.toBeNull();
    expect(screen.queryByText("点击查看大图")).toBeNull();
    expect(screen.queryByText("页面预览")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看 核心结论 大图" }));
    expect(screen.getByRole("dialog", { name: "核心结论 页面预览" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));

    fireEvent.click(screen.getByRole("tab", { name: /幻灯片\s*2/ }));
    expect(screen.getByRole("button", { name: "放大查看第 2 页：核心结论" })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "选择第 2 页：核心结论" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("surfaces new inspection batches without stealing chat focus or resurfacing the same batch", () => {
    clearAllDisplayCardManagers();
    render(<MirrorHarness />);
    const slidesTab = screen.getByRole("tab", { name: /幻灯片\s*2/ });
    const inspectionTab = screen.getByRole("tab", { name: /检查结果\s*0/ });
    expect(slidesTab.getAttribute("aria-selected")).toBe("true");
    expect((inspectionTab as HTMLButtonElement).disabled).toBe(true);
    const chatInput = screen.getByRole("textbox", { name: "聊天输入" });
    act(() => chatInput.focus());

    act(() => ingestDisplayEvent(preview(1)));
    expect(document.activeElement).toBe(chatInput);
    expect(screen.getByRole("tab", { name: /检查结果\s*1/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "查看 封面 大图" })).not.toBeNull();
    fireEvent.click(slidesTab);
    act(() => chatInput.focus());
    act(() => ingestDisplayEvent({ ...preview(1), eventId: "preview-1-recheck" }));
    expect(slidesTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(chatInput);

    act(() =>
      ingestDisplayEvent({
        ...preview(2),
        eventId: "preview-next-run",
        scope: { sessionId: "session-1", runId: "run-2" },
      }),
    );
    expect(document.activeElement).toBe(chatInput);
    expect(screen.getByRole("tab", { name: /检查结果\s*1/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "查看 核心结论 大图" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "查看 封面 大图" })).toBeNull();
  });

  it("returns to slides when inspections clear and keeps focus local only when necessary", () => {
    render(<MirrorHarness />);
    const inspectionTab = screen.getByRole("tab", { name: /检查结果\s*2/ });
    act(() => inspectionTab.focus());
    act(() => clearAllDisplayCardManagers());
    const slidesTab = screen.getByRole("tab", { name: /幻灯片\s*2/ });
    expect(slidesTab.getAttribute("aria-selected")).toBe("true");
    expect(slidesTab.tabIndex).toBe(0);
    expect(document.activeElement).toBe(slidesTab);
    expect(screen.getByRole("tab", { name: /检查结果\s*0/ }).tabIndex).toBe(-1);
    expect(screen.getByRole("button", { name: "选择第 1 页：封面" })).not.toBeNull();
    fireEvent.keyDown(slidesTab, { key: "ArrowRight" });
    expect(document.activeElement).toBe(slidesTab);
    expect(slidesTab.getAttribute("aria-selected")).toBe("true");

    const chatInput = screen.getByRole("textbox", { name: "聊天输入" });
    act(() => chatInput.focus());
    act(() => ingestDisplayEvent(preview(1)));
    expect(screen.getByRole("tab", { name: /检查结果\s*1/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    act(() => clearAllDisplayCardManagers());
    expect(document.activeElement).toBe(chatInput);
    expect(slidesTab.getAttribute("aria-selected")).toBe("true");
  });

  it("switches panels with the keyboard while preserving the outer scroll viewport", () => {
    render(<MirrorHarness />);
    const slidesTab = screen.getByRole("tab", { name: /幻灯片\s*2/ });
    const inspectionTab = screen.getByRole("tab", { name: /检查结果\s*2/ });
    const inspectionPanel = screen.getByRole("tabpanel");
    const viewport = inspectionPanel.parentElement!;
    viewport.scrollTop = 72;
    expect(inspectionPanel.id).toBe(inspectionTab.getAttribute("aria-controls"));
    expect(inspectionPanel.getAttribute("aria-labelledby")).toBe(inspectionTab.id);
    act(() => inspectionTab.focus());
    fireEvent.keyDown(inspectionTab, { key: "ArrowRight" });
    expect(document.activeElement).toBe(slidesTab);
    expect(slidesTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "选择第 1 页：封面" })).not.toBeNull();
    const slidesPanel = screen.getByRole("tabpanel");
    expect(slidesPanel.id).toBe(slidesTab.getAttribute("aria-controls"));
    expect(slidesPanel.parentElement).toBe(viewport);
    expect(viewport.scrollTop).toBe(72);
    expect(inspectionPanel.hidden).toBe(true);
    expect(inspectionPanel.childNodes.length).toBe(0);

    fireEvent.keyDown(slidesTab, { key: "End" });
    expect(document.activeElement).toBe(inspectionTab);
    expect(screen.getByRole("tabpanel")).toBe(inspectionPanel);
    expect(inspectionPanel.parentElement).toBe(viewport);
    fireEvent.keyDown(inspectionTab, { key: "Home" });
    expect(document.activeElement).toBe(slidesTab);
    fireEvent.keyDown(slidesTab, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(inspectionTab);
    expect(inspectionTab.getAttribute("aria-selected")).toBe("true");
  });

  it("fits slideshow width to the available container and disconnects on close", () => {
    let resize: ResizeObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    render(<MirrorHarness />);
    fireEvent.click(screen.getByRole("button", { name: "放映演示文稿" }));

    const slide = document.querySelector<HTMLElement>(
      ".slideshow-lightbox-content .slide-viewport",
    )!;
    const resizeContainer = (width: number, height: number) => {
      act(() => {
        resize([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver);
      });
    };

    resizeContainer(1000, 360);
    expect(slide.style.width).toBe("640px");

    resizeContainer(480, 600);
    expect(slide.style.width).toBe("480px");

    resizeContainer(1440, 810);
    expect(slide.style.width).toBe("1440px");

    fireEvent.click(screen.getByRole("button", { name: /关闭放映/ }));
    expect(disconnect).toHaveBeenCalledOnce();
    expect(document.querySelector(".slideshow-lightbox-overlay")).toBeNull();
  });

  it("exports by session id without uploading the renderer presentation snapshot", async () => {
    render(<MirrorHarness />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "下载 PPT" }));
    });

    expect(exportPresentation).toHaveBeenCalledWith("session-1", {
      allowUnverifiedAssets: false,
    });
    expect(exportPresentation).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "deck-1" }),
      expect.anything(),
    );
  });

  it("shares the export lock across preview and chat entrances", async () => {
    const pending = Promise.withResolvers<null>();
    exportPresentation.mockReturnValueOnce(pending.promise);
    render(<MirrorHarness />);
    fireEvent.click(screen.getByRole("button", { name: "下载 PPT" }));
    expect(screen.getByRole("button", { name: "下载 PPT" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "聊天导出" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "聊天导出" }));
    expect(exportPresentation).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(null));
    expect(screen.getByRole("button", { name: "下载 PPT" }).hasAttribute("disabled")).toBe(false);
  });

  it("does not render inspection previews in the chat artifact host", () => {
    render(
      <ArtifactCardHost
        presentation={presentation}
        busy={false}
        onReviseOutline={() => undefined}
        onOpenDeckPreview={() => undefined}
        onExportDeck={() => undefined}
      />,
    );

    expect(screen.queryByText("页面预览")).toBeNull();
    expect(screen.queryByText(/已检.*2/)).toBeNull();
  });
});
