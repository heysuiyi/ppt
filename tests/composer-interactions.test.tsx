// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatWorkspaceComposer } from "../src/renderer/src/components/ChatWorkspaceComposer";
import {
  clearAllDisplayCardManagers,
  useEnvironmentCardManager,
} from "../src/shared/cards/display-card-managers";

afterEach(() => {
  cleanup();
  clearAllDisplayCardManagers();
});

function props(): ComponentProps<typeof ChatWorkspaceComposer> {
  return {
    state: {
      phase: "welcome",
      availability: "ready",
      workspace: { kind: "draft", path: "" },
      focus: { kind: "main" },
    },
    composer: {
      request: "季度复盘",
      onChangeRequest: vi.fn(),
      onSubmitRequest: vi.fn(),
      models: [
        {
          id: "model",
          name: "Model",
          provider: "openai",
          model: "model",
          credentialConfigured: true,
        },
      ],
      selectedModelId: "model",
      onSelectModel: vi.fn(),
      workspacePath: "",
      onPrepareWorkspace: vi.fn(),
      onProposePrompt: vi.fn(),
    },
    run: { busy: false, phase: "idle", activityTrace: [] },
    runtime: { pendingToolApproval: null, canCancelRun: false },
    deck: {
      isMirrorOpen: false,
      onToggleMirror: vi.fn(),
      onOpenPreview: vi.fn(),
      onExport: vi.fn(),
    },
    actions: {
      onResolveApproval: vi.fn(),
      onResolvePatch: vi.fn(),
      onResolveQuestion: vi.fn(),
      onReviseOutline: vi.fn(),
      onUpdateMessageContent: vi.fn(),
      notify: vi.fn(),
    },
  };
}

describe("composer interactions", () => {
  it("allows URL submission without a directory and does not create global environment cards", () => {
    const input = props();
    input.composer.request = "https://example.com/report";
    render(<ChatWorkspaceComposer {...input} />);
    expect(screen.getByText("项目目录（可选）")).toBeTruthy();
    expect(screen.getByText(/系统会自动创建托管沙箱/)).toBeTruthy();
    expect(screen.getByRole("textbox").textContent).toBe("https://example.com/report");
    const send = screen.getByRole("button", { name: "发送指令" });
    expect(send.hasAttribute("disabled")).toBe(false);
    expect(send.classList.contains("is-ready")).toBe(true);
    fireEvent.click(send);
    expect(input.composer.onSubmitRequest).toHaveBeenCalledTimes(1);
    expect(useEnvironmentCardManager.getState().cards).toEqual([]);
  });

  it("disables submission when no credential-backed model is available", () => {
    const input = props();
    input.composer.models = [];
    render(<ChatWorkspaceComposer {...input} />);
    const send = screen.getByRole("button", { name: "发送指令" });
    expect(send.hasAttribute("disabled")).toBe(true);
    expect(send.classList.contains("is-ready")).toBe(false);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(input.composer.onSubmitRequest).not.toHaveBeenCalled();
  });

  it("shows welcome guidance without the retired generation-mode switch", () => {
    render(<ChatWorkspaceComposer {...props()} />);
    expect(screen.getByText(/从零生成一套演示文稿/)).toBeTruthy();
    expect(screen.queryByText("Lean")).toBeNull();
    expect(screen.queryByLabelText("选择生成模式")).toBeNull();
  });

  it("fills a suggestion without submitting it", () => {
    const input = props();
    render(<ChatWorkspaceComposer {...input} />);
    const suggestions = screen.getAllByTitle("填入输入框，确认后发送");
    fireEvent.click(suggestions[0]);
    expect(input.composer.onProposePrompt).toHaveBeenCalledWith(suggestions[0].textContent);
    expect(input.composer.onSubmitRequest).not.toHaveBeenCalled();
  });

  it("derives slash visibility from phase and request, and fills templates without sending", () => {
    const input = props();
    input.composer.request = "/";
    const { rerender } = render(<ChatWorkspaceComposer {...input} />);
    expect(screen.queryByRole("listbox", { name: "提示词模板" })).toBeNull();
    input.state.phase = "conversation";
    rerender(<ChatWorkspaceComposer {...input} />);
    const menu = screen.getByRole("listbox", { name: "提示词模板" });
    fireEvent.click(within(menu).getAllByRole("button")[0]);
    expect(input.composer.onChangeRequest).toHaveBeenCalledWith("将整套演示统一为商务蓝视觉风格");
    expect(input.composer.onSubmitRequest).not.toHaveBeenCalled();
    input.composer.request = "将整套演示统一为商务蓝视觉风格";
    rerender(<ChatWorkspaceComposer {...input} />);
    expect(screen.queryByRole("listbox", { name: "提示词模板" })).toBeNull();
    input.composer.request = "/";
    rerender(<ChatWorkspaceComposer {...input} />);
    expect(screen.getByRole("listbox", { name: "提示词模板" })).toBeTruthy();
    input.run.busy = true;
    rerender(<ChatWorkspaceComposer {...input} />);
    expect(screen.queryByRole("listbox", { name: "提示词模板" })).toBeNull();
  });

  it("disables welcome actions while loading and preserves the input when ready", () => {
    const input = props();
    input.state.availability = "loading";
    const { rerender } = render(<ChatWorkspaceComposer {...input} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea.hasAttribute("readonly")).toBe(true);
    fireEvent.click(screen.getAllByTitle("填入输入框，确认后发送")[0]);
    expect(input.composer.onProposePrompt).not.toHaveBeenCalled();
    input.state.availability = "ready";
    rerender(<ChatWorkspaceComposer {...input} />);
    expect(screen.getByRole("textbox")).toBe(textarea);
    expect(textarea.hasAttribute("readonly")).toBe(false);
  });

  it("shows a selected path with a change action, then makes bound workspace read-only", () => {
    const input = props();
    input.state.workspace = { kind: "draft", path: "e:/work/report" };
    const { rerender } = render(<ChatWorkspaceComposer {...input} />);
    expect(screen.getByText("report").getAttribute("title")).toBe("e:/work/report");
    fireEvent.click(screen.getByRole("button", { name: "更换" }));
    expect(input.composer.onPrepareWorkspace).toHaveBeenCalledTimes(1);
    input.state.workspace.kind = "bound";
    rerender(<ChatWorkspaceComposer {...input} />);
    expect(screen.getByText("已绑定目录")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更换" })).toBeNull();
    expect(screen.queryByRole("button", { name: "选择项目目录" })).toBeNull();
    input.state.phase = "conversation";
    rerender(<ChatWorkspaceComposer {...input} />);
    expect(screen.queryByText("report")).toBeNull();
  });

  it("blocks send, model selection, and directory changes during a session switch", () => {
    const input = props();
    input.state.availability = "switching";
    render(<ChatWorkspaceComposer {...input} />);
    expect(screen.getByRole("textbox").getAttribute("readonly")).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "发送指令" }));
    fireEvent.click(screen.getByRole("button", { name: "选择项目目录" }));
    expect(screen.getByRole("button", { name: "Model" }).hasAttribute("disabled")).toBe(true);
    expect(input.composer.onSubmitRequest).not.toHaveBeenCalled();
    expect(input.composer.onPrepareWorkspace).not.toHaveBeenCalled();
  });

  it("does not send when Enter confirms IME composition or inserts a newline", () => {
    const input = props();
    render(<ChatWorkspaceComposer {...input} />);
    const textarea = screen.getByRole("textbox");
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(input.composer.onSubmitRequest).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(input.composer.onSubmitRequest).toHaveBeenCalledTimes(1);
  });
});
