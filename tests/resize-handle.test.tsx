// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ResizeHandle, type ResizeHandleProps } from "../app/renderer/src/components/ResizeHandle";

class ControlledPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly isPrimary: boolean;
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.isPrimary = init.isPrimary ?? false;
    this.pointerType = init.pointerType ?? "mouse";
  }
}

const captures = new Map<number, HTMLElement>();
const installedCaptureMethods: string[] = [];

beforeAll(() => {
  if (typeof window.PointerEvent !== "function") {
    vi.stubGlobal("PointerEvent", ControlledPointerEvent);
  }

  // jsdom has no capture routing. Dispatches below target the captured handle
  // explicitly; releasing capture also exercises synchronous lost-capture cleanup.
  const methods = {
    setPointerCapture(this: HTMLElement, pointerId: number) {
      captures.set(pointerId, this);
    },
    hasPointerCapture(this: HTMLElement, pointerId: number) {
      return captures.get(pointerId) === this;
    },
    releasePointerCapture(this: HTMLElement, pointerId: number) {
      if (captures.get(pointerId) !== this) return;
      captures.delete(pointerId);
      this.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId }));
    },
  };

  for (const [name, method] of Object.entries(methods)) {
    if (typeof Reflect.get(HTMLElement.prototype, name) === "function") continue;
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      writable: true,
      value: method,
    });
    installedCaptureMethods.push(name);
  }
});

afterEach(() => {
  cleanup();
  captures.clear();
});

afterAll(() => {
  for (const name of installedCaptureMethods) {
    Reflect.deleteProperty(HTMLElement.prototype, name);
  }
  vi.unstubAllGlobals();
});

function pointer(target: Element | Document | Window, type: string, init: PointerEventInit = {}) {
  fireEvent(
    target,
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 100,
      ...init,
    }),
  );
}

type HarnessProps = Omit<ResizeHandleProps, "value" | "onValueChange"> & {
  initialValue?: number;
  externalValue?: number;
  onValueChange?: (value: number) => void;
};

function Harness({ initialValue = 200, externalValue, onValueChange, ...props }: HarnessProps) {
  const [value, setValue] = useState(initialValue);
  return (
    <>
      <div
        data-testid={`size-${props.label}`}
        style={props.axis === "x" ? { width: value } : { height: value }}
      />
      <ResizeHandle
        {...props}
        value={value}
        onValueChange={(next) => {
          setValue(next);
          onValueChange?.(next);
        }}
      />
      {externalValue !== undefined && (
        <button onClick={() => setValue(externalValue)}>Set {props.label} value</button>
      )}
    </>
  );
}

const baseProps = { axis: "x", label: "Pane", min: 100, max: 400 } as const;

function handle(label = "Pane") {
  return screen.getByRole("separator", { name: label });
}

function expectSize(value: number, label = "Pane") {
  const pane = screen.getByTestId(`size-${label}`);
  expect(pane.style.width || pane.style.height).toBe(`${value}px`);
}

function expectEnded(target: HTMLElement) {
  expect(target.getAttribute("data-state")).not.toBe("dragging");
  expect(target.hasPointerCapture(1)).toBe(false);
  expect(document.documentElement.hasAttribute("data-resize-axis")).toBe(false);
}

const axes = ["x", "y"] as const;
const dragCases = axes.flatMap((axis) =>
  ([1, -1] as const).map((direction) => ({ axis, direction })),
);

function position(axis: "x" | "y", coordinate: number): PointerEventInit {
  return axis === "x"
    ? { clientX: coordinate, clientY: 900 }
    : { clientX: 900, clientY: coordinate };
}

describe("ResizeHandle", () => {
  it.each(dragCases)(
    "resizes $axis with direction $direction from the controlled value and total displacement",
    ({ axis, direction }) => {
      render(<Harness {...baseProps} axis={axis} direction={direction} initialValue={260} />);
      const target = handle();
      pointer(target, "pointerdown");
      expect(target.hasPointerCapture(1)).toBe(true);
      expect(target.getAttribute("data-state")).toBe("dragging");
      expect(document.documentElement.getAttribute("data-resize-axis")).toBe(axis);

      pointer(target, "pointermove", position(axis, 125));
      expectSize(260 + 25 * direction);
      pointer(target, "pointermove", position(axis, 145));
      expectSize(260 + 45 * direction);
      expect(target.getAttribute("aria-valuenow")).toBe(String(260 + 45 * direction));

      pointer(target, "pointerup", position(axis, 145));
      expectEnded(target);
      pointer(target, "pointermove", position(axis, 180));
      expectSize(260 + 45 * direction);
    },
  );

  it.each(axes)("clamps %s movement without accumulating overshoot at either boundary", (axis) => {
    render(<Harness {...baseProps} axis={axis} max={300} />);
    const target = handle();
    pointer(target, "pointerdown");
    for (const [coordinate, expected] of [
      [600, 300],
      [190, 290],
      [-300, 100],
      [10, 110],
    ]) {
      pointer(target, "pointermove", position(axis, coordinate));
      expectSize(expected);
    }
    pointer(target, "pointerup");
    expectEnded(target);
  });

  it("keeps the original drag baseline when the controlled value changes externally", () => {
    render(<Harness {...baseProps} externalValue={350} />);
    const target = handle();
    pointer(target, "pointerdown");
    pointer(target, "pointermove", { clientX: 120 });
    expectSize(220);
    fireEvent.click(screen.getByRole("button", { name: "Set Pane value" }));
    expectSize(350);
    expect(target.getAttribute("data-state")).toBe("dragging");
    pointer(target, "pointermove", { clientX: 120 });
    expectSize(220);
    pointer(target, "pointermove", { clientX: 150 });
    expectSize(250);
    pointer(target, "pointerup");
  });

  it.each([
    { button: 1, isPrimary: true },
    { button: 2, isPrimary: true },
    { button: 0, isPrimary: false },
  ])("ignores pointer starts with button $button and isPrimary $isPrimary", (init) => {
    const onValueChange = vi.fn();
    render(<Harness {...baseProps} onValueChange={onValueChange} />);
    const target = handle();
    pointer(target, "pointerdown", init);
    pointer(target, "pointermove", { clientX: 160 });
    expectSize(200);
    expect(onValueChange).not.toHaveBeenCalled();
    expectEnded(target);
  });

  it("ignores other pointer IDs, including termination events and a second start", () => {
    render(<Harness {...baseProps} />);
    const target = handle();
    pointer(target, "pointerdown");
    for (const type of [
      "pointerdown",
      "pointermove",
      "pointerup",
      "pointercancel",
      "lostpointercapture",
    ]) {
      pointer(target, type, { pointerId: 2, clientX: 180 });
      expectSize(200);
      expect(target.getAttribute("data-state")).toBe("dragging");
      expect(target.hasPointerCapture(1)).toBe(true);
    }
    for (const type of ["pointermove", "pointerup", "pointercancel"]) {
      pointer(target, type, { isPrimary: false, clientX: 180 });
      expectSize(200);
      expect(target.getAttribute("data-state")).toBe("dragging");
    }
    pointer(target, "pointermove", { clientX: 140 });
    expectSize(240);
    pointer(target, "pointerup");
    expectEnded(target);
  });

  it.each(["pointerup", "pointercancel", "lostpointercapture", "blur"])(
    "ends on %s while preserving the last size and allowing a fresh session",
    (termination) => {
      const onValueChange = vi.fn();
      render(<Harness {...baseProps} onValueChange={onValueChange} />);
      const target = handle();
      pointer(target, "pointerdown");
      pointer(target, "pointermove", { clientX: 130 });
      expectSize(230);
      if (termination === "blur") {
        fireEvent(window, new Event("blur"));
      } else {
        if (termination === "lostpointercapture") captures.delete(1);
        pointer(target, termination);
      }
      expectEnded(target);
      pointer(target, "pointermove", { clientX: 170 });
      expectSize(230);
      expect(onValueChange.mock.calls).toEqual([[230]]);

      pointer(target, "pointerdown", { clientX: 300 });
      pointer(target, "pointermove", { clientX: 310 });
      expectSize(240);
      pointer(target, "pointerup");
      expectEnded(target);
    },
  );

  it.each([
    { name: "disabled", change: { disabled: true } },
    { name: "minimum", change: { min: 120 } },
    { name: "maximum", change: { max: 350 } },
    { name: "axis", change: { axis: "y" as const } },
    { name: "direction", change: { direction: -1 as const } },
  ])("ends a drag when $name changes", ({ change }) => {
    const onValueChange = vi.fn();
    const view = render(<Harness {...baseProps} onValueChange={onValueChange} />);
    const target = handle();
    pointer(target, "pointerdown");
    pointer(target, "pointermove", { clientX: 130 });
    view.rerender(<Harness {...baseProps} {...change} onValueChange={onValueChange} />);
    expectEnded(target);
    pointer(target, "pointermove", { clientX: 170, clientY: 170 });
    expectSize(230);
    expect(onValueChange.mock.calls).toEqual([[230]]);
  });

  it("releases capture and document ownership when an active handle unmounts", () => {
    const onValueChange = vi.fn();
    const view = render(<Harness {...baseProps} onValueChange={onValueChange} />);
    const target = handle();
    pointer(target, "pointerdown");
    pointer(target, "pointermove", { clientX: 125 });
    expectSize(225);
    view.unmount();
    expect(target.hasPointerCapture(1)).toBe(false);
    expect(document.documentElement.hasAttribute("data-resize-axis")).toBe(false);
    pointer(document, "pointermove", { clientX: 180 });
    expect(onValueChange.mock.calls).toEqual([[225]]);

    render(<Harness {...baseProps} axis="y" />);
    pointer(handle(), "pointerdown");
    pointer(handle(), "pointermove", { clientY: 130 });
    expectSize(230);
    pointer(handle(), "pointerup");
  });

  it("keeps one owner and prevents unrelated instances from clearing its state", () => {
    const first = render(<Harness {...baseProps} label="Width" />);
    const second = render(<Harness {...baseProps} label="Height" axis="y" />);
    const width = handle("Width");
    pointer(width, "pointerdown");
    pointer(handle("Height"), "pointerdown", { pointerId: 2 });
    pointer(handle("Height"), "pointermove", { pointerId: 2, clientY: 160 });
    pointer(handle("Height"), "pointercancel", { pointerId: 2 });
    expectSize(200, "Height");
    expect(document.documentElement.getAttribute("data-resize-axis")).toBe("x");
    expect(width.hasPointerCapture(1)).toBe(true);
    second.unmount();
    expect(document.documentElement.getAttribute("data-resize-axis")).toBe("x");
    pointer(width, "pointermove", { clientX: 140 });
    expectSize(240, "Width");
    pointer(width, "pointerup");
    expectEnded(width);

    render(<Harness {...baseProps} label="Height" axis="y" />);
    const height = handle("Height");
    pointer(height, "pointerdown");
    first.unmount();
    expect(document.documentElement.getAttribute("data-resize-axis")).toBe("y");
    pointer(height, "pointermove", { clientY: 130 });
    expectSize(230, "Height");
    pointer(height, "pointerup");
    expectEnded(height);
  });

  it.each([
    { disabled: true, min: 100, max: 400 },
    { disabled: false, min: 200, max: 200 },
    { disabled: false, min: 300, max: 100 },
  ])("does not resize or accept focus for unavailable range %j", (range) => {
    const onValueChange = vi.fn();
    render(<Harness {...baseProps} {...range} onValueChange={onValueChange} />);
    const target = handle();
    expect(target.tabIndex).toBe(-1);
    expect(target.getAttribute("data-state")).toBe("disabled");
    pointer(target, "pointerdown");
    pointer(target, "pointermove", { clientX: 150 });
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
      fireEvent.keyDown(target, { key });
    }
    expectSize(200);
    expect(onValueChange).not.toHaveBeenCalled();
    expectEnded(target);
  });

  it.each(dragCases)(
    "supports $axis keyboard resizing with direction $direction and aria",
    ({ axis, direction }) => {
      render(<Harness {...baseProps} axis={axis} direction={direction} max={300} />);
      const target = handle();
      const increaseCoordinate = axis === "x" ? "ArrowRight" : "ArrowDown";
      const decreaseCoordinate = axis === "x" ? "ArrowLeft" : "ArrowUp";
      expect(target.tabIndex).toBe(0);
      expect(target.getAttribute("aria-orientation")).toBe(
        axis === "x" ? "vertical" : "horizontal",
      );
      expect(target.getAttribute("aria-valuemin")).toBe("100");
      expect(target.getAttribute("aria-valuemax")).toBe("300");
      expect(target.getAttribute("aria-valuenow")).toBe("200");

      fireEvent.keyDown(target, { key: axis === "x" ? "ArrowDown" : "ArrowRight" });
      expectSize(200);
      fireEvent.keyDown(target, { key: increaseCoordinate });
      expectSize(200 + 10 * direction);
      expect(target.getAttribute("aria-valuenow")).toBe(String(200 + 10 * direction));
      fireEvent.keyDown(target, { key: decreaseCoordinate });
      expectSize(200);
      fireEvent.keyDown(target, { key: "Home" });
      expectSize(100);
      fireEvent.keyDown(target, { key: direction === 1 ? decreaseCoordinate : increaseCoordinate });
      expectSize(100);
      fireEvent.keyDown(target, { key: "End" });
      expectSize(300);
      fireEvent.keyDown(target, { key: direction === 1 ? increaseCoordinate : decreaseCoordinate });
      expectSize(300);
      expect(target.getAttribute("aria-valuenow")).toBe("300");
      expect(document.documentElement.hasAttribute("data-resize-axis")).toBe(false);
    },
  );

  it.each([
    { clientX: 110, clientY: 110, state: "hover" },
    { clientX: 300, clientY: 300, state: "idle" },
  ])("restores $state from the release position after captured pointer leave", (entry) => {
    render(<Harness {...baseProps} />);
    const target = handle();
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(90, 90, 50, 50));
    expect(target.getAttribute("data-state")).toBe("idle");
    pointer(target, "pointerover");
    expect(target.getAttribute("data-state")).toBe("hover");
    pointer(target, "pointerdown");
    pointer(target, "pointerout");
    expect(target.getAttribute("data-state")).toBe("dragging");
    pointer(target, "pointermove", { clientX: 120, clientY: 110 });
    expectSize(220);
    pointer(target, "pointerup", entry);
    expectEnded(target);
    expect(target.getAttribute("data-state")).toBe(entry.state);
    expectSize(220);
  });
});
