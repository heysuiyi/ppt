// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentQuestionCard } from "../app/renderer/src/components/AgentQuestionCard";

afterEach(cleanup);

describe("AgentQuestionCard", () => {
  it("submits trimmed free text as a structured answer", () => {
    const onResolve = vi.fn();
    render(
      <AgentQuestionCard
        question={{
          variant: "markdown",
          selectionMode: "single",
          placeholder: "例如：面向高中生，约 8-10 页",
        }}
        onResolve={onResolve}
      />,
    );

    const input = screen.getByPlaceholderText("例如：面向高中生，约 8-10 页");
    const submit = screen.getByRole("button", { name: "提交回答" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "  面向高中生，10 页  " } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    expect(onResolve).toHaveBeenCalledWith({
      optionIds: [],
      value: "面向高中生，10 页",
      label: "面向高中生，10 页",
      resolvedAt: expect.any(String),
    });
  });

  it("submits a single choice immediately and compacts resolved questions", () => {
    const onResolve = vi.fn();
    const view = render(
      <AgentQuestionCard
        question={{
          variant: "choices",
          selectionMode: "single",
          options: [{ id: "executives", title: "管理层", value: "面向管理层" }],
        }}
        onResolve={onResolve}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "管理层" }));
    expect(onResolve).toHaveBeenCalledWith({
      optionIds: ["executives"],
      value: "面向管理层",
      label: "管理层",
      resolvedAt: expect.any(String),
    });

    view.rerender(
      <AgentQuestionCard
        question={{
          variant: "choices",
          selectionMode: "single",
          options: [{ id: "executives", title: "管理层", value: "面向管理层" }],
          resolved: {
            optionIds: ["executives"],
            value: "面向管理层",
            label: "管理层",
            resolvedAt: "2026-07-25T00:00:00.000Z",
          },
        }}
        onResolve={onResolve}
      />,
    );

    expect(screen.queryByRole("button", { name: "管理层" })).toBeNull();
    expect(screen.getByText("已回答")).not.toBeNull();
    expect(screen.getByText("管理层")).not.toBeNull();
  });

  it("exposes multiple-choice state without submitting until confirmation", () => {
    const onResolve = vi.fn();
    render(
      <AgentQuestionCard
        question={{
          variant: "choices",
          selectionMode: "multiple",
          options: [
            { id: "a", title: "Audience A", value: "a" },
            { id: "b", title: "Audience B", value: "b" },
          ],
        }}
        onResolve={onResolve}
      />,
    );

    const first = screen.getByRole("button", { name: "Audience A", pressed: false });
    const second = screen.getByRole("button", { name: "Audience B", pressed: false });
    fireEvent.click(first);
    fireEvent.click(second);
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(2);
    expect(onResolve).not.toHaveBeenCalled();
    fireEvent.click(first);
    expect(screen.getByRole("button", { name: "Audience A", pressed: false })).toBe(first);
    expect(screen.getByRole("button", { name: "Audience B", pressed: true })).toBe(second);
    fireEvent.click(screen.getByRole("button", { name: "确认选择" }));
    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({ optionIds: ["b"], value: "b" }),
    );
  });

  it("names free text and blocks keyboard submission after disabling a drafted answer", () => {
    const onResolve = vi.fn();
    const question = { variant: "markdown" as const, selectionMode: "single" as const };
    const view = render(<AgentQuestionCard question={question} onResolve={onResolve} />);
    const input = screen.getByRole("textbox", { name: /./ });
    fireEvent.change(input, { target: { value: "Draft answer" } });
    view.rerender(<AgentQuestionCard question={question} onResolve={onResolve} disabled />);
    expect((input as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onResolve).not.toHaveBeenCalled();

    view.rerender(<AgentQuestionCard question={question} onResolve={onResolve} />);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Draft answer", optionIds: [] }),
    );
  });
});
