// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SlidePreviewGallery } from "../src/renderer/src/components/SlidePreviewGallery";
import type { DisplayEvent } from "../src/shared/card-display-protocol";

type SlidePreviewEvent = Extract<DisplayEvent, { kind: "artifact.slide-preview" }>;

function preview(index: number): SlidePreviewEvent {
  return {
    protocolVersion: 1,
    eventId: `preview-${index}`,
    emittedAt: "2026-07-25T00:00:00.000Z",
    kind: "artifact.slide-preview",
    category: "artifact",
    source: { kind: "tool", toolName: "PreviewSlide", toolCallId: `call-${index}` },
    scope: { sessionId: "session-1", runId: "run-1" },
    semantics: { blocking: false, requiresResponse: false, priority: "normal" },
    payload: {
      slideId: `slide-${index}`,
      title: `第 ${index} 页`,
      description: `页面 ${index} 的结构摘要`,
      thumbnail: {
        pngBase64: "aGVsbG8=",
        width: 640,
        height: 360,
        mimeType: "image/png",
      },
    },
  };
}

afterEach(cleanup);

describe("SlidePreviewGallery", () => {
  it("groups previews and opens one focused preview", () => {
    render(<SlidePreviewGallery previews={[preview(1), preview(2), preview(3), preview(4)]} />);

    expect(screen.getByText("已检查 4 页")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /查看 第 \d 页 大图/ })).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "查看 第 2 页 大图" }));
    expect(screen.getByRole("dialog", { name: "第 2 页 页面预览" })).not.toBeNull();
    expect(screen.getByText("2 / 4")).not.toBeNull();
  });

  it("returns focus to the opening thumbnail after Escape", () => {
    render(<SlidePreviewGallery previews={[preview(1), preview(2)]} />);
    const opener = screen.getByRole("button", { name: "查看 第 2 页 大图" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("keeps keyboard focus in navigation when its active arrow reaches an endpoint", () => {
    render(<SlidePreviewGallery previews={[preview(1), preview(2), preview(3)]} />);
    const opener = screen.getByRole("button", { name: "查看 第 1 页 大图" });
    opener.focus();
    fireEvent.click(opener);
    const next = screen.getByRole("button", { name: "下一张检查预览" });
    next.focus();
    fireEvent.click(next);
    expect(document.activeElement).toBe(next);
    fireEvent.click(next);
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "页面导航" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("uses the injected live surface while retaining screenshot fallback", () => {
    const { rerender } = render(
      <SlidePreviewGallery previews={[preview(1)]} renderSlide={() => <div>实时幻灯片</div>} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看 第 1 页 大图" }));
    expect(screen.getByText("实时幻灯片")).not.toBeNull();
    expect(screen.queryByRole("img", { name: "第 1 页 页面预览" })).toBeNull();
    rerender(<SlidePreviewGallery previews={[preview(1)]} renderSlide={() => null} />);
    expect(screen.getByRole("img", { name: "第 1 页 页面预览" }).getAttribute("src")).toBe(
      "data:image/png;base64,aGVsbG8=",
    );
  });

  it("skips unavailable screenshots with keyboard navigation and disables the real endpoints", () => {
    const missing = {
      ...preview(2),
      payload: { ...preview(2).payload, thumbnail: undefined, thumbnailError: "Unavailable" },
    };
    render(<SlidePreviewGallery previews={[preview(1), missing, preview(3)]} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "第 2 页" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "查看 第 1 页 大图" }));
    const navigation = screen.getByRole("group", { name: "页面导航" });
    expect(navigation).not.toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "上一张检查预览" }).disabled).toBe(
      true,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "第 3 页 页面预览" })).not.toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "下一张检查预览" }).disabled).toBe(
      true,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
    expect(screen.getByRole("dialog", { name: "第 1 页 页面预览" })).not.toBeNull();
  });

  it("exposes the selected slide independently of the enlarged preview", () => {
    render(<SlidePreviewGallery previews={[preview(1), preview(2)]} selectedSlideId="slide-2" />);
    expect(
      screen.getByRole("button", { name: "查看 第 2 页 大图", current: "page" }),
    ).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
