// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tabs, type TabsItem, TabsList, TabsPanel } from "../src/renderer/src/components/Tabs";

const items: readonly TabsItem<string>[] = [
  { value: "first", label: "First" },
  { value: "blocked", label: "Blocked", disabled: true },
  { value: "middle", label: "Middle" },
  { value: "last", label: "Last" },
];

function Example({
  value = "first",
  entries = items,
  onValueChange = () => undefined,
}: {
  value?: string;
  entries?: readonly TabsItem<string>[];
  onValueChange?: (value: string) => void;
}) {
  return (
    <>
      <input aria-label="Outside input" />
      <Tabs value={value} items={entries} onValueChange={onValueChange}>
        <TabsList label="Example tabs" />
        {entries.map((item) => (
          <TabsPanel key={item.value} value={item.value}>
            Content for {item.label}
          </TabsPanel>
        ))}
      </Tabs>
    </>
  );
}

function InteractiveExample({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState("first");
  return (
    <Example
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

afterEach(cleanup);

describe("Tabs", () => {
  it("automatically activates arrow navigation, wraps disabled items, and handles Home/End", () => {
    const onChange = vi.fn();
    render(<InteractiveExample onChange={onChange} />);
    const first = screen.getByRole("tab", { name: "First" });
    const middle = screen.getByRole("tab", { name: "Middle" });
    const last = screen.getByRole("tab", { name: "Last" });
    const blocked = screen.getByRole("tab", { name: "Blocked" });
    act(() => first.focus());

    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(middle);
    expect(middle.getAttribute("aria-selected")).toBe("true");
    expect(middle.tabIndex).toBe(0);
    expect(first.tabIndex).toBe(-1);
    expect(blocked.tabIndex).toBe(-1);
    fireEvent.keyDown(middle, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "ArrowRight" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "End" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Home" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(middle);
    fireEvent.keyDown(middle, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
    fireEvent.click(last);
    expect(document.activeElement).toBe(last);
    expect(screen.getByRole("tabpanel").textContent).toBe("Content for Last");
    expect(onChange.mock.calls.map(([next]) => next)).toEqual([
      "middle",
      "first",
      "last",
      "first",
      "last",
      "first",
      "middle",
      "first",
      "last",
    ]);
  });

  it("uses the first and last enabled entries for Home/End", () => {
    const entries = [
      ...items.map((item) =>
        item.value === "first" || item.value === "last" ? { ...item, disabled: true } : item,
      ),
      { value: "tail", label: "Tail" },
      { value: "blocked-end", label: "Blocked end", disabled: true },
    ];
    const onChange = vi.fn();
    render(<Example value="missing" entries={entries} onValueChange={onChange} />);
    const middle = screen.getByRole("tab", { name: "Middle" });
    const tail = screen.getByRole("tab", { name: "Tail" });
    act(() => tail.focus());
    fireEvent.keyDown(tail, { key: "Home" });
    expect(document.activeElement).toBe(middle);
    fireEvent.keyDown(middle, { key: "End" });
    expect(document.activeElement).toBe(tail);
    expect(onChange.mock.calls.map(([next]) => next)).toEqual(["middle", "tail"]);
  });

  it("updates controlled selection and roving focus without stealing external focus", () => {
    const onChange = vi.fn();
    const { rerender } = render(<Example onValueChange={onChange} />);
    const input = screen.getByRole("textbox", { name: "Outside input" });
    act(() => input.focus());
    rerender(<Example value="last" onValueChange={onChange} />);
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("tab", { name: "Last" }).tabIndex).toBe(0);
    expect(screen.getByRole("tabpanel").textContent).toBe("Content for Last");
    expect(onChange).not.toHaveBeenCalled();

    const first = screen.getByRole("tab", { name: "First" });
    act(() => first.focus());
    rerender(<Example value="middle" onValueChange={onChange} />);
    expect(document.activeElement).toBe(first);
    expect(first.tabIndex).toBe(-1);
    expect(screen.getByRole("tab", { name: "Middle" }).tabIndex).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("recovers focus when the focused tab is removed, without changing the controlled value", () => {
    const onChange = vi.fn();
    const { rerender } = render(<Example value="middle" onValueChange={onChange} />);
    act(() => screen.getByRole("tab", { name: "Middle" }).focus());
    rerender(
      <Example
        value="middle"
        entries={items.filter((item) => item.value !== "middle")}
        onValueChange={onChange}
      />,
    );
    const first = screen.getByRole("tab", { name: "First" });
    expect(document.activeElement).toBe(first);
    expect(first.tabIndex).toBe(0);
    expect(
      screen.getAllByRole("tab").every((tab) => tab.getAttribute("aria-selected") === "false"),
    ).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("recovers a newly disabled focused tab but leaves external input alone on later removal", () => {
    const onChange = vi.fn();
    const { rerender } = render(<Example value="middle" onValueChange={onChange} />);
    act(() => screen.getByRole("tab", { name: "Middle" }).focus());
    const entries = items.map((item) =>
      item.value === "middle" ? { ...item, disabled: true } : item,
    );
    rerender(<Example value="middle" entries={entries} onValueChange={onChange} />);
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "First" }));
    expect(onChange).not.toHaveBeenCalled();

    const input = screen.getByRole("textbox", { name: "Outside input" });
    act(() => input.focus());
    rerender(<Example value="middle" entries={entries.slice(1)} onValueChange={onChange} />);
    expect(document.activeElement).toBe(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not recover removed focus after the user explicitly moves focus to the body", () => {
    const { rerender } = render(<Example value="middle" />);
    act(() => screen.getByRole("tab", { name: "Middle" }).focus());
    fireEvent.pointerDown(document.body);
    act(() => (document.activeElement as HTMLElement).blur());
    rerender(<Example value="middle" entries={items.filter((item) => item.value !== "middle")} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("keeps an invalid controlled value unchanged and falls back only for the tab stop", () => {
    const onChange = vi.fn();
    render(<Example value="missing" onValueChange={onChange} />);
    expect(screen.getByRole("tab", { name: "First" }).tabIndex).toBe(0);
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(
      screen.getAllByRole("tab").every((tab) => tab.getAttribute("aria-selected") === "false"),
    ).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("has no tab stop or callback when every item is disabled, including dynamic disabling", () => {
    const onChange = vi.fn();
    const { rerender } = render(<Example onValueChange={onChange} />);
    const first = screen.getByRole("tab", { name: "First" });
    act(() => first.focus());
    rerender(
      <Example
        entries={items.map((item) => ({ ...item, disabled: true }))}
        onValueChange={onChange}
      />,
    );
    for (const tab of screen.getAllByRole("tab")) {
      expect((tab as HTMLButtonElement).disabled).toBe(true);
      expect(tab.tabIndex).toBe(-1);
      fireEvent.click(tab);
      for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"]) {
        fireEvent.keyDown(tab, { key });
      }
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps unique tab/panel associations across instances and mounts only active content", () => {
    const panelRef = createRef<HTMLDivElement>();
    render(
      <>
        <Example />
        <Tabs value="middle" items={items} onValueChange={() => undefined}>
          <TabsList label="Another group" variant="plain" />
          {items.map((item) => (
            <TabsPanel
              key={item.value}
              value={item.value}
              ref={item.value === "middle" ? panelRef : undefined}
              aria-label={item.value === "middle" ? "Custom panel label" : undefined}
            >
              Other content for {item.label}
            </TabsPanel>
          ))}
        </Tabs>
      </>,
    );
    const allTabs = screen.getAllByRole("tab");
    const allPanels = screen.getAllByRole("tabpanel", { hidden: true });
    expect(new Set([...allTabs, ...allPanels].map((element) => element.id)).size).toBe(
      allTabs.length + allPanels.length,
    );
    for (const tab of allTabs) {
      const panel = document.getElementById(tab.getAttribute("aria-controls")!)!;
      expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
      expect(panel.tabIndex).toBe(0);
      expect(panel.hidden).toBe(tab.getAttribute("aria-selected") !== "true");
      if (panel.hidden) expect(panel.childNodes.length).toBe(0);
    }
    const secondMiddle = within(screen.getByRole("tablist", { name: "Another group" })).getByRole(
      "tab",
      { name: "Middle" },
    );
    expect(panelRef.current?.id).toBe(secondMiddle.getAttribute("aria-controls"));
    expect(panelRef.current?.getAttribute("aria-label")).toBe("Custom panel label");
    expect(screen.getByText("Content for First")).not.toBeNull();
    expect(screen.getByText("Other content for Middle")).not.toBeNull();
    expect(screen.queryByText("Content for Last")).toBeNull();
  });
});
