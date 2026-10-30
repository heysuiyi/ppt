// @vitest-environment jsdom

import { splitGraphemes } from "@shared/streaming-text";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView } from "../src/renderer/src/components/markdown/MarkdownView";
import { createOpenExportFolderHref } from "../src/shared/export-links";

function installMotionPreference(initial: boolean) {
  let reduced = initial;
  const media = new EventTarget();
  Object.defineProperty(media, "matches", { get: () => reduced });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => media),
  });
  return (value: boolean) => {
    reduced = value;
    media.dispatchEvent(new Event("change"));
  };
}

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function visibleText(container: HTMLElement) {
  return container.querySelector(".markdown-body")?.textContent ?? "";
}

function advance(milliseconds: number) {
  act(() => vi.advanceTimersByTime(milliseconds));
}

describe("MarkdownView release lifecycle", () => {
  let changeMotion: (value: boolean) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    changeMotion = installMotionPreference(false);
    setVisibility("visible");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders restored history immediately without scheduling release work", () => {
    const timeout = vi.spyOn(window, "setTimeout");
    const interval = vi.spyOn(window, "setInterval");
    const view = render(
      <MarkdownView
        documentId="history"
        content="Saved **reply** with [a link](https://example.com)."
      />,
    );

    expect(visibleText(view.container)).toBe("Saved reply with a link.");
    expect(view.getByText("reply").tagName).toBe("STRONG");
    expect(view.getByRole("link", { name: "a link" }).getAttribute("href")).toBe(
      "https://example.com",
    );
    expect(view.container.querySelector(".markdown-body")?.getAttribute("aria-busy")).not.toBe(
      "true",
    );
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  });

  it("clears a static document when its source becomes empty", () => {
    const view = render(<MarkdownView documentId="history" content="Old **history**" />);
    view.rerender(<MarkdownView documentId="history" content="" />);
    advance(5_000);

    expect(visibleText(view.container)).toBe("");
    expect(view.queryByText("history")).toBeNull();
  });

  it("progressively releases a live reply already committed before its first mount", () => {
    const content = "Committed reply with complete Unicode 中A👩‍💻e\u0301. ".repeat(20);
    const view = render(
      <MarkdownView documentId="fast-reply" content={content} mode="live" streaming={false} />,
    );

    expect(visibleText(view.container)).toBe("");
    advance(120);
    const partial = visibleText(view.container);
    expect(partial.startsWith("Committed")).toBe(true);
    expect(content.startsWith(partial)).toBe(true);
    expect(partial.length).toBeLessThan(content.length);
    advance(30_000);
    expect(visibleText(view.container)).toBe(content.trimEnd());
  });

  it("does not starve release while prop chunks arrive faster than the display clock", () => {
    const content = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const view = render(<MarkdownView documentId="chunks" content="" mode="live" streaming />);

    for (let end = 1; end <= content.length; end += 1) {
      view.rerender(
        <MarkdownView documentId="chunks" content={content.slice(0, end)} mode="live" streaming />,
      );
      advance(5);
    }

    expect(visibleText(view.container).startsWith("ABCD")).toBe(true);
    expect(content.startsWith(visibleText(view.container))).toBe(true);
    view.rerender(
      <MarkdownView documentId="chunks" content={content} mode="live" streaming={false} />,
    );
    advance(30_000);
    expect(visibleText(view.container)).toBe(content);
  });

  it("releases whole graphemes and drains backlog when upstream ends or mode becomes static", () => {
    const units = splitGraphemes("中A👩‍💻e\u0301");
    const content = units.join("").repeat(80);
    const boundaries = new Set([""]);
    let prefix = "";
    for (const grapheme of splitGraphemes(content)) {
      prefix += grapheme;
      boundaries.add(prefix);
    }
    const view = render(
      <MarkdownView documentId="drain" content={content} mode="live" streaming />,
    );
    advance(120);
    expect(visibleText(view.container).startsWith("中A")).toBe(true);
    expect(boundaries.has(visibleText(view.container))).toBe(true);
    expect(visibleText(view.container).length).toBeLessThan(content.length);

    view.rerender(
      <MarkdownView documentId="drain" content={content} mode="static" streaming={false} />,
    );
    expect(visibleText(view.container).length).toBeLessThan(content.length);
    expect(boundaries.has(visibleText(view.container))).toBe(true);
    advance(30_000);
    expect(visibleText(view.container)).toBe(content);
    expect(view.container.querySelector(".markdown-body")?.getAttribute("aria-busy")).not.toBe(
      "true",
    );
  });

  it("keeps visible text and selection in the same native document when streaming completes", () => {
    const content = "Stable selected paragraph.\n\nA completed **reply**.";
    const view = render(
      <MarkdownView documentId="completion" content={content} mode="live" streaming />,
    );
    advance(30_000);
    const host = view.container.querySelector(".markdown-body")!;
    const paragraph = host.querySelector("p")!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 7);
    range.setEnd(paragraph.firstChild!, 15);
    selection.addRange(range);

    view.rerender(
      <MarkdownView documentId="completion" content={content} mode="static" streaming={false} />,
    );

    expect(view.container.querySelector(".markdown-body")).toBe(host);
    expect(host.querySelector("p")).toBe(paragraph);
    expect(host.textContent).toBe("Stable selected paragraph.\nA completed reply.");
    expect(selection.toString()).toBe("selected");
    expect(view.container.querySelector(".markdown-ink-caret")).toBeNull();
    expect(host.parentElement?.getAttribute("data-chat-scroll-anchor")).toBe("markdown:completion");
    advance(1_000);
    expect(host.textContent).toBe("Stable selected paragraph.\nA completed reply.");
    expect(selection.toString()).toBe("selected");
    selection.removeAllRanges();
  });

  it("resets release state on document identity changes without stale writes", () => {
    const view = render(
      <MarkdownView documentId="old" content={"Old response ".repeat(100)} mode="live" streaming />,
    );
    advance(100);
    view.rerender(<MarkdownView documentId="restored" content="New saved document" />);
    expect(visibleText(view.container)).toBe("New saved document");
    advance(30_000);
    expect(visibleText(view.container)).toBe("New saved document");

    view.rerender(
      <MarkdownView documentId="new-live" content="Fresh reply" mode="live" streaming={false} />,
    );
    expect(visibleText(view.container)).toBe("");
    advance(30_000);
    expect(visibleText(view.container)).toBe("Fresh reply");
  });

  it("reconciles a rewritten live source instead of retaining its old queued suffix", () => {
    const view = render(
      <MarkdownView
        documentId="rewrite"
        content={"Wrong answer ".repeat(100)}
        mode="live"
        streaming
      />,
    );
    advance(100);
    view.rerender(
      <MarkdownView documentId="rewrite" content="Correct answer" mode="live" streaming={false} />,
    );
    advance(30_000);
    expect(visibleText(view.container)).toBe("Correct answer");
  });

  it("shows reduced-motion replies immediately and reacts to preference changes", () => {
    act(() => changeMotion(true));
    const view = render(
      <MarkdownView documentId="reduced" content="Immediate reply" mode="live" streaming />,
    );
    expect(visibleText(view.container)).toBe("Immediate reply");

    act(() => changeMotion(false));
    view.rerender(
      <MarkdownView
        documentId="motion-change"
        content={"Pending reply ".repeat(40)}
        mode="live"
        streaming
      />,
    );
    advance(100);
    act(() => changeMotion(true));
    expect(visibleText(view.container)).toBe("Pending reply ".repeat(40).trimEnd());
  });

  it("pauses unreleased text while hidden and resumes the complete buffer when visible", () => {
    act(() => setVisibility("hidden"));
    const content = "Background reply that must not be lost";
    const view = render(
      <MarkdownView documentId="background" content={content} mode="live" streaming />,
    );
    advance(1_000);
    expect(visibleText(view.container)).toBe("");
    view.rerender(
      <MarkdownView documentId="background" content={content} mode="live" streaming={false} />,
    );
    advance(1_000);
    expect(visibleText(view.container)).toBe("");

    act(() => setVisibility("visible"));
    advance(30_000);
    expect(visibleText(view.container)).toBe(content);
  });

  it("disposes its owned subtree and prevents detached-host writes after unmount", () => {
    const view = render(
      <MarkdownView
        documentId="unmount"
        content={"Pending reply ".repeat(100)}
        mode="live"
        streaming
      />,
    );
    advance(100);
    const host = view.container.querySelector(".markdown-body")!;
    view.unmount();
    advance(30_000);
    expect(host.textContent).toBe("");
  });

  it("opens the decoded export file location when the rendered export link is clicked", () => {
    const openExportFolder = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("desktopApi", { openExportFolder });
    const filePath = "C:\\Users\\me\\Documents\\AI 演示\\final deck.pptx";
    const href = createOpenExportFolderHref(filePath);
    const view = render(<MarkdownView documentId="export" content={`[打开导出目录](${href})`} />);

    const link = view.getByRole("link", { name: "打开导出目录" });
    expect(link.getAttribute("href")).toBe(href);
    expect(fireEvent.click(link)).toBe(false);
    expect(openExportFolder).toHaveBeenCalledExactlyOnceWith(filePath);
  });
});
