import { getOpenExportFolderPath } from "@shared/export-links";
import { useLayoutEffect, useRef } from "react";
import { useMarkdownCaret } from "./useMarkdownCaret";
import { type MarkdownStreamOptions, useMarkdownStream } from "./useMarkdownStream";

export interface MarkdownViewProps extends MarkdownStreamOptions {
  className?: string;
}

export function MarkdownView({
  documentId,
  content,
  mode = "static",
  streaming = false,
  className,
}: MarkdownViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLSpanElement>(null);
  const { busy, showCaret, liveOrigin, completed } = useMarkdownStream(hostRef, {
    documentId,
    content,
    mode,
    streaming,
  });
  useMarkdownCaret(hostRef, caretRef, showCaret);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const openExportFolder = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!anchor || !host.contains(anchor)) return;
      const exportFilePath = getOpenExportFolderPath(anchor.getAttribute("href") ?? undefined);
      if (!exportFilePath) return;
      event.preventDefault();
      void window.desktopApi.openExportFolder(exportFilePath).catch((error) => {
        console.error("打开导出目录失败:", error);
      });
    };
    host.addEventListener("click", openExportFolder);
    return () => host.removeEventListener("click", openExportFolder);
  }, []);

  return (
    <div className="markdown-view" data-chat-scroll-anchor={`markdown:${documentId}`}>
      {/* React owns this empty host; MarkdownRenderer exclusively owns its descendants. */}
      <div
        ref={hostRef}
        className={`markdown-body markdown-view-host${className ? ` ${className}` : ""}`}
        aria-busy={busy}
      />
      {showCaret && <span ref={caretRef} className="markdown-ink-caret" aria-hidden="true" />}
      {liveOrigin && (
        <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {completed ? "输出已结束" : ""}
        </span>
      )}
    </div>
  );
}
