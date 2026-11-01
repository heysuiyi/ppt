import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  evaluateToolPermission,
  getToolPermissionProfile,
  isRiskApprovalHintRequired,
} from "../app/main/agent/runtime/tools/tool-access-policy";
import { SUB_AGENT_TOOLS } from "../app/main/agent/subagent/workspace-tools";
import { ToolRegistry } from "../app/main/agent/tools/tool-registry";

const workspaceRoot = join(tmpdir(), "ppt-tool-policy");

describe("tool access policy", () => {
  it("keeps sub-agent tool permission metadata in one policy registry", () => {
    for (const tool of SUB_AGENT_TOOLS) {
      expect(tool.permission).toBe(getToolPermissionProfile(tool.name));
      expect(tool.permission.scopes).toContain("subagent");
    }
  });

  it("allows LoadSkill for both main and subagent scopes", () => {
    expect(
      evaluateToolPermission({
        toolName: "LoadSkill",
        args: { skillName: "ppt-workflow" },
        scope: "main",
        risk: "low",
      }),
    ).toEqual({ type: "allow" });

    expect(
      evaluateToolPermission({
        toolName: "LoadSkill",
        args: { skillName: "ppt-workflow" },
        scope: "subagent",
        risk: "low",
      }),
    ).toEqual({ type: "allow" });

    expect(getToolPermissionProfile("LoadSkill")?.scopes).toEqual(["main", "subagent"]);
  });

  it("preserves hard-deny and contextual approval behavior", () => {
    expect(
      evaluateToolPermission({
        toolName: "bash",
        args: { command: "sudo rm -rf /" },
        workspaceRoot,
      }),
    ).toEqual({ type: "deny", reason: "禁止使用 sudo" });

    expect(
      evaluateToolPermission({
        toolName: "bash",
        args: { command: "rm notes.md" },
        workspaceRoot,
      }),
    ).toEqual({ type: "require_approval", reason: "删除命令：rm notes.md" });

    expect(
      evaluateToolPermission({
        toolName: "ReadFile",
        args: { path: "../outside.txt" },
        workspaceRoot,
      }),
    ).toEqual({
      type: "require_approval",
      reason: "访问工作区外的文件：../outside.txt",
    });

    expect(
      evaluateToolPermission({
        toolName: "WriteFile",
        args: { path: "notes.md", content: "hello" },
        workspaceRoot,
      }),
    ).toEqual({ type: "allow" });
  });

  it("keeps risk-based approval as a central model-visible hint", () => {
    expect(isRiskApprovalHintRequired("low")).toBe(false);
    expect(isRiskApprovalHintRequired("medium")).toBe(true);
    expect(isRiskApprovalHintRequired("high")).toBe(true);
  });

  it("evaluates definition-owned permissions without a hardcoded tool name", () => {
    const permission = {
      profile: "custom-mutator",
      description: "Apply a custom mutation.",
      scopes: ["main"] as const,
      effects: ["workspace.write"] as const,
      sandbox: "workspace" as const,
      approval: "always" as const,
      workspacePathArg: "path" as const,
    };

    expect(
      evaluateToolPermission({
        toolName: "PluginMutation",
        args: { path: "notes.md" },
        scope: "main",
        workspaceRoot,
        permission: {
          ...permission,
          scopes: [...permission.scopes],
          effects: [...permission.effects],
        },
      }),
    ).toEqual({
      type: "require_approval",
      reason: "Apply a custom mutation.",
    });

    expect(
      evaluateToolPermission({
        toolName: "PluginMutation",
        args: { path: "notes.md" },
        scope: "subagent",
        workspaceRoot,
        permission: {
          ...permission,
          scopes: [...permission.scopes],
          effects: [...permission.effects],
        },
      }),
    ).toEqual({
      type: "deny",
      reason: "Tool PluginMutation is not permitted for subagent agents.",
    });
  });

  it("fails closed without permission metadata and approves declared medium risk", () => {
    expect(
      evaluateToolPermission({
        toolName: "UnclassifiedPluginTool",
        args: {},
        scope: "main",
      }),
    ).toEqual({
      type: "deny",
      reason: "Tool UnclassifiedPluginTool has no permission profile or declared risk.",
    });

    expect(
      evaluateToolPermission({
        toolName: "DeferredMediumTool",
        args: {},
        scope: "main",
        risk: "medium",
      }),
    ).toEqual({
      type: "require_approval",
      reason: "Tool DeferredMediumTool declares medium risk.",
    });

    expect(
      evaluateToolPermission({
        toolName: "DeclaredReadOnlyTool",
        args: {},
        scope: "main",
        risk: "low",
      }),
    ).toEqual({ type: "allow" });
  });

  it("rejects incomplete execution metadata at registration", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        name: "MissingSecurityMetadata",
        description: "Invalid plugin tool.",
        category: "core",
        loadPolicy: "core",
        inputSchema: z.object({}),
        execute: async () => ({ ok: true }),
      } as never),
    ).toThrow("permission profile or risk classification");

    expect(() =>
      registry.register({
        name: "MissingCompletionCapability",
        description: "Invalid terminal plugin tool.",
        category: "core",
        loadPolicy: "core",
        inputSchema: z.object({}),
        risk: "low",
        behavior: {
          completion: {
            terminalResult: "ask_user",
            expectation: "always",
            exclusiveBatch: true,
          },
        },
        execute: async () => ({ type: "ask_user", content: "question" }),
      }),
    ).toThrow("requires capability 'user_interaction'");
  });
});
