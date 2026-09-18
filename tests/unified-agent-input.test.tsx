import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UnifiedAgentInput } from "../src/renderer/src/components/UnifiedAgentInput";

const CONFIGURED_MODEL = {
  id: "configured-model",
  name: "Configured Model",
  provider: "openai" as const,
  model: "configured-model",
  baseURL: "https://api.openai.com/v1",
  openaiApiMode: "responses" as const,
  credentialConfigured: true,
};

describe("UnifiedAgentInput draft workspace", () => {
  it("keeps URL input and submission available before a workspace directory is selected", () => {
    const html = renderToStaticMarkup(
      <UnifiedAgentInput
        request="https://example.com/report"
        onChangeRequest={vi.fn()}
        onSubmitRequest={vi.fn()}
        busy={false}
        models={[CONFIGURED_MODEL]}
        selectedModelId={CONFIGURED_MODEL.id}
        setSelectedModelId={vi.fn()}
        layoutMode="center"
        workspacePath=""
        onPrepareWorkspace={vi.fn()}
      />,
    );

    expect(html).toContain("项目目录（可选）");
    expect(html).toContain("系统会自动创建托管沙箱");
    expect(html).toContain("向演示文稿 Agent 输入指令");
    expect(html).toContain("https://example.com/report");

    const sendButton = html.match(/<button[^>]*aria-label="发送指令"[^>]*>/)?.[0];
    expect(sendButton).toBeDefined();
    expect(sendButton).not.toContain("disabled");
    expect(sendButton).toContain("send-cta-btn is-ready");
  });

  it("disables submission when no credential-backed model is available", () => {
    const html = renderToStaticMarkup(
      <UnifiedAgentInput
        request="生成一份复盘"
        onChangeRequest={vi.fn()}
        onSubmitRequest={vi.fn()}
        busy={false}
        models={[]}
        selectedModelId=""
        setSelectedModelId={vi.fn()}
        layoutMode="center"
      />,
    );

    const sendButton = html.match(/<button[^>]*aria-label="发送指令"[^>]*>/)?.[0];
    expect(sendButton).toBeDefined();
    expect(sendButton).toContain("disabled");
    expect(sendButton).not.toContain("is-ready");
  });

  it("does not expose the retired Lean mode switch", () => {
    const html = renderToStaticMarkup(
      <UnifiedAgentInput
        request="为管理层生成经营复盘"
        onChangeRequest={vi.fn()}
        onSubmitRequest={vi.fn()}
        busy={false}
        models={[]}
        selectedModelId=""
        setSelectedModelId={vi.fn()}
        layoutMode="center"
      />,
    );

    expect(html).not.toContain("选择生成模式");
    expect(html).not.toContain(">Lean<");
    expect(html).toContain("从零生成一套演示文稿");
  });
});
