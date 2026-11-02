import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../ui/components/button/Button";
import { Markdown } from "../ui/components/markdown/Markdown";
import "./desktop-message.css";

type CopyStatus = "idle" | "pending" | "copied" | "failed";

const copyFeedback: Record<CopyStatus, string> = {
  idle: "",
  pending: "正在复制…",
  copied: "已复制到剪贴板",
  failed: "复制失败，请重试",
};

function reasoningPreview(text: string, streaming: boolean): string {
  const lines = text.split(/\r?\n/);
  // Wait for a completed line rather than changing the preview for every token.
  if (streaming) lines.pop();
  return (lines.find((line) => line.trim() !== "") ?? "").replace(/\*\*/g, "").trim();
}

export function DesktopMessage({
  role,
  text,
  streaming = false,
}: {
  role: "user" | "assistant" | "reasoning";
  text: string;
  streaming?: boolean;
}) {
  const statusId = useId();
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const copyEpoch = useRef(0);
  const copyPending = useRef(false);

  useLayoutEffect(() => {
    copyEpoch.current += 1;
    copyPending.current = false;
    setCopyStatus("idle");
    return () => {
      // Ignore clipboard results for a replaced message or an unmounted component.
      copyEpoch.current += 1;
      copyPending.current = false;
    };
  }, [role, text, streaming]);

  async function copyMessage() {
    if (streaming || copyPending.current) return;
    const epoch = copyEpoch.current;
    copyPending.current = true;
    setCopyStatus("pending");
    try {
      await navigator.clipboard.writeText(text);
      if (epoch === copyEpoch.current) setCopyStatus("copied");
    } catch {
      if (epoch === copyEpoch.current) setCopyStatus("failed");
    } finally {
      if (epoch === copyEpoch.current) copyPending.current = false;
    }
  }

  if (role === "reasoning") {
    const preview = reasoningPreview(text, streaming);
    return (
      <details
        className="desktop-reasoning desktop-message-reasoning"
        data-streaming={streaming || undefined}
      >
        <summary aria-label={streaming ? "思考（正在进行）" : "思考"} aria-live="off">
          <svg
            className="desktop-message-reasoning__icon"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 8c0-3 3-5 5.5-3.5L18 10c3 2 2 6-1 6-1.5 0-2.5-1-2.5-2.5S16 11 17.5 11" />
            <path d="M20 16c0 3-3 5-5.5 3.5L6 14c-3-2-2-6 1-6 1.5 0 2.5 1 2.5 2.5S8 13 6.5 13" />
            <path d="m10 8 4 8" />
          </svg>
          <span className="desktop-message-reasoning__title">思考</span>
          {(preview || streaming) && (
            <span className="desktop-message-reasoning__preview" aria-hidden="true">
              <span className="desktop-message-reasoning__separator">·</span>
              <span className="desktop-message-reasoning__preview-text">
                {preview || "正在思考…"}
              </span>
            </span>
          )}
        </summary>
        <div className="desktop-message-reasoning__body" aria-live="off" aria-busy={streaming}>
          <Markdown content={text} />
        </div>
      </details>
    );
  }

  return (
    <div
      className={`desktop-message desktop-message--${role}`}
      data-copy-status={copyStatus}
      data-streaming={streaming || undefined}
    >
      {role === "assistant" && streaming && (
        <div className="desktop-message__generation" role="status">
          <span className="desktop-message__generation-dot" aria-hidden="true" />
          正在生成…
        </div>
      )}
      {role === "user" ? (
        <div className="desktop-message__bubble">{text}</div>
      ) : (
        <div className="desktop-message__body" aria-live="off" aria-busy={streaming}>
          <Markdown content={text} />
        </div>
      )}
      {!streaming && (
        <div className="desktop-message__actions">
          <Button
            className="desktop-message__copy"
            busy={copyStatus === "pending"}
            aria-label="复制消息原文"
            aria-describedby={statusId}
            title={copyStatus === "failed" ? "复制失败，点击重试" : "复制消息原文"}
            onClick={() => void copyMessage()}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {copyStatus === "copied" ? (
                <path d="m5 12 4 4L19 6" />
              ) : copyStatus === "failed" ? (
                <>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v6m0 4h.01" />
                </>
              ) : (
                <>
                  <rect x="8" y="8" width="12" height="13" rx="2" />
                  <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" />
                </>
              )}
            </svg>
          </Button>
          <div
            className="desktop-message__status"
            data-error={copyStatus === "failed" || undefined}
          >
            <span className="desktop-message__status-reserve" aria-hidden="true">
              {copyFeedback.failed}
            </span>
            <span id={statusId} role="status" aria-live="polite" aria-atomic="true">
              {copyFeedback[copyStatus]}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
