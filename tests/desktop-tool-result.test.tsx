// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolResult } from "../app/renderer/src/desktop/ToolResult";
import type { HarnessToolDisplay } from "../app/shared/harness-ipc";

afterEach(cleanup);

const display: HarnessToolDisplay = {
  title: "src/example.ts:1-20",
  input: ["path: src/example.ts", "startLine: 1", "endLine: 20"],
  summary: ["20 lines · UTF-8"],
  output: ["export function example() {", "  return 42;", "}"],
};

describe("ToolResult", () => {
  it("shows readable result text immediately while keeping low-frequency parameters optional", () => {
    const { container } = render(<ToolResult name="read" status="completed" display={display} />);
    const output = screen.getByRole("region", { name: "工具结果预览" });
    expect(output.textContent).toBe(display.output.join("\n"));
    expect(output.hidden).toBe(false);
    expect(screen.getByTitle(display.title).textContent).toBe(display.title);
    const parameters = container.querySelector("details");
    expect(parameters?.open).toBe(false);
    fireEvent.click(parameters!.querySelector("summary")!);
    expect(parameters?.open).toBe(true);
    expect(screen.getByRole("region", { name: "工具参数" }).textContent).toBe(
      display.input.join("\n"),
    );
  });

  it("expands and collapses long results without interpreting literal code, HTML, or links", async () => {
    const lines = [
      ...Array.from({ length: 24 }, (_, index) => `const value${index} = ${index};`),
      '<img src="https://untrusted.invalid/pixel" onerror="alert(1)">',
      "<script>window.untrusted = true</script>",
      "[link](https://untrusted.invalid) <a href='https://untrusted.invalid'>link</a>",
      "  const comparison = a < b && b > 0;",
    ];
    const { container } = render(
      <ToolResult name="read" status="completed" display={{ ...display, output: lines }} />,
    );
    const preview = screen.getByRole("region", { name: "工具结果预览" });
    expect(preview.textContent).toContain(lines[0]);
    expect(preview.textContent).not.toContain(lines.at(-1));
    const expansion = container.querySelector("details")!;
    fireEvent.click(expansion.querySelector("summary")!);
    await waitFor(() => expect(preview.hidden).toBe(true));
    expect(expansion.open).toBe(true);
    expect(screen.getByRole("region", { name: "工具完整预览" }).textContent).toBe(lines.join("\n"));
    expect(container.querySelector("img, script, a, iframe")).toBeNull();
    fireEvent.click(expansion.querySelector("summary")!);
    await waitFor(() => expect(preview.hidden).toBe(false));
    expect(expansion.open).toBe(false);
  });

  it.each(["failed", "unknown"] as const)(
    "keeps %s errors and applied or uncertain effects outside optional disclosure",
    (status) => {
      const error = { code: "RESULT_UNCERTAIN", message: "The file may already have changed." };
      const { rerender } = render(
        <ToolResult name="edit" status={status} error={error} effects="applied" />,
      );
      const failure = screen.getByLabelText("工具错误");
      expect(failure.textContent).toContain(error.code);
      expect(failure.textContent).toContain(error.message);
      expect(failure.closest("details")).toBeNull();
      rerender(<ToolResult name="edit" status={status} error={error} effects="unknown" />);
      const uncertainImpact = screen.getByLabelText("工具影响");
      expect(uncertainImpact.closest("details")).toBeNull();
      rerender(<ToolResult name="read" status={status} error={error} effects="none" />);
      expect(screen.queryByLabelText("工具影响")).toBeNull();
      expect(screen.getByLabelText("工具错误").textContent).toContain(error.message);
    },
  );

  it("does not fall back to raw objects for absent previews or empty safe results", () => {
    const raw = {
      name: "read",
      status: "recorded" as const,
      output: { secret: "raw-output-must-not-render" },
      modelContent: "model-content-must-not-render",
    };
    const { container, rerender } = render(<ToolResult {...raw} />);
    expect(screen.queryByRole("region", { name: "工具结果预览" })).toBeNull();
    const absent = container.textContent;
    expect(absent).not.toContain(raw.output.secret);
    expect(absent).not.toContain(raw.modelContent);
    rerender(
      <ToolResult name="read" status="recorded" display={{ title: "", input: [], output: [] }} />,
    );
    expect(screen.queryByRole("region", { name: "工具结果预览" })).toBeNull();
    expect(container.querySelector("details, button")).toBeNull();
    rerender(<ToolResult name="read" status="dispatched" />);
    expect(screen.queryByRole("region", { name: "工具结果预览" })).toBeNull();
  });
});
