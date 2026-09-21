import { createPptToolRegistry } from "@main/plugins/ppt/tools";
import { describe, expect, it } from "vitest";
import { SUB_AGENT_TOOLS } from "../src/main/agent/subagent/workspace-tools";
import {
  formatAgentProgressMessage,
  formatAgentToolActivity,
  formatAgentToolApprovalDetail,
  formatPublicErrorMessage,
  getAgentToolDisplayCopy,
  hasAgentToolDisplayCopy,
} from "../src/shared/agent-activity-display";
import {
  type AgentTaskNode,
  formatTaskOwnerForDisplay,
  formatTaskPlanPosition,
} from "../src/shared/agent-task-list";

describe("agent activity display", () => {
  it("covers every registered main and sub-agent tool", () => {
    const registry = createPptToolRegistry();
    const tools = [...registry.getCoreTools(), ...registry.getDeferredTools(), ...SUB_AGENT_TOOLS];

    for (const tool of tools) {
      expect(hasAgentToolDisplayCopy(tool.name), tool.name).toBe(true);
      expect(getAgentToolDisplayCopy(tool.name).action).not.toBe(tool.name);
    }

    for (const name of [
      "SubmitCommands",
      "ExecuteLayoutPlan",
      "PreviewCommands",
      "AutoLayoutSlide",
      "BeautifyChart",
      "InsertSlideImage",
    ]) {
      expect(registry.get(name), name).toBeUndefined();
      expect(hasAgentToolDisplayCopy(name), name).toBe(false);
    }
  });

  it("uses natural status copy and a safe fallback for unknown tools", () => {
    expect(formatAgentToolActivity("PreviewSvgPage", "running")).toBe("正在预览 SVG 页面…");
    expect(formatAgentToolActivity("PreviewSvgPage", "completed")).toBe("已预览 SVG 页面");
    expect(formatAgentToolActivity("SubmitSvgDeck", "failed")).toBe("提交 SVG 演示文稿未完成");
    expect(formatAgentToolActivity("ResolveProjectTemplate", "invalid-input")).toBe(
      "解析项目模板暂未执行：参数或前置条件不满足",
    );
    expect(formatAgentToolActivity("InternalFoo_v2", "completed")).toBe("已处理当前任务");
    expect(formatAgentToolActivity("InternalFoo_v2", "completed")).not.toContain("InternalFoo_v2");

    expect(
      formatAgentProgressMessage(
        "Call BeginPptCapability before using Presentation authoring, review, or proposal tools.",
      ),
    ).toContain("BeginPptCapability");
  });

  it("normalizes current runtime diagnostics", () => {
    expect(
      formatAgentProgressMessage(
        "L2 micro_compact: older tool results replaced with placeholders.",
      ),
    ).toBe("已精简较早的运行记录");
    expect(
      formatAgentProgressMessage(
        "L4 compact_history skipped: compact_history circuit breaker open",
      ),
    ).toBeNull();
    expect(formatAgentProgressMessage("输出被截断，提升 max_tokens 至 65536 后重试。")).toBe(
      "回复内容较长，正在继续生成…",
    );
    expect(formatAgentProgressMessage("后台任务 bg_0001 已启动：PreviewSvgPage: P01")).toBe(
      "已开始后台处理：预览 SVG 页面",
    );
  });

  it("keeps approval impact readable without exposing raw JSON fallbacks", () => {
    expect(formatAgentToolApprovalDetail("path: slides/cover.md")).toBe("位置：slides/cover.md");
    expect(formatAgentToolApprovalDetail('{"internal_flag":true}')).toBe(
      "此操作包含需要确认的高级设置",
    );
  });

  it("converts infrastructure errors into actionable public messages", () => {
    expect(formatPublicErrorMessage(new Error("OPENAI_API_KEY missing"))).toBe(
      "模型服务尚未正确配置，请在设置中检查连接信息。",
    );
    expect(formatPublicErrorMessage(new Error("Zod validation failed"), "请重试。")).toBe(
      "请重试。",
    );
    expect(formatPublicErrorMessage(new Error("Session not found"), "无法恢复会话。")).toBe(
      "无法恢复会话。",
    );
  });

  it("replaces internal task owner ids with collaboration roles", () => {
    const task: AgentTaskNode = {
      id: "task-1",
      revision: 0,
      subject: "整理内容",
      description: "",
      status: "in_progress",
      routing: { executionTarget: "teammate" },
      completionPolicy: "review_required",
      owner: "teammate-019f51ff",
      blocks: [],
      blockedBy: [],
      review: { state: "none" },
      reviewReceipts: [],
    };

    expect(formatTaskOwnerForDisplay(task)).toBe("协作助手");
    expect(formatTaskPlanPosition([task])).toContain("协作助手");
    expect(formatTaskPlanPosition([task])).not.toContain("teammate-019f51ff");

    const leadTask: AgentTaskNode = {
      ...task,
      routing: { executionTarget: "lead" },
      completionPolicy: "direct",
      owner: "custom-lead-owner",
    };
    expect(formatTaskOwnerForDisplay(leadTask)).toBe("主助手");
  });
});
