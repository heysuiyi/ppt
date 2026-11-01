import type { AgentModelToolResultBlock, AgentModelToolUseBlock } from "../../gateway";
import type { ToolContext, ToolDefinition } from "../../tools/tool-definition";
import type { ToolInputRepair } from "../../tools/tool-input";
import { parseDefinedToolInput } from "../../tools/tool-input";
import type { ToolRegistry } from "../../tools/tool-registry";
import { shouldRunBackground } from "../background/background-task-manager";
import { triggerHooks } from "../hooks/hook-registry";
import { rethrowIfRuntimeCancellation } from "../lifecycle/runtime-cancellation";
import { authorizeToolUse, type ToolApprovalHandler } from "./permission-check";
import type { ToolExecutionOutcome } from "./tool-execution-engine";

export type ToolPreflightFailureKind =
  | "parse_error"
  | "unavailable"
  | "validation_error"
  | "policy_blocked"
  | "pre_hook_failed";

export interface PreparedToolCall {
  /** Model-visible definition that received the provider tool_use. */
  requestedTool: ToolDefinition<any, any>;
  /** Effective definition executed after safe delegation resolution. */
  tool: ToolDefinition<any, any>;
  args: any;
  mode: "foreground" | "background";
  repairs: ToolInputRepair[];
}

export type ToolPreflightOutcome =
  | {
      type: "ready";
      prepared: PreparedToolCall;
      repairs: ToolInputRepair[];
    }
  | {
      type: "immediate_result";
      kind: ToolPreflightFailureKind;
      outcome: ToolExecutionOutcome;
      tool?: ToolDefinition<any, any>;
      repairs: ToolInputRepair[];
      validationError?: string;
    }
  | {
      type: "denied";
      tool: ToolDefinition<any, any>;
      modelResult: AgentModelToolResultBlock;
      reason: string;
      repairs: ToolInputRepair[];
    }
  | {
      type: "hook_stopped";
      reason: string;
      repairs: ToolInputRepair[];
    };

export class ToolPreflight {
  constructor(private readonly registry: ToolRegistry) {}

  concurrencyDescriptor(
    toolCall: AgentModelToolUseBlock,
    context: ToolContext,
  ): { resourceKeys: readonly string[] } | undefined {
    if (toolCall.parseError) return undefined;
    const requestedTool = this.registry.get(toolCall.name);
    if (
      requestedTool?.category !== "core" ||
      requestedTool.loadPolicy !== "core" ||
      requestedTool.behavior?.completion
    ) {
      return undefined;
    }
    const requestedArgs = parseDefinedToolInput(requestedTool, toolCall.input);
    if (!requestedArgs.success) return undefined;

    let tool = requestedTool;
    let args = requestedArgs.data;
    const delegation = requestedTool.behavior?.delegation;
    if (delegation) {
      try {
        const resolved = delegation.resolve(args, context);
        const target = this.registry.get(resolved.toolName);
        if (!target || target.behavior?.completion || target.behavior?.delegation) {
          return undefined;
        }
        const targetArgs = parseDefinedToolInput(target, resolved.input);
        if (!targetArgs.success) return undefined;
        tool = target;
        args = targetArgs.data;
      } catch {
        return undefined;
      }
    }

    const concurrency = tool.behavior?.concurrency;
    if (!concurrency || tool.behavior?.background?.isRequested(args)) return undefined;
    try {
      return { resourceKeys: [...new Set(concurrency.resourceKeys?.(args, context) ?? [])] };
    } catch {
      return undefined;
    }
  }

  requiresExclusiveBatch(toolCall: AgentModelToolUseBlock, context: ToolContext): boolean {
    const requestedTool = this.registry.get(toolCall.name);
    if (!requestedTool) return false;
    if (requestedTool.behavior?.completion?.exclusiveBatch) return true;

    const delegation = requestedTool.behavior?.delegation;
    if (!delegation || toolCall.parseError) return false;
    const outerArgs = parseDefinedToolInput(requestedTool, toolCall.input);
    if (!outerArgs.success) return false;
    try {
      const target = delegation.resolve(outerArgs.data, context);
      const resolved = this.registry.get(target.toolName);
      // A missing target is fail-closed here. The batch classifier runs before
      // any sibling tools, while discovery/context may change as those siblings
      // execute. Treat an unresolved delegation as potentially terminal so a
      // later successful resolution cannot strand trailing tool_use ids.
      if (!resolved) return true;
      return resolved.behavior?.completion?.exclusiveBatch === true;
    } catch {
      // Delegation can become resolvable after an earlier call in this same
      // assistant batch (for example SearchExtraTools). Isolate it unless the
      // target is already known to be non-terminal.
      return true;
    }
  }

  async prepare(input: {
    toolCall: AgentModelToolUseBlock;
    context: ToolContext;
    workspaceRoot?: string;
    threadId: string;
    requestToolApproval?: ToolApprovalHandler;
    signal?: AbortSignal;
    policyGuidance(toolName: string): Promise<string | undefined>;
  }): Promise<ToolPreflightOutcome> {
    const { toolCall } = input;
    if (toolCall.parseError) {
      return immediate(toolCall, "parse_error", toolCall.parseError);
    }

    const requestedTool = this.registry.get(toolCall.name);
    if (requestedTool?.category !== "core" || requestedTool.loadPolicy !== "core") {
      return immediate(
        toolCall,
        "unavailable",
        "Only registered Core Tools can be called directly.",
      );
    }
    if (requestedTool.isEnabled && !requestedTool.isEnabled(input.context)) {
      return immediate(
        toolCall,
        "unavailable",
        `Tool ${requestedTool.name} is unavailable in the current runtime context.`,
        requestedTool,
      );
    }

    const requestedArgs = parseDefinedToolInput(requestedTool, toolCall.input);
    if (!requestedArgs.success) {
      const correction = [
        `Tool ${requestedTool.name} input validation failed. Correct the arguments and retry the tool call.`,
        "Pass nested objects and arrays directly; do not JSON.stringify them.",
        requestedArgs.error.message,
      ].join("\n");
      return {
        ...immediate(
          toolCall,
          "validation_error",
          correction,
          requestedTool,
          requestedArgs.repairs,
        ),
        validationError: requestedArgs.error.message,
      };
    }

    let tool = requestedTool;
    let args = requestedArgs.data;
    let repairs = [...requestedArgs.repairs];
    const delegation = requestedTool.behavior?.delegation;
    if (delegation) {
      let resolved;
      try {
        resolved = delegation.resolve(requestedArgs.data, input.context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return immediate(toolCall, "unavailable", message, requestedTool, repairs);
      }
      const target = this.registry.get(resolved.toolName);
      if (!target) {
        return immediate(
          toolCall,
          "unavailable",
          `Delegated tool not found: ${resolved.toolName}`,
          requestedTool,
          repairs,
        );
      }
      if (
        !delegation.allowedCategories.includes(target.category) ||
        !delegation.allowedLoadPolicies.includes(target.loadPolicy)
      ) {
        return immediate(
          toolCall,
          "unavailable",
          `Tool '${target.name}' is not an allowed delegation target.`,
          requestedTool,
          repairs,
        );
      }
      if (target.behavior?.delegation) {
        return immediate(
          toolCall,
          "unavailable",
          `Nested tool delegation is not allowed: ${target.name}`,
          requestedTool,
          repairs,
        );
      }
      if (target.isEnabled && !target.isEnabled(input.context)) {
        return immediate(
          toolCall,
          "unavailable",
          `Tool ${target.name} is unavailable in the current runtime context.`,
          requestedTool,
          repairs,
        );
      }
      const targetArgs = parseDefinedToolInput(target, resolved.input);
      if (!targetArgs.success) {
        const correction = [
          `Tool ${target.name} input validation failed. Correct the arguments and retry the tool call.`,
          "Pass nested objects and arrays directly; do not JSON.stringify them.",
          targetArgs.error.message,
        ].join("\n");
        return {
          ...immediate(toolCall, "validation_error", correction, target, [
            ...repairs,
            ...targetArgs.repairs,
          ]),
          validationError: targetArgs.error.message,
        };
      }
      tool = target;
      args = targetArgs.data;
      repairs = [...repairs, ...targetArgs.repairs];
    }

    try {
      await tool.validateContext?.(args, input.context);
    } catch (error) {
      return immediate(
        toolCall,
        "unavailable",
        error instanceof Error ? error.message : String(error),
        tool,
        repairs,
      );
    }

    const policyGuidance = await input.policyGuidance(tool.name);
    if (policyGuidance) {
      return immediate(toolCall, "policy_blocked", policyGuidance, tool, repairs);
    }

    const permissionBlock = {
      event: "PreToolUse" as const,
      toolName: tool.name,
      args,
      scope: "main" as const,
      workspaceRoot: input.workspaceRoot,
      threadId: input.threadId,
      permission: tool.permission,
      risk: tool.risk,
      requestToolApproval: input.requestToolApproval,
      signal: input.signal,
    };

    let authorization;
    try {
      authorization = await authorizeToolUse(permissionBlock);
    } catch (error) {
      rethrowIfRuntimeCancellation(error, input.signal, input.context.signal);
      const message = error instanceof Error ? error.message : String(error);
      return immediate(
        toolCall,
        "pre_hook_failed",
        `Permission check failed before ${tool.name} executed: ${message}`,
        tool,
        repairs,
      );
    }
    if (authorization?.toolDenied) {
      const reason = authorization.reason || "Tool call denied.";
      return {
        type: "denied",
        tool,
        reason,
        repairs,
        modelResult: notStartedResult(toolCall.id, reason),
      };
    }

    let stop;
    try {
      stop = await triggerHooks("PreToolUse", {
        ...permissionBlock,
      });
    } catch (error) {
      rethrowIfRuntimeCancellation(error, input.signal, input.context.signal);
      const message = error instanceof Error ? error.message : String(error);
      return immediate(
        toolCall,
        "pre_hook_failed",
        `PreToolUse failed before ${tool.name} executed: ${message}`,
        tool,
        repairs,
      );
    }

    if (stop?.toolDenied) {
      const reason = stop.reason || "Tool call denied.";
      return {
        type: "denied",
        tool,
        reason,
        repairs,
        modelResult: notStartedResult(toolCall.id, reason),
      };
    }
    if (stop) return { type: "hook_stopped", reason: stop.reason, repairs };

    return {
      type: "ready",
      repairs,
      prepared: {
        requestedTool,
        tool,
        args,
        mode: shouldRunBackground(tool, args) ? "background" : "foreground",
        repairs,
      },
    };
  }
}

function immediate(
  toolCall: AgentModelToolUseBlock,
  kind: ToolPreflightFailureKind,
  message: string,
  tool?: ToolDefinition<any, any>,
  repairs: ToolInputRepair[] = [],
): Extract<ToolPreflightOutcome, { type: "immediate_result" }> {
  return {
    type: "immediate_result",
    kind,
    tool,
    repairs,
    outcome: {
      executionStatus: "not_started",
      sideEffects: "none",
      deliveryStatus: "delivered",
      modelResult: notStartedResult(toolCall.id, message),
      error: message,
      warnings: [],
    },
  };
}

function notStartedResult(toolUseId: string, message: string): AgentModelToolResultBlock {
  return {
    type: "tool_result",
    toolUseId,
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
