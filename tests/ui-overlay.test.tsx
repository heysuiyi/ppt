// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "../src/renderer/src/components/Dialog";
import { Menu } from "../src/renderer/src/components/Menu";
import { Select } from "../src/renderer/src/components/Select";

beforeEach(() => {
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(120);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    { width: 100, height: 30 },
  ] as unknown as DOMRectList);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function DialogHarness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <button
        onClick={(event) => {
          event.currentTarget.focus();
          setOpen(true);
        }}
      >
        Open dialog
      </button>
      <Dialog
        open={open}
        label="Settings"
        onClose={() => {
          setOpen(false);
          onClose();
        }}
      >
        <button onClick={() => setExpanded(true)}>Add field</button>
        <Select
          ariaLabel="Model"
          value="a"
          onChange={() => {}}
          options={[
            { value: "a", label: "Alpha" },
            { value: "b", label: "Bravo" },
          ]}
        />
        {expanded && <input aria-label="New field" />}
      </Dialog>
    </>
  );
}

describe("overlay ownership", () => {
  it("dismisses a child Select before its dialog and restores the opener", () => {
    const onClose = vi.fn();
    const { container } = render(<DialogHarness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open dialog" });
    fireEvent.click(opener);
    expect(container.inert).toBe(true);
    const select = screen.getByRole("combobox", { name: "Model" });
    select.focus();
    fireEvent.click(select);
    expect(screen.getByRole("dialog").contains(screen.getByRole("listbox"))).toBe(true);
    fireEvent.keyDown(select, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(select);
    fireEvent.keyDown(select, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(container.inert).toBeFalsy();
  });

  it("recomputes the modal Tab boundary after dynamic content is added", () => {
    render(<DialogHarness onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    const first = screen.getByRole("button", { name: "Add field" });
    fireEvent.click(first);
    const last = screen.getByRole("textbox", { name: "New field" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

function MenuHarness({ x, y, onDelete }: { x: number; y: number; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        onContextMenu={(event) => {
          event.preventDefault();
          event.currentTarget.focus();
          setOpen(true);
        }}
      >
        Session
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        label="Session actions"
        anchorRef={anchor}
        point={{ x, y }}
        items={[
          { id: "open", label: "Open", onSelect: () => {} },
          { id: "delete", label: "Delete", danger: true, onSelect: onDelete },
        ]}
      />
    </>
  );
}

describe("action menus", () => {
  it.each([
    [-100, -100],
    [1000, -100],
    [-100, 1000],
    [1000, 1000],
  ])("keeps the menu inside all viewport edges at (%i, %i)", (x, y) => {
    render(<MenuHarness x={x} y={y} onDelete={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Session" }));
    const menu = screen.getByRole("menu");
    const left = Number.parseFloat(menu.style.left);
    const top = Number.parseFloat(menu.style.top);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(left + Number.parseFloat(menu.style.width)).toBeLessThanOrEqual(792);
    expect(top + Math.min(122, Number.parseFloat(menu.style.maxHeight))).toBeLessThanOrEqual(592);
  });

  it("moves focus with arrows and dismisses Escape without deleting", () => {
    const onDelete = vi.fn();
    render(<MenuHarness x={400} y={300} onDelete={onDelete} />);
    const session = screen.getByRole("button", { name: "Session" });
    fireEvent.contextMenu(session);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Open" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(session);
  });
});
