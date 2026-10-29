import { type RefObject, useLayoutEffect, useRef, useState } from "react";

interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}
interface Position {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  above: boolean;
}

export function usePopoverPosition(
  open: boolean,
  menu: RefObject<HTMLElement | null>,
  anchor: () => AnchorRect | null,
  placement: "auto" | "above" | "below" = "auto",
  minWidth = 180,
) {
  const latestAnchor = useRef(anchor);
  latestAnchor.current = anchor;
  const [position, setPosition] = useState<Position | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const reposition = () => {
      const rect = latestAnchor.current();
      const element = menu.current;
      if (!rect || !element) return;
      const margin = 8;
      const gap = 4;
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const width = Math.min(
        Math.max(rect.width, minWidth),
        Math.max(0, viewportWidth - margin * 2),
      );
      const below = Math.max(0, viewportHeight - Math.max(margin, rect.bottom + gap) - margin);
      const above = Math.max(0, Math.min(viewportHeight - margin, rect.top - gap) - margin);
      const preferredHeight = Math.min(280, element.scrollHeight + 2);
      const placeAbove =
        placement === "above"
          ? above >= preferredHeight || above > below
          : placement === "below"
            ? below < preferredHeight && above > below
            : below < preferredHeight && above > below;
      const maxHeight = Math.min(280, placeAbove ? above : below);
      const height = Math.min(preferredHeight, maxHeight);
      const top = Math.max(
        margin,
        Math.min(
          viewportHeight - margin - height,
          placeAbove ? rect.top - gap - height : rect.bottom + gap,
        ),
      );
      const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin));
      setPosition((previous) =>
        previous &&
        previous.top === top &&
        previous.left === left &&
        previous.width === width &&
        previous.maxHeight === maxHeight &&
        previous.above === placeAbove
          ? previous
          : { top, left, width, maxHeight, above: placeAbove },
      );
    };
    reposition();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reposition);
    if (menu.current) observer?.observe(menu.current);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, menu, placement, minWidth]);
  return position;
}
