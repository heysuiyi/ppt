import { getTypewriterStepSize, splitGraphemes } from "@shared/streaming-text";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { MarkdownRenderer } from "./MarkdownRenderer";

export interface MarkdownStreamOptions {
  documentId: string;
  content: string;
  mode?: "static" | "live";
  streaming?: boolean;
}

interface StreamStatus {
  busy: boolean;
  showCaret: boolean;
  liveOrigin: boolean;
  completed: boolean;
}

interface StreamSession {
  receive: (options: MarkdownStreamOptions) => void;
}

const IDLE_STATUS: StreamStatus = {
  busy: false,
  showCaret: false,
  liveOrigin: false,
  completed: false,
};

/** React observes lifecycle transitions; release ticks and glyph effects stay native. */
export function useMarkdownStream(
  hostRef: RefObject<HTMLDivElement | null>,
  options: MarkdownStreamOptions,
): StreamStatus {
  const latestOptions = useRef(options);
  latestOptions.current = options;
  const sessionRef = useRef<StreamSession | null>(null);
  const [status, setStatus] = useState<StreamStatus>(IDLE_STATUS);
  const { documentId, content, mode, streaming } = options;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = media.matches;
    let visible = document.visibilityState !== "hidden";
    let disposed = false;
    let timer: number | undefined;
    let received = "";
    let graphemes: string[] = [];
    let revealed = 0;
    let released = "";
    let liveOrigin = false;
    let upstreamActive = false;
    let renderer: MarkdownRenderer;

    const publish = () => {
      if (disposed) return;
      const pending = revealed < graphemes.length;
      const busy = liveOrigin && (upstreamActive || pending || renderer.activeEffects);
      const completed = liveOrigin && received.length > 0 && !busy;
      const next: StreamStatus = {
        busy,
        showCaret: busy && !reducedMotion,
        liveOrigin,
        completed,
      };
      setStatus((current) =>
        current.busy === next.busy &&
        current.showCaret === next.showCaret &&
        current.liveOrigin === next.liveOrigin &&
        current.completed === next.completed
          ? current
          : next,
      );
    };
    renderer = new MarkdownRenderer(host, { onEffectsChange: publish });

    const stopTimer = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const renderReleased = (animate: boolean) => {
      renderer.update(released, {
        animate,
        finalize: !upstreamActive && revealed === graphemes.length,
      });
    };
    const schedule = () => {
      if (!liveOrigin || reducedMotion || !visible || revealed >= graphemes.length) {
        stopTimer();
        return;
      }
      // Keep one clock across incoming chunks rather than postponing each release.
      if (timer !== undefined) return;
      timer = window.setInterval(() => {
        if (disposed) return;
        const end = Math.min(
          graphemes.length,
          revealed + getTypewriterStepSize(graphemes.length - revealed, upstreamActive),
        );
        released += graphemes.slice(revealed, end).join("");
        revealed = end;
        renderReleased(true);
        if (revealed === graphemes.length) stopTimer();
        publish();
      }, 24);
    };
    const revealAll = () => {
      stopTimer();
      revealed = graphemes.length;
      released = received;
      renderer.settleEffects();
      renderReleased(false);
      publish();
    };
    const receive = (next: MarkdownStreamOptions) => {
      upstreamActive = Boolean(next.streaming);
      liveOrigin ||= next.mode === "live";
      if (next.content !== received) {
        const nextGraphemes = splitGraphemes(next.content);
        let common = 0;
        const limit = Math.min(graphemes.length, nextGraphemes.length);
        while (common < limit && graphemes[common] === nextGraphemes[common]) common += 1;
        const rewritten = common < graphemes.length;
        received = next.content;
        graphemes = nextGraphemes;
        if (rewritten) {
          stopTimer();
          revealed = Math.min(revealed, common);
          released = graphemes.slice(0, revealed).join("");
          renderer.settleEffects();
          renderReleased(false);
        }
      }
      if (!liveOrigin || reducedMotion) {
        revealAll();
        return;
      }
      // Ending upstream output only finalizes once its entire received buffer is released.
      if (revealed === graphemes.length) renderReleased(visible);
      schedule();
      publish();
    };
    const onVisibilityChange = () => {
      visible = document.visibilityState !== "hidden";
      if (!visible) {
        stopTimer();
        renderer.settleEffects();
      } else {
        schedule();
      }
      publish();
    };
    const onMotionChange = () => {
      reducedMotion = media.matches;
      if (reducedMotion) revealAll();
      else {
        schedule();
        publish();
      }
    };

    sessionRef.current = { receive };
    document.addEventListener("visibilitychange", onVisibilityChange);
    media.addEventListener("change", onMotionChange);
    receive({ ...latestOptions.current, documentId });
    return () => {
      disposed = true;
      sessionRef.current = null;
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      media.removeEventListener("change", onMotionChange);
      renderer.dispose();
    };
  }, [documentId, hostRef]);

  useLayoutEffect(() => {
    sessionRef.current?.receive({ documentId, content, mode, streaming });
  }, [documentId, content, mode, streaming]);

  return status;
}
