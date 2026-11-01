// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "../app/renderer/src/components/Dialog";
import { Menu } from "../app/renderer/src/components/Menu";
import { Select } from "../app/renderer/src/components/Select";

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

  it.each([false, true])(
    "restores background state and the surviving opener when navigation unmounts dialogs (nested: %s)",
    async (nested) => {
      function NavigationHarness({ settings }: { settings: boolean }) {
        const [open, setOpen] = useState(false);
        const [childOpen, setChildOpen] = useState(false);
        return (
          <>
            <button
              onClick={(event) => {
                event.currentTarget.focus();
                setOpen(true);
              }}
            >
              Open settings route
            </button>
            {settings && (
              <Dialog open={open} onClose={() => setOpen(false)} label="Route settings">
                <button
                  onClick={(event) => {
                    event.currentTarget.focus();
                    setChildOpen(true);
                  }}
                >
                  Open nested settings
                </button>
                <Dialog
                  open={childOpen}
                  onClose={() => setChildOpen(false)}
                  label="Nested route settings"
                >
                  <input aria-label="Nested setting" />
                </Dialog>
              </Dialog>
            )}
          </>
        );
      }
      const originalOverflow = document.body.style.overflow;
      const alreadyInert = document.createElement("aside");
      alreadyInert.inert = true;
      document.body.append(alreadyInert);
      document.body.style.overflow = "scroll";
      const view = render(<NavigationHarness settings />);
      const addedBackground = document.createElement("aside");
      try {
        const opener = screen.getByRole("button", { name: "Open settings route" });
        fireEvent.click(opener);
        if (nested) {
          fireEvent.click(screen.getByRole("button", { name: "Open nested settings" }));
          expect(document.activeElement).toBe(
            screen.getByRole("textbox", { name: "Nested setting" }),
          );
        }
        await act(async () => {
          document.body.append(addedBackground);
        });
        expect(addedBackground.inert).toBe(true);
        expect(document.body.style.overflow).toBe("hidden");
        view.rerender(<NavigationHarness settings={false} />);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(view.container.inert).toBeFalsy();
        expect(addedBackground.inert).toBeFalsy();
        expect(alreadyInert.inert).toBe(true);
        expect(document.body.style.overflow).toBe("scroll");
        expect(document.activeElement).toBe(opener);
      } finally {
        view.unmount();
        alreadyInert.remove();
        addedBackground.remove();
        document.body.style.overflow = originalOverflow;
      }
    },
  );

  it("returns keyboard ownership to the lower dialog only after its child layers close", () => {
    const lowerKey = vi.fn();
    const upperKey = vi.fn();
    function NestedHarness() {
      const [open, setOpen] = useState(false);
      const [upperOpen, setUpperOpen] = useState(false);
      return (
        <>
          <button
            onClick={(event) => {
              event.currentTarget.focus();
              setOpen(true);
            }}
          >
            Open lower dialog
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} label="Lower" onKeyDown={lowerKey}>
            <button
              onClick={(event) => {
                event.currentTarget.focus();
                setUpperOpen(true);
              }}
            >
              Open upper dialog
            </button>
            <Dialog
              open={upperOpen}
              onClose={() => setUpperOpen(false)}
              label="Upper"
              onKeyDown={upperKey}
            >
              <Select
                ariaLabel="Upper model"
                value="a"
                onChange={() => {}}
                options={[
                  { value: "a", label: "Alpha" },
                  { value: "b", label: "Bravo" },
                ]}
              />
            </Dialog>
          </Dialog>
        </>
      );
    }
    const { container } = render(<NestedHarness />);
    const opener = screen.getByRole("button", { name: "Open lower dialog" });
    fireEvent.click(opener);
    const upperOpener = screen.getByRole("button", { name: "Open upper dialog" });
    fireEvent.click(upperOpener);
    expect(upperOpener.inert).toBe(true);
    const select = screen.getByRole("combobox", { name: "Upper model" });
    fireEvent.click(select);
    fireEvent.keyDown(select, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Upper" })).toBeTruthy();
    expect(upperOpener.inert).toBe(true);
    expect(document.activeElement).toBe(select);
    fireEvent.keyDown(select, { key: "F2" });
    expect(upperKey).toHaveBeenCalledTimes(1);
    expect(lowerKey).not.toHaveBeenCalled();
    fireEvent.keyDown(select, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Upper" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Lower" })).toBeTruthy();
    expect(document.activeElement).toBe(upperOpener);
    expect(upperOpener.inert).toBeFalsy();
    expect(container.inert).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(upperOpener, { key: "F2" });
    expect(lowerKey).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(upperOpener, { key: "Escape" });
    expect(document.activeElement).toBe(opener);
    expect(container.inert).toBeFalsy();
  });

  it("updates both Tab boundaries when fields are disabled or removed and traps an empty dialog", () => {
    function Fields({
      disabled,
      removed,
      empty,
    }: {
      disabled: boolean;
      removed: boolean;
      empty: boolean;
    }) {
      return (
        <Dialog open onClose={() => {}} label="Dynamic fields">
          {!empty && (
            <>
              <button>First field</button>
              <input aria-label="Middle field" />
              {!removed && <input aria-label="Last field" disabled={disabled} />}
            </>
          )}
        </Dialog>
      );
    }
    const view = render(<Fields disabled={false} removed={false} empty={false} />);
    const first = screen.getByRole("button", { name: "First field" });
    const middle = screen.getByRole("textbox", { name: "Middle field" });
    screen.getByRole("textbox", { name: "Last field" }).focus();
    view.rerender(<Fields disabled removed={false} empty={false} />);
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(middle);
    view.rerender(<Fields disabled={false} removed empty={false} />);
    middle.focus();
    fireEvent.keyDown(middle, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    view.rerender(<Fields disabled={false} removed empty />);
    const dialog = screen.getByRole("dialog", { name: "Dynamic fields" });
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(dialog);
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

  it("repositions an anchored Select after ancestor scrolling and viewport resizing", () => {
    render(
      <div>
        <Select
          ariaLabel="Positioned model"
          value="a"
          onChange={() => {}}
          options={[{ value: "a", label: "Alpha" }]}
        />
      </div>,
    );
    const trigger = screen.getByRole("combobox", { name: "Positioned model" });
    let rect = new DOMRect(100, 100, 200, 30);
    vi.spyOn(trigger, "getBoundingClientRect").mockImplementation(() => rect);
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox");
    const initialTop = Number.parseFloat(listbox.style.top);
    rect = new DOMRect(560, 500, 200, 30);
    fireEvent.scroll(trigger.parentElement!);
    expect(Number.parseFloat(listbox.style.left)).toBe(560);
    expect(Number.parseFloat(listbox.style.top)).not.toBe(initialTop);
    expect(Number.parseFloat(listbox.style.top) + 122).toBeLessThanOrEqual(rect.top - 4);
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(320);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(400);
    rect = new DOMRect(280, 350, 200, 30);
    fireEvent.resize(window);
    expect(Number.parseFloat(listbox.style.left)).toBeGreaterThanOrEqual(8);
    expect(
      Number.parseFloat(listbox.style.left) + Number.parseFloat(listbox.style.width),
    ).toBeLessThanOrEqual(312);
    expect(
      Number.parseFloat(listbox.style.top) +
        Math.min(122, Number.parseFloat(listbox.style.maxHeight)),
    ).toBeLessThanOrEqual(rect.top - 4);
  });

  it("moves growing menu content above its anchor without a resize or scroll event", async () => {
    let contentHeight = 120;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => contentHeight);
    const item = (index: number) => ({
      id: `action-${index}`,
      label: `Action ${index}`,
      onSelect: () => {},
    });
    const view = render(
      <Menu
        open
        label="Growing actions"
        onClose={() => {}}
        point={{ x: 100, y: 400 }}
        items={[item(0)]}
      />,
    );
    const menu = screen.getByRole("menu", { name: "Growing actions" });
    expect(Number.parseFloat(menu.style.top)).toBeGreaterThan(400);
    contentHeight = 260;
    await act(async () => {
      view.rerender(
        <Menu
          open
          label="Growing actions"
          onClose={() => {}}
          point={{ x: 100, y: 400 }}
          items={Array.from({ length: 12 }, (_, index) => item(index))}
        />,
      );
    });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(12);
    expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(8);
    expect(
      Number.parseFloat(menu.style.top) +
        Math.min(contentHeight + 2, Number.parseFloat(menu.style.maxHeight)),
    ).toBeLessThanOrEqual(396);
  });
});
