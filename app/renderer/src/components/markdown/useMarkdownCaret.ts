import { type RefObject, useLayoutEffect } from "react";

const skippedTail = '[hidden], [aria-hidden="true"], .sr-only, section[data-footnotes]';

function visualTail(root: HTMLElement): Text | HTMLElement {
  const visit = (parent: HTMLElement): Text | HTMLElement | undefined => {
    for (let child = parent.lastChild; child; child = child.previousSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent?.trimEnd()) return child as Text;
      } else if (child instanceof HTMLElement && !child.matches(skippedTail)) {
        const tail = visit(child);
        if (tail) return tail;
        // Empty cells/code and replaced elements still have a real visual insertion point.
        if (child.getClientRects().length) return child;
      }
    }
    return undefined;
  };
  return visit(root) ?? root;
}

/** The React-owned caret follows native text without participating in its line boxes. */
export function useMarkdownCaret(
  hostRef: RefObject<HTMLDivElement | null>,
  caretRef: RefObject<HTMLSpanElement | null>,
  active: boolean,
): void {
  useLayoutEffect(() => {
    const host = hostRef.current;
    const caret = caretRef.current;
    const wrapper = host?.parentElement;
    if (!active || !host || !caret || !wrapper) return;
    let frame: number | undefined;
    const position = () => {
      frame = undefined;
      if (!host.getClientRects().length) {
        caret.style.visibility = "hidden";
        return;
      }
      const tail = visualTail(host);
      const element = tail instanceof HTMLElement ? tail : tail.parentElement!;
      const style = getComputedStyle(element);
      const height = Number.parseFloat(style.fontSize);
      let left: number;
      let top: number;
      if (tail instanceof Text) {
        const range = host.ownerDocument.createRange();
        range.setStart(tail, tail.data.trimEnd().length);
        range.collapse(true);
        const rect = Array.from(range.getClientRects()).at(-1);
        if (!rect) {
          caret.style.visibility = "hidden";
          return;
        }
        left = rect.left;
        top = rect.top + (rect.height - height) / 2;
      } else {
        const rect = tail.getBoundingClientRect();
        const lineHeight = Number.parseFloat(style.lineHeight) || height;
        left = rect.left + Number.parseFloat(style.paddingLeft);
        top = rect.top + Number.parseFloat(style.paddingTop) + (lineHeight - height) / 2;
        if (tail.matches("img, hr, input")) {
          left = rect.right;
          top = rect.bottom - height;
        }
      }
      // A horizontally scrolled code block must not paint its offscreen tail over other UI.
      for (
        let ancestor: HTMLElement | null = element;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const overflow = getComputedStyle(ancestor).overflowX;
        if (/^(auto|scroll|hidden|clip)$/.test(overflow)) {
          const rect = ancestor.getBoundingClientRect();
          if (left < rect.left || left > rect.right) {
            caret.style.visibility = "hidden";
            return;
          }
        }
        if (ancestor === host) break;
      }
      const origin = wrapper.getBoundingClientRect();
      caret.style.left = `${left - origin.left + (style.direction === "rtl" ? -5 : 3)}px`;
      caret.style.top = `${top - origin.top}px`;
      caret.style.height = `${height}px`;
      caret.style.visibility = "visible";
    };
    const schedule = () => {
      if (frame === undefined) frame = window.requestAnimationFrame(position);
    };
    position();
    const mutations = new MutationObserver(schedule);
    mutations.observe(host, { childList: true, characterData: true, subtree: true });
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    resize?.observe(host);
    window.addEventListener("resize", schedule);
    host.ownerDocument.addEventListener("scroll", schedule, true);
    host.ownerDocument.fonts?.addEventListener("loadingdone", schedule);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      mutations.disconnect();
      resize?.disconnect();
      window.removeEventListener("resize", schedule);
      host.ownerDocument.removeEventListener("scroll", schedule, true);
      host.ownerDocument.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [active, caretRef, hostRef]);
}
