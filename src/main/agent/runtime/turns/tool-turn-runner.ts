import type { AgentModelToolResultBlock, AgentModelToolUseBlock } from "../../gateway";
import type { ToolDefinition } from "../../tools/tool-definition";
import { describeBackgroundTask } from "../background/background-task-manager";
import {
  isRuntimeCancellation,
  rethrowIfRuntimeCancellation,
} from "../lifecycle/runtime-cancellation";
import type { AgentIterationWorkspace, AgentQueryState } from "../query/query-types";
import type { ToolExecutionOutcome } from "../tools/tool-execution-engine";
import type { PreparedToolCall, ToolPreflightOutcome } from "../tools/tool-preflight";
import type { AgentLoopTurnOutcome, PreparedAgentRun } from "./prepared-agent-run";

const MAX_PARALLEL_TOOLS = 4;

type ParallelEntry =
  | {
      type: "ready";
      toolCall: AgentModelToolUseBlock;
      prepared: PreparedToolCall;
    }
  | {
      type: "preflight";
      toolCall: AgentModelToolUseBlock;
      preflight: Exclude<ToolPreflightOutcome, { type: "ready" | "hook_stopped" }>;
    }
  | {
      type: "not_permitted";
      toolCall: AgentModelToolUseBlock;
    };

/** Runs claim → checkpoint → preflight → dispatch → interpretation as one transaction. */
export class ToolTurnRunner {
  async runBatch(
    run: PreparedAgentRun,
    toolCalls: readonly AgentModelToolUseBlock[],
    workspace: AgentIterationWorkspace,
    state: AgentQueryState,
  ): Promise<AgentLoopTurnOutcome> {
    throwIfRunCancelled(run.scope.signal, run.params.deps.externalSignal);
    if (
      toolCalls.length > 1 &&
      toolCalls.some((call) =>
        run.input.toolPreflight.requiresExclusiveBatch(call, workspace.updatedToolUseContext),
      )
    ) {
      for (const toolCall of toolCalls) {
        throwIfRunCancelled(run.scope.signal, run.params.deps.externalSignal);
        const result: AgentModelToolResultBlock = {
          type: "tool_result",
          toolUseId: toolCall.id,
          isError: true,
          content: [
            {
              type: "text",
              text:
                "Terminal tools must be called alone. No tool in this mixed batch was executed; " +
                "call ordinary tools first, then issue the terminal tool in a separate assistant response.",
            },
          ],
        };
        run.scope.applyTransition({ type: "tool_processed", result });
        workspace.toolResults.push(structuredClone(result));
        run.appendRuntimeEvent(
          "tool_result",
          {
            toolUseId: toolCall.id,
            toolName: toolCall.name,
            isError: true,
            content: structuredClone(result.content),
          },
          "model_only",
        );
        run.emitProgress({
          type: "tool-state",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          status: "invalid-input",
          message: `工具 ${toolCall.name} 不能与终结工具在同一批次执行`,
        });
      }
      return { type: "continue" };
    }

    for (let index = 0; index < toolCalls.length; ) {
      const toolCall = toolCalls[index]!;
      throwIfRunCancelled(run.scope.signal, run.params.deps.externalSignal);
      if (workspace.toolResults.some((result) => result.toolUseId === toolCall.id)) {
        index += 1;
        continue;
      }
      const first = run.input.toolPreflight.concurrencyDescriptor(
        toolCall,
        workspace.updatedToolUseContext,
      );
      if (first) {
        const wave = [toolCall];
        const resourceKeys = new Set(first.resourceKeys);
        let cursor = index + 1;
        while (cursor < toolCalls.length && wave.length < MAX_PARALLEL_TOOLS) {
          const candidate = toolCalls[cursor]!;
          if (workspace.toolResults.some((result) => result.toolUseId === candidate.id)) {
            cursor += 1;
            continue;
          }
          const descriptor = run.input.toolPreflight.concurrencyDescriptor(
            candidate,
            workspace.updatedToolUseContext,
          );
          if (!descriptor || descriptor.resourceKeys.some((key) => resourceKeys.has(key))) break;
          wave.push(candidate);
          descriptor.resourceKeys.forEach((key) => resourceKeys.add(key));
          cursor += 1;
        }
        if (wave.length > 1) {
          const outcome = await this.runParallelWave(run, wave, workspace, state);
          if (outcome.type === "terminal") return outcome;
          index = cursor;
          continue;
        }
      }
      const outcome = await this.runOne(run, toolCall, workspace, state);
      if (outcome.type === "terminal") return outcome;
      await run.scope.persistCheckpoint();
      index += 1;
    }
    return { type: "continue" };
  }

  private async runParallelWave(
    run: PreparedAgentRun,
    toolCalls: readonly AgentModelToolUseBlock[],
    workspace: AgentIterationWorkspace,
    state: AgentQueryState,
  ): Promise<AgentLoopTurnOutcome> {
    const { scope, params } = run;
    const { session } = scope;
    const deps = params.deps;
    const entries: ParallelEntry[] = [];

    for (const toolCall of toolCalls) {
      throwIfRunCancelled(scope.signal, deps.externalSignal);
      run.appendRuntimeEvent(
        "tool_call",
        {
          toolUseId: toolCall.id,
          toolName: toolCall.name,
          input: structuredClone(toolCall.input),
          parseError: toolCall.parseError,
        },
        "model_only",
      );
      const canUseTool = await params.canUseTool(toolCall, workspace.updatedToolUseContext);
      throwIfRunCancelled(scope.signal, deps.externalSignal);
      if (!canUseTool) {
        entries.push({ type: "not_permitted", toolCall });
        continue;
      }
      const preflight = await run.input.toolPreflight.prepare({
        toolCall,
        context: workspace.updatedToolUseContext,
        workspaceRoot: deps.workspaceRoot,
        threadId: deps.threadId,
        requestToolApproval: deps.requestToolApproval,
        signal: scope.signal,
        policyGuidance: async () => undefined,
      });
      throwIfRunCancelled(scope.signal, deps.externalSignal);
      if (preflight.repairs.length > 0) {
        run.appendRuntimeEvent(
          "workflow_progress",
          {
            type: "tool-input-repaired",
            toolName: toolCall.name,
            toolUseId: toolCall.id,
            repairs: preflight.repairs,
          },
          "internal",
        );
      }
      if (preflight.type === "hook_stopped") {
        for (const sibling of toolCalls) {
          const result: AgentModelToolResultBlock = {
            type: "tool_result",
            toolUseId: sibling.id,
            isError: true,
            content: [
              {
                type: "text",
                text:
                  sibling.id === toolCall.id
                    ? preflight.reason
                    : `Tool batch stopped before execution because ${toolCall.name} was blocked by a PreToolUse hook.`,
              },
            ],
          };
          this.recordToolResultBlock(run, workspace, sibling, result);
          run.emitProgress({
            type: "tool-state",
            toolCallId: sibling.id,
            toolName: sibling.name,
            status: "failed",
            message: `工具 ${sibling.name} 未执行`,
            error: preflight.reason,
          });
        }
        await scope.persistCheckpoint();
        return { type: "terminal", result: { type: "message", content: preflight.reason } };
      }
      if (preflight.type === "ready") {
        entries.push({ type: "ready", toolCall, prepared: preflight.prepared });
      } else {
        entries.push({ type: "preflight", toolCall, preflight });
      }
    }

    const ready = entries.filter(
      (entry): entry is Extract<ParallelEntry, { type: "ready" }> => entry.type === "ready",
    );
    if (ready.length > 0) {
      for (const entry of ready) {
        scope.applyTransition({ type: "tool_claimed", toolUse: entry.toolCall });
        run.emitProgress({
          type: "tool-state",
          toolCallId: entry.toolCall.id,
          message: `正在调用工具 ${entry.prepared.tool.name}...`,
          toolName: entry.prepared.tool.name,
          status: "running",
        });
      }
      scope.setInflightQuery(
        "tool_running",
        workspace,
        ready.map((entry) => entry.toolCall),
      );
      await scope.persistCheckpoint();
    }

    const hookGates = ready.map(() => deferredVoid());
    const hookInvoked = ready.map(() => false);
    const executions = ready.map((entry, index) => {
      const prior = index === 0 ? Promise.resolve() : hookGates[index - 1]!.promise;
      const execution = run.input.toolExecutionEngine.execute({
        tool: entry.prepared.tool,
        args: entry.prepared.args,
        context: workspace.updatedToolUseContext,
        toolCall: entry.toolCall,
        modelArtifactRoot: deps.workspaceRoot,
        threadId: deps.threadId,
        signal: scope.signal,
        runPostToolUseHook: async (block) => {
          hookInvoked[index] = true;
          await prior;
          try {
            return await run.input.runPostToolUseHook(block);
          } finally {
            hookGates[index]!.resolve();
          }
        },
      });
      void execution
        .finally(() => {
          if (!hookInvoked[index]) {
            void prior.then(() => hookGates[index]!.resolve());
          }
        })
        .catch(() => undefined);
      return execution;
    });
    const settled = await Promise.allSettled(executions);
    const cancellation = settled.find(
      (item) =>
        item.status === "rejected" &&
        isRuntimeCancellation(item.reason, scope.signal, deps.externalSignal),
    );
    if (
      cancellation?.status === "rejected" ||
      scope.signal.aborted ||
      deps.externalSignal?.aborted
    ) {
      for (const entry of ready) {
        run.emitProgress({
          type: "tool-state",
          toolCallId: entry.toolCall.id,
          message: `工具 ${entry.prepared.tool.name} 已取消`,
          toolName: entry.prepared.tool.name,
          status: "denied",
        });
      }
      throw cancellation?.status === "rejected"
        ? cancellation.reason
        : new Error("Run aborted by user.");
    }

    const outcomes = new Map<string, ToolExecutionOutcome>();
    ready.forEach((entry, index) => {
      const result = settled[index]!;
      outcomes.set(
        entry.toolCall.id,
        result.status === "fulfilled"
          ? result.value
          : unexpectedExecutionFailure(entry.toolCall, result.reason),
      );
    });

    for (const entry of entries) {
      let outcome: AgentLoopTurnOutcome;
      if (entry.type === "ready") {
        outcome = await this.finalizeExecutionOutcome(
          run,
          entry.toolCall,
          entry.prepared.tool,
          outcomes.get(entry.toolCall.id)!,
          workspace,
          state,
        );
      } else if (entry.type === "preflight") {
        this.finalizePreflightFailure(run, entry.toolCall, entry.preflight, workspace);
        outcome = { type: "continue" };
      } else {
        const result: AgentModelToolResultBlock = {
          type: "tool_result",
          toolUseId: entry.toolCall.id,
          content: [
            { type: "text", text: `Tool ${entry.toolCall.name} is not permitted in this query.` },
          ],
          isError: true,
        };
        session.appendTranscript({
          role: "tool",
          toolName: entry.toolCall.name,
          error: textFromResult(result),
          executionStatus: "not_started",
          sideEffects: "none",
        });
        run.emitProgress({
          type: "tool-state",
          toolCallId: entry.toolCall.id,
          toolName: entry.toolCall.name,
          status: "denied",
          message: `工具 ${entry.toolCall.name} 在当前任务中不可用`,
        });
        this.recordToolResultBlock(run, workspace, entry.toolCall, result);
        outcome = { type: "continue" };
      }
      if (outcome.type === "terminal") return outcome;
    }
    scope.setInflightQuery("model_received", workspace);
    await scope.persistCheckpoint();
    return { type: "continue" };
  }

  private finalizePreflightFailure(
    run: PreparedAgentRun,
    toolCall: AgentModelToolUseBlock,
    preflight: Extract<ParallelEntry, { type: "preflight" }>["preflight"],
    workspace: AgentIterationWorkspace,
  ): void {
    const { session } = run.scope;
    if (preflight.type === "denied") {
      run.emitProgress({
        type: "tool-state",
        toolCallId: toolCall.id,
        message: `工具 ${preflight.tool.name} 被拒绝: ${preflight.reason}`,
        toolName: preflight.tool.name,
        status: "denied",
      });
      session.appendTranscript({
        role: "tool",
        toolName: preflight.tool.name,
        error: preflight.reason,
        executionStatus: "not_started",
        sideEffects: "none",
      });
      this.recordToolResultBlock(run, workspace, toolCall, preflight.modelResult);
      return;
    }

    const text = textFromResult(preflight.outcome.modelResult);
    if (preflight.kind === "validation_error") {
      const failures = (workspace.validationFailuresByTool.get(toolCall.name) ?? 0) + 1;
      workspace.validationFailuresByTool.set(toolCall.name, failures);
      if (failures <= 2) {
        run.emitProgress({
          type: "request-status",
          message: `正在自动修正工具 ${toolCall.name} 的参数…`,
          progress: 0,
        });
      }
    } else if (preflight.kind === "policy_blocked") {
      run.emitProgress({
        type: "workflow-progress",
        message: "正在先建立可见任务计划...",
        progress: 0,
      });
    }
    const status =
      preflight.kind === "pre_hook_failed"
        ? "failed"
        : preflight.kind === "policy_blocked"
          ? "denied"
          : "invalid-input";
    run.emitProgress({
      type: "tool-state",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      status,
      message:
        preflight.kind === "parse_error"
          ? `工具 ${toolCall.name} 参数 JSON 解析失败`
          : preflight.kind === "unavailable"
            ? `工具 ${toolCall.name} 无法直接调用`
            : preflight.kind === "validation_error"
              ? `工具 ${toolCall.name} 参数校验失败`
              : preflight.kind === "policy_blocked"
                ? `工具 ${toolCall.name} 被当前任务策略阻止`
                : `工具 ${toolCall.name} 执行前检查失败`,
      error: preflight.validationError ?? text,
    });
    session.appendTranscript({
      role: "tool",
      toolName: toolCall.name,
      error: text,
      executionStatus: "not_started",
      sideEffects: "none",
    });
    this.recordToolResultBlock(run, workspace, toolCall, preflight.outcome.modelResult);
  }

  private async finalizeExecutionOutcome(
    run: PreparedAgentRun,
    toolCall: AgentModelToolUseBlock,
    tool: PreparedToolCall["tool"],
    outcome: ToolExecutionOutcome,
    workspace: AgentIterationWorkspace,
    state: AgentQueryState,
  ): Promise<AgentLoopTurnOutcome> {
    const { scope } = run;
    const outcomeText = textFromResult(outcome.modelResult);
    if (outcome.executionStatus === "threw") {
      run.emitProgress({
        type: "tool-state",
        toolCallId: toolCall.id,
        message: `工具 ${tool.name} 执行失败: ${outcomeText}`,
        toolName: tool.name,
        status: "failed",
      });
      scope.session.appendTranscript({
        role: "tool",
        toolName: tool.name,
        error: outcomeText,
        sideEffects: outcome.sideEffects,
      });
      this.recordToolResultBlock(run, workspace, toolCall, outcome.modelResult);
      return { type: "continue" };
    }
    if (outcome.deliveryStatus === "validation_failed") {
      run.emitProgress({
        type: "tool-state",
        toolCallId: toolCall.id,
        message: `工具 ${tool.name} 返回结果未通过校验`,
        toolName: tool.name,
        status: "invalid-input",
        error: outcomeText,
      });
      scope.session.appendTranscript({
        role: "tool",
        toolName: tool.name,
        error: outcomeText,
        executionStatus: "returned",
        sideEffects: outcome.sideEffects,
      });
      this.recordToolResultBlock(run, workspace, toolCall, outcome.modelResult);
      return { type: "continue" };
    }

    run.emitProgress({
      type: "tool-state",
      toolCallId: toolCall.id,
      message: `工具 ${tool.name} 执行完成。`,
      toolName: tool.name,
      status: "completed",
    });
    emitToolProgress(run, tool, toolCall, outcome);
    try {
      const decision = await run.input.completionPolicy.interpret({
        tool,
        toolUseId: toolCall.id,
        outcome,
        context: workspace.updatedToolUseContext,
        emitProgress: (event) => run.emitProgress(event),
      });
      if (decision.type === "terminal") {
        if (decision.modelResult) {
          this.recordToolResultBlock(run, workspace, toolCall, decision.modelResult);
        }
        if (decision.result.type === "ask_user") {
          scope.setInflightQuery("waiting_user", workspace);
        } else {
          scope.stageConversationHistory(state, workspace);
        }
        return { type: "terminal", result: decision.result };
      }
      scope.session.appendTranscript(decision.transcriptEntry);
      this.recordToolResultBlock(run, workspace, toolCall, decision.modelResult);
      return { type: "continue" };
    } catch (error) {
      rethrowIfRuntimeCancellation(error, scope.signal, run.params.deps.externalSignal);
      const message = error instanceof Error ? error.message : String(error);
      const guidance =
        `Tool ${tool.name} executed successfully, but result post-processing failed: ${message}. ` +
        "Do not retry blindly; inspect durable artifacts first.";
      scope.session.appendTranscript({
        role: "tool",
        toolName: tool.name,
        result: outcome.validatedResult,
        postProcessingError: message,
        executionStatus: "returned",
      });
      this.recordToolResultBlock(run, workspace, toolCall, {
        type: "tool_result",
        toolUseId: toolCall.id,
        content: [{ type: "text", text: guidance }],
      });
      return { type: "continue" };
    }
  }

  private recordToolResultBlock(
    run: PreparedAgentRun,
    workspace: AgentIterationWorkspace,
    toolCall: AgentModelToolUseBlock,
    result: AgentModelToolResultBlock,
  ): void {
    workspace.toolResults.push(structuredClone(result));
    const decision = run.scope.applyTransition({ type: "tool_processed", result });
    if (decision !== "commit_before_next") {
      throw new Error("CheckpointPolicy rejected a normal tool result transition.");
    }
    run.scope.setInflightQuery("model_received", workspace);
    run.appendRuntimeEvent(
      "tool_result",
      {
        toolUseId: toolCall.id,
        toolName: toolCall.name,
        isError: result.isError === true,
        content: structuredClone(result.content),
      },
      "model_only",
    );
  }

  private async runOne(
    run: PreparedAgentRun,
    toolCall: AgentModelToolUseBlock,
    workspace: AgentIterationWorkspace,
    state: AgentQueryState,
  ): Promise<AgentLoopTurnOutcome> {
    const { scope, params } = run;
    const { session, backgroundTasks } = scope;
    const deps = params.deps;
    const rethrowIfCancelled = (error: unknown): void => {
      rethrowIfRuntimeCancellation(error, scope.signal, deps.externalSignal);
    };
    const throwIfCancelled = (): void => {
      throwIfRunCancelled(scope.signal, deps.externalSignal);
    };

    throwIfCancelled();
    scope.setInflightQuery("tool_running", workspace, [toolCall]);
    const claimDecision = scope.applyTransition({ type: "tool_claimed", toolUse: toolCall });
    run.appendRuntimeEvent(
      "tool_call",
      {
        toolUseId: toolCall.id,
        toolName: toolCall.name,
        input: structuredClone(toolCall.input),
        parseError: toolCall.parseError,
      },
      "model_only",
    );
    if (claimDecision === "commit") await scope.persistCheckpoint();
    throwIfCancelled();

    const recordToolResultBlock = (result: AgentModelToolResultBlock): void => {
      workspace.toolResults.push(structuredClone(result));
      const decision = scope.applyTransition({ type: "tool_processed", result });
      if (decision !== "commit_before_next") {
        throw new Error("CheckpointPolicy rejected a normal tool result transition.");
      }
      // The active tool is no longer uncertain once its provider-facing result
      // exists. Refresh the durable Workspace before the batch advances.
      scope.setInflightQuery("model_received", workspace);
      run.appendRuntimeEvent(
        "tool_result",
        {
          toolUseId: toolCall.id,
          toolName: toolCall.name,
          isError: result.isError === true,
          content: structuredClone(result.content),
        },
        "model_only",
      );
    };
    const recordToolResult = (
      text: string,
      isError = false,
      images?: Array<{
        mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
        data: string;
      }>,
    ): void => {
      recordToolResultBlock({
        type: "tool_result",
        toolUseId: toolCall.id,
        content: [
          { type: "text", text },
          ...(images ?? []).map((image) => ({ type: "image" as const, ...image })),
        ],
        ...(isError ? { isError: true } : {}),
      });
    };

    const canUseTool = await params.canUseTool(toolCall, workspace.updatedToolUseContext);
    throwIfCancelled();
    if (!canUseTool) {
      recordToolResult(`Tool ${toolCall.name} is not permitted in this query.`, true);
      run.emitProgress({
        type: "tool-state",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        status: "denied",
        message: `工具 ${toolCall.name} 在当前任务中不可用`,
      });
      return { type: "continue" };
    }

    throwIfCancelled();
    const preflight = await run.input.toolPreflight.prepare({
      toolCall,
      context: workspace.updatedToolUseContext,
      workspaceRoot: deps.workspaceRoot,
      threadId: deps.threadId,
      requestToolApproval: deps.requestToolApproval,
      signal: scope.signal,
      policyGuidance: async () => undefined,
    });
    throwIfCancelled();
    if (preflight.repairs.length > 0) {
      run.appendRuntimeEvent(
        "workflow_progress",
        {
          type: "tool-input-repaired",
          toolName: toolCall.name,
          toolUseId: toolCall.id,
          repairs: preflight.repairs,
        },
        "internal",
      );
    }

    if (preflight.type === "immediate_result") {
      const text = textFromResult(preflight.outcome.modelResult);
      if (preflight.kind === "validation_error") {
        const failures = (workspace.validationFailuresByTool.get(toolCall.name) ?? 0) + 1;
        workspace.validationFailuresByTool.set(toolCall.name, failures);
        if (failures <= 2) {
          run.emitProgress({
            type: "request-status",
            message: `正在自动修正工具 ${toolCall.name} 的参数…`,
            progress: 0,
          });
        }
      } else if (preflight.kind === "policy_blocked") {
        run.emitProgress({
          type: "workflow-progress",
          message: "正在先建立可见任务计划...",
          progress: 0,
        });
      }
      const status =
        preflight.kind === "pre_hook_failed"
          ? "failed"
          : preflight.kind === "policy_blocked"
            ? "denied"
            : "invalid-input";
      run.emitProgress({
        type: "tool-state",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        status,
        message:
          preflight.kind === "parse_error"
            ? `工具 ${toolCall.name} 参数 JSON 解析失败`
            : preflight.kind === "unavailable"
              ? `工具 ${toolCall.name} 无法直接调用`
              : preflight.kind === "validation_error"
                ? `工具 ${toolCall.name} 参数校验失败`
                : preflight.kind === "policy_blocked"
                  ? `工具 ${toolCall.name} 被当前任务策略阻止`
                  : `工具 ${toolCall.name} 执行前检查失败`,
        error: preflight.validationError ?? text,
      });
      session.appendTranscript({
        role: "tool",
        toolName: toolCall.name,
        error: text,
        executionStatus: "not_started",
        sideEffects: "none",
      });
      recordToolResultBlock(preflight.outcome.modelResult);
      return { type: "continue" };
    }

    if (preflight.type === "denied") {
      run.emitProgress({
        type: "tool-state",
        toolCallId: toolCall.id,
        message: `工具 ${preflight.tool.name} 被拒绝: ${preflight.reason}`,
        toolName: preflight.tool.name,
        status: "denied",
      });
      session.appendTranscript({
        role: "tool",
        toolName: preflight.tool.name,
        error: preflight.reason,
        executionStatus: "not_started",
        sideEffects: "none",
      });
      recordToolResultBlock(preflight.modelResult);
      return { type: "continue" };
    }
    if (preflight.type === "hook_stopped") {
      run.emitProgress({
        type: "tool-state",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        status: "failed",
        message: `工具 ${toolCall.name} 被执行前钩子终止`,
        error: preflight.reason,
      });
      return { type: "terminal", result: { type: "message", content: preflight.reason } };
    }

    const { tool, args, mode } = preflight.prepared;
    run.emitProgress({
      type: "tool-state",
      toolCallId: toolCall.id,
      message: `正在调用工具 ${tool.name}...`,
      toolName: tool.name,
      status: "running",
    });
    try {
      if (
        run.input.completionPolicy.canTerminate(tool) &&
        (backgroundTasks.hasRunning() || backgroundTasks.hasPendingNotifications())
      ) {
        const guidance =
          `Paused ${tool.name} because background task results are not yet incorporated. ` +
          "Review the task_notification content, then call the appropriate finish tool again.";
        session.appendTranscript({
          role: "tool",
          toolName: tool.name,
          result: { pausedForBackgroundTasks: true, guidance },
        });
        recordToolResult(guidance);
        await run.drainBackgroundForModel(
          workspace,
          "Background tasks have completed. Reconsider these results before calling a finish tool.",
        );
        run.emitProgress({
          type: "tool-state",
          toolCallId: toolCall.id,
          message: `工具 ${tool.name} 已等待后台任务结果。`,
          toolName: tool.name,
          status: "completed",
        });
        return { type: "continue" };
      }

      if (mode === "background") {
        const label = describeBackgroundTask(tool, args);
        let bgId = "";
        const scheduled = backgroundTasks.prepare({
          toolName: tool.name,
          label,
          toolUseId: toolCall.id,
          run: async () => {
            throwIfCancelled();
            let outcome: ToolExecutionOutcome;
            try {
              outcome = await run.input.toolExecutionEngine.execute({
                tool,
                args,
                context: workspace.updatedToolUseContext,
                toolCall,
                modelArtifactRoot: deps.workspaceRoot,
                threadId: deps.threadId,
                signal: scope.signal,
                runPostToolUseHook: run.input.runPostToolUseHook,
              });
              throwIfCancelled();
            } catch (error) {
              const errorText = error instanceof Error ? error.message : String(error);
              if (isRuntimeCancellation(error, scope.signal, deps.externalSignal)) {
                run.emitProgress({
                  type: "tool-state",
                  toolCallId: toolCall.id,
                  message: `后台任务 ${bgId} 已取消`,
                  toolName: tool.name,
                  status: "denied",
                });
                throw error;
              }
              run.emitProgress({
                type: "tool-state",
                toolCallId: toolCall.id,
                message: `后台任务 ${bgId} 执行失败：${errorText}`,
                toolName: tool.name,
                status: "failed",
                error: errorText,
              });
              throw error;
            }
            const content = textFromResult(outcome.modelResult);
            if (
              outcome.executionStatus === "threw" ||
              outcome.deliveryStatus === "validation_failed"
            ) {
              run.emitProgress({
                type: "tool-state",
                toolCallId: toolCall.id,
                message: `后台任务 ${bgId} 执行失败：${content}`,
                toolName: tool.name,
                status: "failed",
              });
              throw new Error(content);
            }
            run.emitProgress({
              type: "tool-state",
              toolCallId: toolCall.id,
              message: `后台任务 ${bgId} 已完成：${tool.name}`,
              toolName: tool.name,
              status: "completed",
            });
            return content;
          },
        });
        bgId = scheduled.bgId;
        const placeholder =
          `[Background task ${bgId} started: ${label}] ` +
          "Result will arrive later as task_notification. Continue with independent work.";
        session.appendTranscript({
          role: "tool",
          toolName: tool.name,
          result: { backgroundTaskId: bgId, status: "running", label },
        });
        recordToolResult(placeholder);
        await scope.persistCheckpoint();
        scheduled.launch();
        run.emitProgress({
          type: "workflow-progress",
          message: `后台任务 ${bgId} 已启动：${label}`,
          progress: 0,
        });
        return { type: "continue" };
      }

      throwIfCancelled();
      const outcome: ToolExecutionOutcome = await run.input.toolExecutionEngine.execute({
        tool,
        args,
        context: workspace.updatedToolUseContext,
        toolCall,
        modelArtifactRoot: deps.workspaceRoot,
        threadId: deps.threadId,
        signal: scope.signal,
        runPostToolUseHook: run.input.runPostToolUseHook,
      });
      throwIfCancelled();
      const outcomeText = textFromResult(outcome.modelResult);
      if (outcome.executionStatus === "threw") {
        run.emitProgress({
          type: "tool-state",
          toolCallId: toolCall.id,
          message: `工具 ${tool.name} 执行失败: ${outcomeText}`,
          toolName: tool.name,
          status: "failed",
        });
        session.appendTranscript({
          role: "tool",
          toolName: tool.name,
          error: outcomeText,
          sideEffects: outcome.sideEffects,
        });
        recordToolResultBlock(outcome.modelResult);
        return { type: "continue" };
      }
      if (outcome.deliveryStatus === "validation_failed") {
        run.emitProgress({
          type: "tool-state",
          toolCallId: toolCall.id,
          message: `工具 ${tool.name} 返回结果未通过校验`,
          toolName: tool.name,
          status: "invalid-input",
          error: outcomeText,
        });
        session.appendTranscript({
          role: "tool",
          toolName: tool.name,
          error: outcomeText,
          executionStatus: "returned",
          sideEffects: outcome.sideEffects,
        });
        recordToolResultBlock(outcome.modelResult);
        return { type: "continue" };
      }

      run.emitProgress({
        type: "tool-state",
        toolCallId: toolCall.id,
        message: `工具 ${tool.name} 执行完成。`,
        toolName: tool.name,
        status: "completed",
      });
      emitToolProgress(run, tool, toolCall, outcome);
      try {
        const decision = await run.input.completionPolicy.interpret({
          tool,
          toolUseId: toolCall.id,
          outcome,
          context: workspace.updatedToolUseContext,
          emitProgress: (event) => run.emitProgress(event),
        });
        if (decision.type === "terminal") {
          if (decision.modelResult) recordToolResultBlock(decision.modelResult);
          if (decision.result.type === "ask_user") {
            scope.setInflightQuery("waiting_user", workspace);
          } else {
            scope.stageConversationHistory(state, workspace);
          }
          return { type: "terminal", result: decision.result };
        }
        session.appendTranscript(decision.transcriptEntry);
        recordToolResultBlock(decision.modelResult);
        return { type: "continue" };
      } catch (error) {
        rethrowIfCancelled(error);
        const message = error instanceof Error ? error.message : String(error);
        const guidance =
          `Tool ${tool.name} executed successfully, but result post-processing failed: ${message}. ` +
          "Do not retry blindly; inspect durable artifacts first.";
        session.appendTranscript({
          role: "tool",
          toolName: tool.name,
          result: outcome.validatedResult,
          postProcessingError: message,
          executionStatus: "returned",
        });
        recordToolResult(guidance);
        return { type: "continue" };
      }
    } catch (error) {
      const cancelled = isRuntimeCancellation(error, scope.signal, deps.externalSignal);
      const errorText = error instanceof Error ? error.message : String(error);
      run.emitProgress({
        type: "tool-state",
        toolCallId: toolCall.id,
        message: cancelled
          ? `工具 ${tool.name} 已取消`
          : `工具 ${tool.name} 执行失败: ${errorText}`,
        toolName: tool.name,
        status: cancelled ? "denied" : "failed",
        ...(!cancelled ? { error: errorText } : {}),
      });
      throw error;
    }
  }
}

function textFromResult(result: AgentModelToolResultBlock): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function throwIfRunCancelled(...signals: Array<AbortSignal | undefined>): void {
  if (signals.some((signal) => signal?.aborted)) {
    throw new Error("Run aborted by user.");
  }
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function unexpectedExecutionFailure(
  toolCall: AgentModelToolUseBlock,
  error: unknown,
): ToolExecutionOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return {
    executionStatus: "threw",
    sideEffects: "uncertain",
    deliveryStatus: "delivered",
    modelResult: {
      type: "tool_result",
      toolUseId: toolCall.id,
      isError: true,
      content: [
        {
          type: "text",
          text:
            `Tool ${toolCall.name} failed outside its normal error boundary: ${message}. ` +
            "Side effects are uncertain; inspect durable artifacts before retrying.",
        },
      ],
    },
    error: message,
    warnings: [],
  };
}

function emitToolProgress(
  run: PreparedAgentRun,
  tool: ToolDefinition,
  call: AgentModelToolUseBlock,
  outcome: ToolExecutionOutcome,
): void {
  try {
    for (const event of tool.mapResultToProgress?.(outcome.validatedResult) ?? []) {
      run.emitProgress({ ...event, toolCallId: call.id, toolName: tool.name });
    }
  } catch (error) {
    run.appendRuntimeEvent(
      "workflow_progress",
      {
        type: "tool-projection-error",
        toolName: tool.name,
        error: error instanceof Error ? error.message : String(error),
      },
      "internal",
    );
  }
}
