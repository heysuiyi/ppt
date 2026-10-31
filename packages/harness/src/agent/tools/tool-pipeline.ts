import { z } from "zod";
import type { ModelToolCallContent } from "../model/model-contract.js";
import { AgentError, asProtocolError } from "../protocol-errors.js";
import {
  type InteractionResponse,
  sameValue,
  snapshot,
  type VersionedData,
} from "../protocol-values.js";
import type {
  ToolAuthorizationPolicy,
  ToolCompletion,
  ToolExecutionContext,
  ToolResult,
  ToolSideEffects,
  ToolSuspension,
} from "./tool-contract.js";
import type { ToolExecutionResult, ToolExecutor } from "./tool-executor.js";
import type { BoundToolDefinition, ToolRegistry } from "./tool-registry.js";

const effectsSchema = z.enum(["none", "applied", "unknown"]);
const errorSchema = z.object({ code: z.string(), message: z.string() });
const dataSchema = z.object({ type: z.string(), version: z.number().int(), data: z.json() });
const interactionSchema = z.object({ id: z.string(), owner: z.string(), payload: dataSchema });
const responseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("answer"), interactionId: z.string(), value: z.json() }),
  z.object({ type: z.literal("reject"), interactionId: z.string() }),
  z.object({ type: z.literal("cancel"), interactionId: z.string() }),
]);
const callSchema = z.object({
  type: z.literal("tool-call"),
  callId: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.json()),
});
const identitySchema = z.object({
  agentId: z.string(),
  threadId: z.string(),
  queryId: z.string(),
  runId: z.string(),
});
const toolSchemaSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.json()),
});
const resultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), output: z.unknown(), effects: effectsSchema }),
  z.object({ status: z.literal("failed"), error: errorSchema, effects: effectsSchema }),
  z.object({ status: z.literal("unknown"), error: errorSchema, effects: effectsSchema }),
  z.object({
    status: z.literal("waiting"),
    interaction: interactionSchema,
    continuation: dataSchema,
    effects: effectsSchema,
  }),
]);
const savedSchema = z.object({
  kind: z.enum(["approval", "tool"]),
  token: z.string(),
  call: callSchema,
  identity: identitySchema,
  toolVersion: z.string(),
  toolOwner: z.string(),
  toolSchema: toolSchemaSchema,
  interaction: interactionSchema,
  effects: effectsSchema,
  pending: z.object({ continuation: dataSchema, response: responseSchema.optional() }).optional(),
});
type SavedInvocation = z.infer<typeof savedSchema>;
const continuationType = "agent.tool-pipeline";

function failure(error: unknown, effects: ToolSideEffects, uncertain = false): ToolCompletion {
  const protocolError = asProtocolError(error);
  return {
    status: uncertain ? "unknown" : "failed",
    error: protocolError,
    effects,
    modelContent: [{ type: "text", text: `${protocolError.code}: ${protocolError.message}` }],
  };
}

/** 授权是不可卸载的执行边界，插件只能注册工具定义。 */
export class ToolPipeline implements ToolExecutor {
  private readonly consumed = new Set<string>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly authorize: ToolAuthorizationPolicy,
  ) {}

  getSchemas() {
    return this.registry.getSchemas();
  }

  getVersion(name: string): string | undefined {
    return this.registry.getVersion(name);
  }

  private suspend(saved: SavedInvocation): ToolSuspension {
    return snapshot({
      status: "waiting",
      effects: saved.effects,
      interaction: saved.interaction,
      continuation: { type: continuationType, version: 1, data: z.json().parse(saved) },
    });
  }

  async execute(
    call: ModelToolCallContent,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    try {
      const pinned = callSchema.parse(snapshot(call));
      const identity = identitySchema.parse(snapshot(context.identity));
      if (pinned.callId !== context.callId)
        throw new AgentError("tool_call_mismatch", "Tool call ID does not match context");
      context.signal.throwIfAborted();
      const tool = this.registry.get(pinned.name);
      if (!tool) throw new AgentError("tool_unavailable", `Unknown tool: ${pinned.name}`);
      // 模式校验完成后才可询问授权；策略得到的快照不能修改待执行输入。
      const invoke = await tool.prepare(snapshot(pinned.input));
      const boundContext = { identity, callId: pinned.callId, signal: context.signal };
      const decision = await this.authorize(snapshot(pinned), {
        ...boundContext,
        identity: snapshot(identity),
      });
      context.signal.throwIfAborted();
      if (this.registry.get(pinned.name) !== tool)
        throw new AgentError("tool_stale", "Tool registration changed during authorization");
      if (decision.type === "deny") throw new AgentError("tool_denied", decision.reason);
      if (decision.type === "approval") {
        return this.suspend({
          kind: "approval",
          token: crypto.randomUUID(),
          call: pinned,
          identity,
          toolVersion: tool.version,
          toolOwner: tool.owner,
          toolSchema: toolSchemaSchema.parse(snapshot(tool.schema)),
          interaction: interactionSchema.parse(snapshot(decision.interaction)),
          effects: "none",
        });
      }
      if (decision.type !== "allow")
        throw new AgentError("tool_denied", "Invalid authorization decision");
      return await this.invoke(tool, pinned, boundContext, () => invoke(boundContext), "none");
    } catch (error) {
      return failure(error, "none");
    }
  }

  async resume(
    call: ModelToolCallContent,
    continuation: VersionedData,
    response: InteractionResponse,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    let saved: SavedInvocation | undefined;
    try {
      if (continuation.type !== continuationType || continuation.version !== 1) {
        throw new AgentError("tool_continuation_invalid", "Unsupported tool continuation");
      }
      saved = savedSchema.parse(snapshot(continuation.data));
      const pinned = callSchema.parse(snapshot(call));
      const answer = responseSchema.parse(snapshot(response));
      const identity = identitySchema.parse(snapshot(context.identity));
      if (
        !sameValue(saved.call, pinned) ||
        pinned.callId !== context.callId ||
        saved.identity.agentId !== identity.agentId ||
        saved.identity.threadId !== identity.threadId ||
        saved.identity.queryId !== identity.queryId
      ) {
        throw new AgentError(
          "tool_call_mismatch",
          "Continuation does not belong to this invocation",
        );
      }
      if (saved.interaction.id !== answer.interactionId)
        throw new AgentError(
          "tool_response_mismatch",
          "Interaction response does not match continuation",
        );
      if (this.consumed.has(saved.token))
        throw new AgentError("tool_continuation_consumed", "Continuation has already been resumed");
      context.signal.throwIfAborted();
      const tool = this.registry.get(pinned.name);
      if (
        !tool ||
        tool.version !== saved.toolVersion ||
        tool.owner !== saved.toolOwner ||
        !sameValue(tool.schema, saved.toolSchema)
      )
        throw new AgentError(
          "tool_stale",
          "Tool version, owner or schema changed since suspension",
        );
      const invoke = await tool.prepare(snapshot(pinned.input));
      const boundContext = { identity, callId: pinned.callId, signal: context.signal };
      const decision = await this.authorize(snapshot(pinned), {
        ...boundContext,
        identity: snapshot(boundContext.identity),
      });
      context.signal.throwIfAborted();
      if (this.registry.get(pinned.name) !== tool)
        throw new AgentError("tool_stale", "Tool registration changed during authorization");
      if (this.consumed.has(saved.token))
        throw new AgentError("tool_continuation_consumed", "Continuation has already been resumed");
      if (decision.type === "deny") throw new AgentError("tool_denied", decision.reason);
      if (saved.kind === "approval") {
        if (answer.type !== "answer" || answer.value !== true)
          throw new AgentError("tool_approval_rejected", "Tool approval was not affirmative");
        if (decision.type === "approval" && !sameValue(decision.interaction, saved.interaction)) {
          throw new AgentError(
            "tool_approval_changed",
            "Authorization requirements changed since approval was requested",
          );
        }
      } else if (decision.type === "approval") {
        this.consumed.add(saved.token);
        return this.suspend({
          ...saved,
          kind: "approval",
          token: crypto.randomUUID(),
          interaction: interactionSchema.parse(snapshot(decision.interaction)),
          pending: {
            continuation: dataSchema.parse(snapshot(this.toolContinuation(saved))),
            response: answer,
          },
        });
      }
      if (decision.type !== "allow" && decision.type !== "approval")
        throw new AgentError("tool_denied", "Invalid authorization decision");
      if (this.registry.get(pinned.name) !== tool)
        throw new AgentError("tool_stale", "Tool registration changed during authorization");
      // 检查与消费在最后一个 await 之后相邻执行，阻止并发恢复重复进入工具体。
      if (this.consumed.has(saved.token))
        throw new AgentError("tool_continuation_consumed", "Continuation has already been resumed");
      this.consumed.add(saved.token);
      const pending = saved.pending;
      if (saved.kind === "tool" || pending) {
        if (!tool.resume)
          throw new AgentError("tool_not_resumable", "Tool does not support resume");
        const nested = this.toolContinuation(saved);
        const nestedResponse = saved.kind === "approval" ? pending?.response : answer;
        if (!nestedResponse)
          throw new AgentError(
            "tool_continuation_invalid",
            "Missing original interaction response",
          );
        const resume = tool.resume;
        return await this.invoke(
          tool,
          pinned,
          boundContext,
          () => resume(snapshot(nested), snapshot(nestedResponse), boundContext),
          saved.effects,
        );
      }
      return await this.invoke(
        tool,
        pinned,
        boundContext,
        () => invoke(boundContext),
        saved.effects,
      );
    } catch (error) {
      return failure(error, saved?.effects ?? "unknown");
    }
  }

  private toolContinuation(saved: SavedInvocation): VersionedData {
    if (!saved.pending)
      throw new AgentError("tool_continuation_invalid", "Missing tool continuation");
    return saved.pending.continuation;
  }

  private async invoke(
    tool: BoundToolDefinition,
    call: ModelToolCallContent,
    context: ToolExecutionContext,
    body: () => Promise<ToolResult | ToolSuspension>,
    previousEffects: ToolSideEffects,
  ): Promise<ToolExecutionResult> {
    let effects = previousEffects;
    let entered = false;
    const identity = snapshot(context.identity);
    const signal = context.signal;
    try {
      signal.throwIfAborted();
      entered = true;
      const raw = await body();
      // 不可信结果即使违反协议，也不能抹去已明确报告的副作用。
      const reported = effectsSchema.safeParse(raw?.effects);
      if (reported.success) {
        effects =
          effects === "applied" || reported.data === "applied"
            ? "applied"
            : effects === "unknown" || reported.data === "unknown"
              ? "unknown"
              : "none";
      } else effects = effects === "applied" ? "applied" : "unknown";
      const result = resultSchema.parse(raw);
      if (signal.aborted)
        return failure(new AgentError("tool_cancelled", "Tool execution was cancelled"), effects);
      if (result.status === "waiting") {
        if (!tool.resume)
          throw new AgentError("tool_not_resumable", "Immediate tool cannot suspend");
        return this.suspend({
          kind: "tool",
          token: crypto.randomUUID(),
          call: callSchema.parse(snapshot(call)),
          identity,
          toolVersion: tool.version,
          toolOwner: tool.owner,
          interaction: result.interaction,
          effects,
          toolSchema: toolSchemaSchema.parse(snapshot(tool.schema)),
          pending: { continuation: snapshot(result.continuation) },
        });
      }
      try {
        const completion = await tool.project({ ...result, effects });
        return signal.aborted
          ? failure(new AgentError("tool_cancelled", "Tool execution was cancelled"), effects)
          : completion;
      } catch (error) {
        return failure(error, effects);
      }
    } catch (error) {
      if (entered) effects = effects === "applied" ? "applied" : "unknown";
      return failure(error, effects, entered);
    }
  }
}
