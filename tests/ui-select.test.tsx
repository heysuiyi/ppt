// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select, type SelectOption } from "../src/renderer/src/components/Select";

const OPTIONS: SelectOption[] = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Bravo", hint: "second" },
  { value: "c", label: "Charlie" },
];

function Harness({
  initial = "a",
  onChange = vi.fn(),
  disabled = false,
}: {
  initial?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Select
      variant="settings"
      ariaLabel="测试选择"
      value={value}
      disabled={disabled}
      options={OPTIONS}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

afterEach(() => {
  cleanup();
});

describe("Select", () => {
  it("opens a listbox and selects an option by click", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.click(screen.getByRole("combobox", { name: "测试选择" }));
    const listbox = screen.getByRole("listbox", { name: "测试选择" });
    expect(listbox).toBeTruthy();

    fireEvent.click(within(listbox).getByRole("option", { name: /Bravo/ }));
    expect(onChange).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("combobox", { name: "测试选择" }).textContent).toContain("Bravo");
  });

  it("supports arrow keys and Enter to choose an option", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const trigger = screen.getByRole("combobox", { name: "测试选择" });
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeTruthy();

    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on Escape without changing the value", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.click(screen.getByRole("combobox", { name: "测试选择" }));
    expect(screen.getByRole("listbox")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not open when disabled", () => {
    render(<Harness disabled />);
    const trigger = screen.getByRole("combobox", { name: "测试选择" });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
