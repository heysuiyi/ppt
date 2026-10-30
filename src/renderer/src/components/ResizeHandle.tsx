import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useLayoutEffect, useRef, useState } from "react";

export interface ResizeHandleProps {
  axis: "x" | "y";
  label: string;
  disabled?: boolean;
  value: number;
  min: number;
  max: number;
  direction?: 1 | -1;
  onValueChange: (value: number) => void;
}

interface ResizeSession {
  axis: ResizeHandleProps["axis"];
  min: number;
  max: number;
  direction: number;
  finish: (updateState: boolean, checkHover?: boolean) => void;
}

// A drag owns both pointer tracking and the document cursor until it ends.
let activeSession: ResizeSession | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function ResizeHandle({
  axis,
  label,
  disabled = false,
  value,
  min,
  max,
  direction = 1,
  onValueChange,
}: ResizeHandleProps) {
  const sessionRef = useRef<ResizeSession | null>(null);
  const onValueChangeRef = useRef(onValueChange);
  const valueRef = useRef(value);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const unavailable = disabled || max <= min;

  useLayoutEffect(() => {
    onValueChangeRef.current = onValueChange;
  }, [onValueChange]);
  useLayoutEffect(() => {
    valueRef.current = value;
  }, [value]);

  useLayoutEffect(() => {
    const session = sessionRef.current;
    if (
      session &&
      (disabled ||
        session.axis !== axis ||
        session.min !== min ||
        session.max !== max ||
        session.direction !== direction)
    ) {
      session.finish(true);
    }
  }, [axis, disabled, min, max, direction]);

  useLayoutEffect(
    () => () => {
      sessionRef.current?.finish(false);
    },
    [],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (unavailable || !event.isPrimary || event.button !== 0 || activeSession) return;

    const element = event.currentTarget;
    const ownerDocument = element.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const pointerId = event.pointerId;
    const startCoordinate = axis === "x" ? event.clientX : event.clientY;
    const startValue = value;
    let lastX = event.clientX;
    let lastY = event.clientY;

    try {
      element.setPointerCapture(pointerId);
    } catch {
      // A pointer that has already ended cannot establish a drag session.
      return;
    }

    const session: ResizeSession = {
      axis,
      min,
      max,
      direction,
      finish(updateState, checkHover = false) {
        if (sessionRef.current !== session) return;
        sessionRef.current = null;
        element.removeEventListener("pointermove", handlePointerMove);
        element.removeEventListener("pointerup", handlePointerEnd);
        element.removeEventListener("pointercancel", handlePointerEnd);
        element.removeEventListener("lostpointercapture", handleLostCapture);
        ownerWindow?.removeEventListener("blur", handleWindowBlur);

        if (activeSession === session) {
          activeSession = null;
          ownerDocument.documentElement.removeAttribute("data-resize-axis");
        }

        if (element.hasPointerCapture(pointerId)) {
          element.releasePointerCapture(pointerId);
        }

        if (updateState) {
          // Pointer leave events during capture do not describe the hit target.
          let inside = false;
          if (checkHover) {
            const rect = element.getBoundingClientRect();
            inside =
              lastX >= rect.left && lastX < rect.right && lastY >= rect.top && lastY < rect.bottom;
          }
          setHovered(inside);
          setDragging(false);
        }
      },
    };

    function handlePointerMove(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== pointerId || !pointerEvent.isPrimary) return;
      lastX = pointerEvent.clientX;
      lastY = pointerEvent.clientY;
      const coordinate = axis === "x" ? lastX : lastY;
      pointerEvent.preventDefault();
      const nextValue = clamp(startValue + (coordinate - startCoordinate) * direction, min, max);
      if (nextValue !== valueRef.current) {
        valueRef.current = nextValue;
        onValueChangeRef.current(nextValue);
      }
    }

    function handlePointerEnd(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== pointerId || !pointerEvent.isPrimary) return;
      lastX = pointerEvent.clientX;
      lastY = pointerEvent.clientY;
      session.finish(true, pointerEvent.type === "pointerup");
    }

    function handleLostCapture(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId === pointerId) session.finish(true);
    }

    function handleWindowBlur() {
      session.finish(true, false);
    }

    activeSession = session;
    sessionRef.current = session;
    element.addEventListener("pointermove", handlePointerMove, { passive: false });
    element.addEventListener("pointerup", handlePointerEnd);
    element.addEventListener("pointercancel", handlePointerEnd);
    element.addEventListener("lostpointercapture", handleLostCapture);
    ownerWindow?.addEventListener("blur", handleWindowBlur);
    ownerDocument.documentElement.setAttribute("data-resize-axis", axis);
    setDragging(true);
    event.preventDefault();
    element.focus({ preventScroll: true });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (unavailable || activeSession) return;

    let nextValue: number;
    if (event.key === "Home") {
      nextValue = min;
    } else if (event.key === "End") {
      nextValue = max;
    } else if (event.key === (axis === "x" ? "ArrowLeft" : "ArrowUp")) {
      nextValue = value - 10 * direction;
    } else if (event.key === (axis === "x" ? "ArrowRight" : "ArrowDown")) {
      nextValue = value + 10 * direction;
    } else {
      return;
    }

    event.preventDefault();
    const clampedValue = clamp(nextValue, min, max);
    if (clampedValue !== value) onValueChangeRef.current(clampedValue);
  };

  return (
    <div
      className="resize-handle"
      role="separator"
      aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={clamp(value, min, max)}
      aria-disabled={unavailable}
      tabIndex={unavailable ? -1 : 0}
      data-axis={axis}
      data-state={unavailable ? "disabled" : dragging ? "dragging" : hovered ? "hover" : "idle"}
      onPointerDown={handlePointerDown}
      onPointerEnter={(event) => {
        if (!unavailable && !sessionRef.current && event.isPrimary) setHovered(true);
      }}
      onPointerLeave={(event) => {
        if (!sessionRef.current && event.isPrimary) setHovered(false);
      }}
      onKeyDown={handleKeyDown}
    />
  );
}
