// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnifiedAgentInput } from "../src/renderer/src/components/UnifiedAgentInput";
import { clearAllDisplayCardManagers } from "../src/shared/cards/display-card-managers";

afterEach(() => {
  cleanup();
  clearAllDisplayCardManagers();
});

function props() {
  return {
    request: "季度复盘",
    onChangeRequest: vi.fn(),
    onSubmitRequest: vi.fn(),
    busy: false,
    layoutMode: "center" as const,
    models: [
      {
        id: "model",
        name: "Model",
        provider: "openai" as const,
        model: "model",
        credentialConfigured: true,
      },
    ],
    selectedModelId: "model",
    setSelectedModelId: vi.fn(),
    onPrepareWorkspace: vi.fn(),
  };
}

describe("composer interactions", () => {
  it("shows a selected path with a change action, then makes bound workspace read-only", () => {
    const input = props();
    const { rerender } = render(<UnifiedAgentInput {...input} workspacePath="e:/work/report" />);
    expect(screen.getByText("report").getAttribute("title")).toBe("e:/work/report");
    fireEvent.click(screen.getByRole("button", { name: "更换" }));
    expect(input.onPrepareWorkspace).toHaveBeenCalledTimes(1);
    rerender(<UnifiedAgentInput {...input} workspacePath="e:/work/report" workspaceBound />);
    expect(screen.getByText("已绑定目录")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更换" })).toBeNull();
    expect(screen.queryByRole("button", { name: "选择项目目录" })).toBeNull();
    rerender(
      <UnifiedAgentInput
        {...input}
        workspacePath="e:/work/report"
        workspaceBound
        layoutMode="bottom"
      />,
    );
    expect(screen.queryByText("report")).toBeNull();
  });

  it("blocks send, model selection, and directory changes during a session switch", () => {
    const input = props();
    render(<UnifiedAgentInput {...input} disabled />);
    expect(screen.getByRole("textbox").getAttribute("readonly")).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "发送指令" }));
    fireEvent.click(screen.getByRole("button", { name: "选择项目目录" }));
    expect(screen.getByRole("button", { name: "Model" }).hasAttribute("disabled")).toBe(true);
    expect(input.onSubmitRequest).not.toHaveBeenCalled();
    expect(input.onPrepareWorkspace).not.toHaveBeenCalled();
  });

  it("does not send when Enter confirms IME composition or inserts a newline", () => {
    const input = props();
    render(<UnifiedAgentInput {...input} />);
    const textarea = screen.getByRole("textbox");
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(input.onSubmitRequest).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(input.onSubmitRequest).toHaveBeenCalledTimes(1);
  });
});
