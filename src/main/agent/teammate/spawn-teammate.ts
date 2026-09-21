import {
  buildSubStepLimitMessage,
  getEffectiveSubMaxSteps,
  resolveAgentStepLimits,
} from "@shared/agent-step-limits";
import type { AgentTaskNode } from "@shared/agent-task-list";
import {
  formatTeammateToolProgress,
  type TeammateProgressEvent,
  type TeammateProgressListener,
} from "@shared/teammate-progress";
import { z } from "zod";
import type {
  AgentModelContentBlock,
  AgentModelMessage,
  AgentModelToolResultBlock,
  AgentModelToolUseBlock,
  AgentToolSchema,
} from "../gateway";
import {
  ensureToolResultPairing,
  textFromContentBlocks,
  toolUseBlocksFromContent,
} from "../gateway";
import { readJsonFile, writeJsonFileAtomic } from "../persistence/atomic-json-file";
import { ensureDefaultHooks } from "../runtime/hooks/default-hooks";
import type { PostToolUseBlock, StopBlock } from "../runtime/hooks/hook-blocks";
import { triggerHooks } from "../runtime/hooks/hook-registry";
import { formatToolApprovalDetail } from "../runtime/tools/format-tool-approval";
import { authorizeToolUse, type ToolApprovalHandler } from "../runtime/tools/permission-check";
import { classifyToolExecutionError } from "../runtime/tools/tool-execution-error";
import { callModelWithRecovery } from "../runtime/turns/model-call-recovery";
import { createSkillSession } from "../skills/skill-types";
import {
  SUB_AGENT_TOOL_HANDLERS,
  SUB_AGENT_TOOLS,
  type SubAgentToolContext,
  type SubAgentToolDefinition,
} from "../subagent/workspace-tools";
import type { TaskListSnapshotListener } from "../task/task-list-publisher";
import { TaskStore } from "../task/task-store";
import { WorkspaceFileService } from "../tools/files/workspace-file-service";
import { parseToolInput } from "../tools/tool-input";
import { toToolInputSchema } from "../tools/tool-schema";
import { validateToolOutput } from "../tools/tool-validation";
import {
  type AgentMailboxMessage,
  type AgentMailboxMessageType,
  type InboxClaim,
  type MessageBus,
  sanitizeAgentName,
} from "./message-bus";
import {
  isProtocolResponseType,
  type ProtocolState,
  ProtocolStateStore,
  readProtocolRequestId,
  routeProtocolResponses,
} from "./protocol-state";
import type { TeammateConversation } from "./teammate-conversation";
import { TeammateInboxBuffer } from "./teammate-inbox-buffer";
import { TeammateCancellationError, TeammateRuntime } from "./teammate-runtime";
import { buildTeammateSystemPrompt } from "./teammate-system-prompt";
import {
  claimNextDispatchTask,
  createTeammateTaskTools,
  formatTaskAssignment,
  releaseOwnedTasks,
} from "./teammate-task-tools";
import type {
  AssignmentCompletionOutcome,
  PersistedTeammateState,
  SpawnTeammateThreadOptions,
  TeammateAssignedPhase,
  TeammateExit,
  TeammateHandle,
  TeammateIdlePhase,
  TeammateIdlePollOutcome,
  TeammateInboxOutcome,
  TeammateState,
  TeammateToolBatchOutcome,
  TeammateTurnOutcome,
} from "./teammate-types";

export type { SpawnTeammateThreadOptions, TeammateHandle };

const sendMessageSchema = z.object({
  to_agent: z.string().describe("Recipient agent name, e.g. lead or a teammate name"),
  content: z.string().describe("Message content to deliver"),
  msg_type: z
    .enum([
      "message",
      "result",
      "idle_notification",
      "permission_request",
      "permission_response",
      "error",
    ])
    .optional()
    .describe("Message type; defaults to message"),
});

const requestPlanApprovalSchema = z.object({
  plan: z
    .string()
    .trim()
    .min(1)
    .describe("Concrete implementation plan for lead to approve before high-risk or broad changes"),
});

export class TeammateManager {
  private readonly teammates = new Map<string, TeammateState>();
  private readonly protocolStates: ProtocolStateStore;
  private reconcilePromise?: Promise<void>;

  constructor(
    private readonly bus: MessageBus,
    protocolStates?: ProtocolStateStore,
  ) {
    this.protocolStates = protocolStates ?? new ProtocolStateStore(bus.getProtocolStatePath());
  }

  spawn(options: SpawnTeammateThreadOptions): TeammateHandle {
    const name = sanitizeAgentName(options.name);
    const existing = this.teammates.get(name);
    if (existing && existing.status !== "stopped" && existing.status !== "failed") {
      throw new Error(`Teammate already running: ${name}`);
    }

    const controller = new AbortController();
    const state: TeammateState = {
      name,
      role: options.role.trim() || "teammate",
      status: "running",
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      prompt: options.prompt,
      taskListListener: options.onTaskListUpdated,
      progressListener: options.onProgress,
      controller,
      done: Promise.resolve(),
    };
    state.done = this.runTeammate(state, {
      ...options,
      name,
      role: state.role,
    })
      .catch(async (error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (state.status !== "failed") state.status = "failed";
        state.lastError ??= errorMessage;
        state.lastActiveAt = Date.now();
        try {
          await this.bus.send({
            from: state.name,
            to: "lead",
            type: "error",
            content: errorMessage,
          });
        } catch (notifyError) {
          const notifyMessage =
            notifyError instanceof Error ? notifyError.message : String(notifyError);
          state.lastError = `${errorMessage}; failed to notify lead: ${notifyMessage}`;
        }
      })
      .finally(async () => {
        state.lastActiveAt = Date.now();
        await this.persistTeammateStates();
      });
    this.teammates.set(name, state);

    return this.toHandle(state);
  }

  list(): TeammateHandle[] {
    return Array.from(this.teammates.values()).map((state) => this.toHandle(state));
  }

  get(name: string): TeammateHandle | undefined {
    const state = this.teammates.get(sanitizeAgentName(name));
    return state ? this.toHandle(state) : undefined;
  }

  updateTaskListListener(name: string, listener?: TaskListSnapshotListener): boolean {
    const state = this.teammates.get(sanitizeAgentName(name));
    if (!state) return false;
    state.taskListListener = listener;
    return true;
  }

  updateProgressListener(name: string, listener?: TeammateProgressListener): boolean {
    const state = this.teammates.get(sanitizeAgentName(name));
    if (!state) return false;
    state.progressListener = listener;
    return true;
  }

  private emitProgress(state: TeammateState, event: TeammateProgressEvent): void {
    try {
      state.progressListener?.(event);
    } catch {
      // UI observability must never interrupt teammate execution.
    }
  }

  abortTeammate(name: string, reason = "Teammate aborted."): boolean {
    const agent = sanitizeAgentName(name);
    const state = this.teammates.get(agent);
    if (
      !state ||
      state.status === "stopped" ||
      state.status === "failed" ||
      state.controller.signal.aborted
    ) {
      return false;
    }
    state.controller.abort(new TeammateCancellationError(reason));
    return true;
  }

  async requestShutdown(
    name: string,
    reason = "Lead requested teammate shutdown.",
  ): Promise<ProtocolState> {
    await this.protocolStates.hydrate();
    const agent = sanitizeAgentName(name);
    const state = this.teammates.get(agent);
    if (!state) {
      throw new Error(`Unknown teammate: ${agent}`);
    }
    if (state.status === "stopped" || state.status === "failed") {
      throw new Error(`Teammate ${agent} is ${state.status}.`);
    }
    const existing = this.protocolStates.findPending({
      type: "shutdown",
      sender: "lead",
      target: agent,
    });
    if (existing) return existing;

    const request = this.protocolStates.createRequest({
      type: "shutdown",
      sender: "lead",
      target: agent,
      payload: reason,
    });
    await this.protocolStates.flush();
    try {
      await this.bus.send({
        from: "lead",
        to: agent,
        type: "shutdown_request",
        content: reason,
        payload: { requestId: request.requestId },
      });
    } catch (error) {
      this.protocolStates.remove(request.requestId);
      await this.protocolStates.flush();
      throw error;
    }
    return request;
  }

  async respondPlanApproval(
    requestId: string,
    approve: boolean,
    reason = "",
  ): Promise<ProtocolState> {
    await this.protocolStates.hydrate();
    const request = this.protocolStates.get(requestId);
    if (!request) throw new Error(`Unknown protocol request: ${requestId}`);
    if (request.type !== "plan_approval") {
      throw new Error(`Request ${requestId} is ${request.type}, not plan_approval.`);
    }
    if (request.status !== "pending") {
      throw new Error(`Request ${requestId} is already ${request.status}.`);
    }
    if (request.target !== "lead") {
      throw new Error(`Request ${requestId} is not addressed to lead.`);
    }

    await this.bus.send({
      from: "lead",
      to: request.sender,
      type: "plan_approval_response",
      content: reason || (approve ? "Plan approved by lead." : "Plan rejected by lead."),
      payload: { requestId, approve, reason },
    });
    return request;
  }

  async consumeLeadInbox(): Promise<AgentMailboxMessage[]> {
    await this.protocolStates.hydrate();
    const messages = await this.bus.readInbox("lead");
    routeProtocolResponses(messages, this.protocolStates);
    await this.protocolStates.flush();
    return messages;
  }

  async claimLeadInbox(): Promise<InboxClaim | undefined> {
    await this.protocolStates.hydrate();
    const claim = await this.bus.claimInbox("lead");
    if (!claim) return undefined;
    routeProtocolResponses(claim.messages, this.protocolStates);
    await this.protocolStates.flush();
    return claim;
  }

  async ackLeadInboxClaim(claimId: string): Promise<void> {
    await this.bus.ackInboxClaim(claimId);
  }

  getProtocolState(requestId: string): ProtocolState | undefined {
    return this.protocolStates.get(requestId);
  }

  listProtocolStates(): ProtocolState[] {
    return this.protocolStates.list();
  }

  /**
   * A teammate model loop cannot be safely replayed after a process crash.
   * Convert persisted running entries into durable interruption messages so
   * the lead can inspect artifacts/tasks and explicitly re-delegate.
   *
   * 翻译：
   * 一个 teammate 模型循环不能在进程崩溃后安全地重新播放。
   * 将持久化的运行条目转换为持久中断消息，以便
   * 使 lead 可以检查 artifacts/tasks 并显式重新委托。
   *
   */
  async reconcileInterrupted(): Promise<void> {
    if (!this.reconcilePromise) {
      this.reconcilePromise = (async () => {
        const filePath = this.bus.getTeammateStatePath();
        const stored = await readJsonFile<{ version: 1; teammates: PersistedTeammateState[] }>(
          filePath,
        );
        if (!stored) return;
        let changed = false;
        for (const teammate of stored.teammates) {
          if (teammate.status !== "running" && teammate.status !== "idle") continue;
          changed = true;
          teammate.status = "interrupted";
          teammate.lastError =
            "Application restarted before the teammate committed its final result.";
          teammate.lastActiveAt = Date.now();
          await this.bus.send({
            from: teammate.name,
            to: "lead",
            type: "error",
            content:
              `Teammate ${teammate.name} was interrupted by application restart. ` +
              "Its task claims will be reclaimed; inspect durable artifacts before re-delegating.",
            payload: { role: teammate.role, prompt: teammate.prompt, recoverable: true },
          });
        }
        if (changed) await writeJsonFileAtomic(filePath, stored);
      })();
    }
    await this.reconcilePromise;
  }

  private async persistTeammateStates(): Promise<void> {
    await writeJsonFileAtomic(this.bus.getTeammateStatePath(), {
      version: 1,
      teammates: Array.from(this.teammates.values()).map(
        (state): PersistedTeammateState => ({
          name: state.name,
          role: state.role,
          status: state.status,
          startedAt: state.startedAt,
          lastActiveAt: state.lastActiveAt,
          prompt: state.prompt,
          ...(state.lastError ? { lastError: state.lastError } : {}),
        }),
      ),
    });
  }

  async waitFor(name: string): Promise<void> {
    const state = this.teammates.get(sanitizeAgentName(name));
    await state?.done;
  }

  private toHandle(state: TeammateState): TeammateHandle {
    return {
      name: state.name,
      role: state.role,
      status: state.status,
      startedAt: state.startedAt,
      lastActiveAt: state.lastActiveAt,
      ...(state.lastError ? { lastError: state.lastError } : {}),
    };
  }

  /**
   * 驱动单个 teammate 的完整生命周期：接收任务、调用模型、执行工具，
   * 并在完成、空闲、关闭或失败时同步任务板和 lead。
   */
  private async runTeammate(
    state: TeammateState,
    options: SpawnTeammateThreadOptions,
  ): Promise<void> {
    ensureDefaultHooks();
    await this.protocolStates.hydrate();
    await this.persistTeammateStates();
    const inbox = new TeammateInboxBuffer(this.bus, state.name);
    const taskStore = options.taskStore ?? new TaskStore(options.workspaceRoot);
    const publishTaskList: TaskListSnapshotListener = (snapshot) => {
      state.taskListListener?.(snapshot);
    };
    const stepLimits = resolveAgentStepLimits(options.agentStepLimits);
    const maxSteps = options.maxSteps ?? getEffectiveSubMaxSteps(stepLimits);
    const idlePollMs = options.idlePollMs ?? 5_000;
    const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    const permissionPollMs = options.permissionPollMs ?? 500;
    const sendMessageTool = createSendMessageTool(this.bus, state.name);
    const requestPlanApprovalTool = createRequestPlanApprovalTool(
      this.bus,
      this.protocolStates,
      state.name,
    );
    const taskTools = createTeammateTaskTools(taskStore, state.name, publishTaskList);
    const tools = [...SUB_AGENT_TOOLS, ...taskTools, sendMessageTool, requestPlanApprovalTool];
    const handlers = new Map<string, SubAgentToolDefinition>(
      [
        ...SUB_AGENT_TOOL_HANDLERS.values(),
        ...taskTools,
        sendMessageTool,
        requestPlanApprovalTool,
      ].map((tool) => [tool.name, tool]),
    );
    const skillSession = createSkillSession();
    const skillCatalog = options.skillRegistry?.listCards() ?? [];
    const systemPrompt = buildTeammateSystemPrompt({
      name: state.name,
      role: state.role,
      tools,
      domain: options.domain,
      skillCatalog,
      skillRegistry: options.skillRegistry,
    });
    const toolSchemas: AgentToolSchema[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toToolInputSchema(tool.inputSchema),
    }));
    const toolContext: SubAgentToolContext = {
      workspaceRoot: options.workspaceRoot,
      fileService: new WorkspaceFileService(options.workspaceRoot),
      filePolicy: options.filePolicy,
      skillGuidance: options.domain?.skillGuidance,
      searchConfig: options.gateway.getSearchConfig?.(),
      signal: state.controller.signal,
      skillRegistry: options.skillRegistry,
      skillSession,
      promptStage: "discover",
    };
    const requestToolApproval = createTeammateApprovalHandler({
      bus: this.bus,
      inbox,
      name: state.name,
      signal: state.controller.signal,
      pollMs: permissionPollMs,
    });
    const runtime = new TeammateRuntime(state, {
      startIdle: options.startIdle === true,
      prompt: options.prompt,
      emitProgress: (event) => this.emitProgress(state, event),
    });
    let primaryError: Error | undefined;
    try {
      while (!runtime.isTerminal()) {
        if (runtime.signal.aborted) {
          runtime.transitionToStopping({ kind: "aborted" });
          break;
        }

        const inboxOutcome = await routeTeammateInbox({
          inbox,
          protocolStates: this.protocolStates,
          teammateName: state.name,
        });

        if (inboxOutcome.kind === "shutdown") {
          runtime.transitionToStopping({
            kind: "shutdown",
            requestId: inboxOutcome.requestId,
            sender: inboxOutcome.sender,
          });
          break;
        }

        if (inboxOutcome.kind === "routed-messages") {
          const inboxAssignment = formatInboxForTeammate(inboxOutcome.messages);
          if (runtime.phase.kind === "assigned") {
            runtime.continueAssignment(inboxAssignment, true);
          } else if (runtime.phase.kind === "idle") {
            const nextAssignment = withIdentityIfCompacted(
              runtime.conversation.modelInput(),
              runtime.name,
              runtime.role,
              inboxAssignment,
            );
            runtime.beginAssignment({
              assignment: nextAssignment,
              source: "message",
              description: `来自 lead 的协作任务：${inboxOutcome.messages[0]?.content ?? "继续处理"}`,
            });
          }
        }

        if (runtime.phase.kind === "idle") {
          const idleOutcome = await pollForTeammateTask({
            idle: runtime.phase,
            taskStore,
            teammateName: state.name,
            publishTaskList,
            idlePollMs,
            idleTimeoutMs,
            signal: state.controller.signal,
          });
          if (idleOutcome.kind === "wait") {
            runtime.updateIdlePhase(idleOutcome.idle);
            continue;
          }
          if (idleOutcome.kind === "timeout") {
            runtime.transitionToStopping({ kind: "idle-timeout" });
            break;
          }

          const claimedTask = idleOutcome.task;
          const nextAssignment = withIdentityIfCompacted(
            runtime.conversation.modelInput(),
            runtime.name,
            runtime.role,
            formatTaskAssignment({ task: claimedTask, mode: idleOutcome.mode }),
          );
          runtime.beginAssignment({
            assignment: nextAssignment,
            source: "task-board",
            description: claimedTask.subject,
            activityTaskId: claimedTask.id,
            transcriptFields: { task: claimedTask },
          });
        }

        if (runtime.phase.kind !== "assigned") {
          continue;
        }

        if (runtime.assignmentStepLimitReached(maxSteps)) {
          const message = buildSubStepLimitMessage(stepLimits);
          await this.finalizeStepLimitedAssignment({
            runtime,
            taskStore,
            publishTaskList,
            idlePollMs,
            message,
          });
          continue;
        }

        const assigned = runtime.currentTurn();
        const turnOutcome = await advanceTeammateTurn({
          options,
          systemPrompt,
          conversation: runtime.conversation,
          toolSchemas,
          handlers,
          protocolStates: this.protocolStates,
          requestToolApproval,
          toolContext,
          teammateName: state.name,
          workspaceRoot: options.workspaceRoot,
          assignment: assigned,
          signal: runtime.signal,
          emitThinking: (chunk) => runtime.emitThinking(chunk),
          emitProgress: (event) => this.emitProgress(state, event),
        });
        runtime.incrementModelSteps();

        if (turnOutcome.kind === "continue") {
          runtime.conversation.appendAssistant(turnOutcome.assistantContent);
          runtime.conversation.appendToolResults(
            turnOutcome.transcriptEntries,
            turnOutcome.results,
          );
          continue;
        }

        if (turnOutcome.kind === "stop-teammate") {
          runtime.conversation.appendAssistant(turnOutcome.assistantContent);
          runtime.conversation.appendToolTranscript(turnOutcome.transcriptEntries);
          runtime.transitionToStopping({
            kind: "hook-stop",
            reason: turnOutcome.reason,
          });
          break;
        }

        runtime.conversation.appendAssistant(turnOutcome.assistantContent, turnOutcome.summary);
        const completion = await evaluateAssignmentCompletion({
          taskStore,
          teammateName: state.name,
          summary: turnOutcome.summary,
        });
        if (completion.kind === "continue") {
          runtime.continueAssignment(completion.guidance, false);
          continue;
        }

        await this.finalizeCompletedAssignment(runtime, completion.summary, idlePollMs);
      }
    } catch (error) {
      if (isTeammateCancellation(error, runtime.signal)) {
        runtime.transitionToStopping({ kind: "aborted" });
      } else {
        primaryError = normalizeError(error);
        runtime.transitionToFailed(primaryError);
      }
    }

    if (!runtime.isTerminal()) {
      runtime.transitionToStopping(
        runtime.signal.aborted ? { kind: "aborted" } : { kind: "idle-timeout" },
      );
    }

    const cleanupErrors = await this.finalizeTeammateRuntime({
      runtime,
      taskStore,
      publishTaskList,
    });

    if (primaryError) {
      if (cleanupErrors.length > 0) {
        state.lastError = `${primaryError.message}; cleanup: ${cleanupErrors
          .map((error) => error.message)
          .join("; ")}`;
      }
      throw primaryError;
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Teammate finalization failed.");
    }
  }

  private async finalizeStepLimitedAssignment(input: {
    runtime: TeammateRuntime;
    taskStore: TaskStore;
    publishTaskList: TaskListSnapshotListener;
    idlePollMs: number;
    message: string;
  }): Promise<void> {
    await releaseOwnedTasks(input.taskStore, input.runtime.name, input.publishTaskList);
    input.runtime.finishCurrentActivity("failed", input.message);
    await this.finishWithSummary(input.runtime.name, input.message, "step_limit");
    await this.sendIdleNotification(
      input.runtime.name,
      `${input.runtime.name} hit the assignment step limit and is idle awaiting new instructions.`,
    );
    input.runtime.transitionToIdle(input.idlePollMs);
  }

  private async finalizeCompletedAssignment(
    runtime: TeammateRuntime,
    summary: string,
    idlePollMs: number,
  ): Promise<void> {
    runtime.recordSummary(summary);
    await this.bus.send({
      from: runtime.name,
      to: "lead",
      type: "result",
      content: summary,
    });
    runtime.finishCurrentActivity("completed", summary);
    await this.sendIdleNotification(runtime.name);
    runtime.transitionToIdle(idlePollMs);
  }

  private async finalizeTeammateRuntime(input: {
    runtime: TeammateRuntime;
    taskStore: TaskStore;
    publishTaskList: TaskListSnapshotListener;
  }): Promise<Error[]> {
    const cleanupErrors: Error[] = [];
    const attempt = async (
      label: string,
      action: () => unknown | Promise<unknown>,
    ): Promise<void> => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(
          new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          }),
        );
      }
    };
    const releaseTasks = () =>
      releaseOwnedTasks(input.taskStore, input.runtime.name, input.publishTaskList);
    const exit = input.runtime.terminalExit();

    switch (exit.kind) {
      case "shutdown":
        await attempt("release owned tasks", releaseTasks);
        await attempt("finish shutdown activity", () =>
          input.runtime.finishCurrentActivity("interrupted", "协作任务已按 lead 请求停止"),
        );
        await attempt("send shutdown lifecycle summary", () =>
          this.sendLifecycleSummary(
            input.runtime.name,
            "shutdown requested",
            input.runtime.workSummaries,
          ),
        );
        await attempt("send shutdown response", () =>
          this.bus.send({
            from: input.runtime.name,
            to: exit.sender,
            type: "shutdown_response",
            content: `${input.runtime.name} finished its current operation and is shutting down.`,
            payload: { requestId: exit.requestId, approve: true },
          }),
        );
        break;
      case "idle-timeout":
        await attempt("send idle lifecycle summary", () =>
          this.sendLifecycleSummary(
            input.runtime.name,
            "idle timeout",
            input.runtime.workSummaries,
          ),
        );
        await attempt("release owned tasks", releaseTasks);
        break;
      case "hook-stop":
        await attempt("finish hook-stop activity", () =>
          input.runtime.finishCurrentActivity("completed", exit.reason),
        );
        await attempt("send hook-stop result", () =>
          this.finishWithSummary(input.runtime.name, exit.reason, "completed"),
        );
        await attempt("release owned tasks", releaseTasks);
        break;
      case "aborted":
        await attempt("finish aborted activity", () =>
          input.runtime.finishCurrentActivity("interrupted", "协作任务已中断"),
        );
        await attempt("release owned tasks", releaseTasks);
        break;
      case "failed":
        await attempt("finish failed activity", () =>
          input.runtime.finishCurrentActivity("failed", exit.error.message),
        );
        await attempt("release owned tasks", releaseTasks);
        break;
    }

    if (cleanupErrors.length > 0 && input.runtime.terminalExit().kind !== "failed") {
      input.runtime.transitionToFailed(
        new AggregateError(cleanupErrors, "Teammate finalization failed before Stop hook."),
      );
    }

    const stopExit = input.runtime.terminalExit();
    await attempt("trigger Stop hook", () =>
      triggerHooks("Stop", {
        event: "Stop",
        scope: "subagent",
        result: stopExit.kind === "failed" ? "failed" : "stopped",
        reason: toStopBlockReason(stopExit),
        threadId: input.runtime.name,
      } satisfies StopBlock),
    );

    if (cleanupErrors.length === 0 && input.runtime.phase.kind === "stopping") {
      input.runtime.finalizeStopped();
    } else if (cleanupErrors.length > 0 && input.runtime.phase.kind !== "failed") {
      input.runtime.transitionToFailed(
        new AggregateError(cleanupErrors, "Teammate finalization failed."),
      );
    }
    return cleanupErrors;
  }

  private async finishWithSummary(
    name: string,
    content: string,
    reason: StopBlock["reason"],
  ): Promise<void> {
    await this.bus.send({
      from: name,
      to: "lead",
      type: reason === "step_limit" ? "error" : "result",
      content,
    });
  }

  private async sendIdleNotification(
    name: string,
    content = `${name} is idle and waiting for inbox messages.`,
  ): Promise<void> {
    await this.bus.send({
      from: name,
      to: "lead",
      type: "idle_notification",
      content,
    });
  }

  private async sendLifecycleSummary(
    name: string,
    reason: string,
    workSummaries: string[],
  ): Promise<void> {
    const completed = workSummaries.length;
    await this.bus.send({
      from: name,
      to: "lead",
      type: "result",
      content: `${name} is shutting down after ${reason}. Completed ${completed} work cycle${completed === 1 ? "" : "s"}.`,
      payload: { reason, completedWorkCycles: completed },
    });
  }
}

async function routeTeammateInbox(input: {
  inbox: TeammateInboxBuffer;
  protocolStates: ProtocolStateStore;
  teammateName: string;
}): Promise<TeammateInboxOutcome> {
  const messages = await input.inbox.takeAll();
  if (messages.length === 0) return { kind: "none" };

  const matchedResponses = routeProtocolResponses(messages, input.protocolStates);
  if (matchedResponses.length > 0) await input.protocolStates.flush();
  const matchedRequestIds = new Set(matchedResponses.map((response) => response.requestId));
  const shutdownRequest = messages.find((message) => {
    if (message.type !== "shutdown_request" || message.from !== "lead") return false;
    const request = input.protocolStates.get(readProtocolRequestId(message.payload));
    return (
      request?.type === "shutdown" &&
      request.status === "pending" &&
      request.sender === "lead" &&
      request.target === input.teammateName
    );
  });
  if (shutdownRequest) {
    return {
      kind: "shutdown",
      requestId: readProtocolRequestId(shutdownRequest.payload),
      sender: shutdownRequest.from,
    };
  }

  const routedMessages = messages.filter(
    (message) =>
      message.type !== "shutdown_request" &&
      (!isProtocolResponseType(message.type) ||
        matchedRequestIds.has(readProtocolRequestId(message.payload))),
  );
  return routedMessages.length > 0
    ? { kind: "routed-messages", messages: routedMessages }
    : { kind: "none" };
}

async function advanceTeammateTurn(input: {
  options: SpawnTeammateThreadOptions;
  systemPrompt: string;
  conversation: TeammateConversation;
  toolSchemas: AgentToolSchema[];
  handlers: Map<string, SubAgentToolDefinition>;
  protocolStates: ProtocolStateStore;
  requestToolApproval: ToolApprovalHandler;
  toolContext: SubAgentToolContext;
  teammateName: string;
  workspaceRoot: string;
  assignment: TeammateAssignedPhase;
  signal: AbortSignal;
  emitThinking: (chunk: string) => void;
  emitProgress: (event: TeammateProgressEvent) => void;
}): Promise<TeammateTurnOutcome> {
  const responseContent = await generateTeammateResponse({
    options: input.options,
    systemPrompt: input.systemPrompt,
    transcript: input.conversation.transcriptSnapshot(),
    modelMessages: input.conversation.modelInput(),
    tools: input.toolSchemas,
    task: input.assignment.assignment.input,
    signal: input.signal,
    onThinkingChunk: input.emitThinking,
  });
  const calls = toolUseBlocksFromContent(responseContent);
  if (calls.length === 0) {
    return {
      kind: "final",
      assistantContent: responseContent,
      summary: textFromContentBlocks(responseContent),
    };
  }

  const toolOutcome = await executeTeammateToolBatch({
    calls,
    handlers: input.handlers,
    protocolStates: input.protocolStates,
    teammateName: input.teammateName,
    workspaceRoot: input.workspaceRoot,
    requestToolApproval: input.requestToolApproval,
    toolContext: input.toolContext,
    activityId: input.assignment.activityId,
    activityTaskId: input.assignment.assignment.activityTaskId,
    emitProgress: input.emitProgress,
  });
  if (toolOutcome.kind === "stop") {
    return {
      kind: "stop-teammate",
      assistantContent: responseContent,
      reason: toolOutcome.reason,
      transcriptEntries: toolOutcome.transcriptEntries,
    };
  }
  return {
    kind: "continue",
    assistantContent: responseContent,
    results: toolOutcome.results,
    transcriptEntries: toolOutcome.transcriptEntries,
  };
}

function buildOwnedTasksReviewGuidance(tasks: AgentTaskNode[]): string {
  const taskList = tasks.map((task) => `- ${task.id}: ${task.subject}`).join("\n");
  return [
    "You still own the following in-progress tasks:",
    taskList,
    "Complete each task and call TaskReviewRequest with a stable requestId and latest revision before returning a final summary.",
  ].join("\n\n");
}

async function evaluateAssignmentCompletion(input: {
  taskStore: TaskStore;
  teammateName: string;
  summary: string;
}): Promise<AssignmentCompletionOutcome> {
  const ownedInProgressTasks = (await input.taskStore.listTasks()).filter(
    (task) =>
      task.owner === input.teammateName &&
      task.status === "in_progress" &&
      task.review.state !== "requested",
  );
  return ownedInProgressTasks.length > 0
    ? {
        kind: "continue",
        guidance: buildOwnedTasksReviewGuidance(ownedInProgressTasks),
      }
    : { kind: "completed", summary: input.summary };
}

function isTeammateCancellation(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (error === signal.reason || error instanceof TeammateCancellationError) return true;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    name === "AbortError" || name === "APIUserAbortError" || message === "Run aborted by user."
  );
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toStopBlockReason(exit: TeammateExit): StopBlock["reason"] {
  return exit.kind === "aborted" || exit.kind === "failed" ? "aborted" : "completed";
}

async function pollForTeammateTask(input: {
  idle: TeammateIdlePhase;
  taskStore: TaskStore;
  teammateName: string;
  publishTaskList: TaskListSnapshotListener;
  idlePollMs: number;
  idleTimeoutMs: number;
  signal: AbortSignal;
}): Promise<TeammateIdlePollOutcome> {
  const now = Date.now();
  const idleTimeoutReached = now - input.idle.since >= input.idleTimeoutMs;

  if (now < input.idle.nextPollAt && !idleTimeoutReached) {
    await sleep(
      Math.min(input.idle.nextPollAt - now, input.idleTimeoutMs - (now - input.idle.since)),
      input.signal,
    );
    return { kind: "wait", idle: input.idle };
  }

  const nextIdle = { ...input.idle, nextPollAt: now + input.idlePollMs };
  const candidate = await claimNextDispatchTask(
    input.taskStore,
    input.teammateName,
    input.publishTaskList,
  );
  if (candidate) return { kind: "claimed", task: candidate.task, mode: candidate.mode };
  if (Date.now() - input.idle.since >= input.idleTimeoutMs) {
    return { kind: "timeout" };
  }
  return { kind: "wait", idle: nextIdle };
}

async function executeTeammateToolBatch(input: {
  calls: AgentModelToolUseBlock[];
  handlers: Map<string, SubAgentToolDefinition>;
  protocolStates: ProtocolStateStore;
  teammateName: string;
  workspaceRoot: string;
  requestToolApproval: ToolApprovalHandler;
  toolContext: SubAgentToolContext;
  activityId?: string;
  activityTaskId?: string;
  emitProgress: (event: TeammateProgressEvent) => void;
}): Promise<TeammateToolBatchOutcome> {
  const results: AgentModelToolResultBlock[] = [];
  const transcriptEntries: Array<Record<string, unknown>> = [];

  for (const call of input.calls) {
    const finishToolProgress = (
      status: "completed" | "failed",
      message = formatTeammateToolProgress(call.name, status),
    ): void => {
      if (!input.activityId) return;
      const displayMessage =
        status === "failed" &&
        !message.includes("失败") &&
        !/\b(?:fail|error|denied|invalid)\b/i.test(message)
          ? `${formatTeammateToolProgress(call.name, "failed")}：${message}`
          : message;
      input.emitProgress({
        type: "teammate-tool-finished",
        teammateName: input.teammateName,
        activityId: input.activityId,
        ...(input.activityTaskId ? { taskId: input.activityTaskId } : {}),
        toolName: call.name,
        message: displayMessage,
        status,
      });
    };

    if (input.activityId) {
      input.emitProgress({
        type: "teammate-tool-started",
        teammateName: input.teammateName,
        activityId: input.activityId,
        ...(input.activityTaskId ? { taskId: input.activityTaskId } : {}),
        toolName: call.name,
        message: formatTeammateToolProgress(call.name, "running"),
      });
    }

    const record = (text: string, isError = false): void => {
      results.push({
        type: "tool_result",
        toolUseId: call.id,
        content: [{ type: "text", text }],
        ...(isError ? { isError: true } : {}),
      });
    };

    if (call.parseError) {
      transcriptEntries.push({ role: "tool", toolName: call.name, error: call.parseError });
      record(call.parseError, true);
      finishToolProgress("failed", call.parseError);
      continue;
    }

    const tool = input.handlers.get(call.name);
    if (!tool) {
      const error = `Unknown tool: ${call.name}. Teammates cannot use task or spawn teammates.`;
      transcriptEntries.push({ role: "tool", toolName: call.name, error });
      record(error, true);
      finishToolProgress("failed", error);
      continue;
    }

    const args = parseToolInput(tool.inputSchema, call.input);
    if (!args.success) {
      transcriptEntries.push({ role: "tool", toolName: tool.name, error: args.error.message });
      record(args.error.message, true);
      finishToolProgress("failed", args.error.message);
      continue;
    }

    const latestPlanRequest = input.protocolStates
      .list()
      .filter(
        (request) => request.type === "plan_approval" && request.sender === input.teammateName,
      )
      .at(-1);
    if (
      requiresApprovedPlan(tool.name) &&
      latestPlanRequest &&
      latestPlanRequest.status !== "approved"
    ) {
      const error =
        latestPlanRequest.status === "pending"
          ? `Plan approval ${latestPlanRequest.requestId} is still pending.`
          : `Plan approval ${latestPlanRequest.requestId} was rejected. Submit a revised plan before making changes.`;
      transcriptEntries.push({ role: "tool", toolName: tool.name, error });
      record(error, true);
      finishToolProgress("failed", error);
      continue;
    }

    const permissionBlock = {
      event: "PreToolUse" as const,
      toolName: tool.name,
      args: args.data,
      scope: "subagent" as const,
      workspaceRoot: input.workspaceRoot,
      threadId: input.teammateName,
      permission: tool.permission,
      requestToolApproval: input.requestToolApproval,
    };
    let permissionStop;
    try {
      permissionStop = await authorizeToolUse(permissionBlock);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const guidance = `Permission check failed before ${tool.name} executed: ${errorMessage}`;
      transcriptEntries.push({ role: "tool", toolName: tool.name, error: guidance });
      record(guidance, true);
      finishToolProgress("failed", guidance);
      continue;
    }
    if (permissionStop?.toolDenied) {
      transcriptEntries.push({ role: "tool", toolName: tool.name, error: permissionStop.reason });
      record(permissionStop.reason ?? "Tool call denied.", true);
      finishToolProgress("failed", permissionStop.reason ?? "Tool call denied.");
      continue;
    }

    let preToolStop;
    try {
      // Mutable PreToolUse extensions run only after non-removable permission.
      preToolStop = await triggerHooks("PreToolUse", permissionBlock);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const guidance = `PreToolUse failed before ${tool.name} executed: ${errorMessage}`;
      transcriptEntries.push({ role: "tool", toolName: tool.name, error: guidance });
      record(guidance, true);
      finishToolProgress("failed", guidance);
      continue;
    }
    if (preToolStop?.toolDenied) {
      transcriptEntries.push({ role: "tool", toolName: tool.name, error: preToolStop.reason });
      record(preToolStop.reason ?? "Tool call denied.", true);
      finishToolProgress("failed", preToolStop.reason ?? "Tool call denied.");
      continue;
    }
    if (preToolStop) {
      finishToolProgress("completed", preToolStop.reason);
      return { kind: "stop", reason: preToolStop.reason, transcriptEntries };
    }

    let rawOutput: unknown;
    try {
      rawOutput = await tool.execute(args.data, input.toolContext);
    } catch (error) {
      const classification = classifyToolExecutionError(error);
      try {
        await triggerHooks("PostToolUse", {
          event: "PostToolUse",
          toolName: tool.name,
          args: args.data,
          scope: "subagent",
          executionStatus: "threw",
          sideEffects: classification.sideEffects,
          error: classification.message,
          ...(classification.errorCode ? { errorCode: classification.errorCode } : {}),
          threadId: input.teammateName,
        } satisfies PostToolUseBlock);
      } catch (hookError) {
        transcriptEntries.push({
          role: "system",
          kind: "hook_error",
          hook: "PostToolUse",
          toolName: tool.name,
          error: hookError instanceof Error ? hookError.message : String(hookError),
        });
      }
      transcriptEntries.push({
        role: "tool",
        toolName: tool.name,
        error: classification.guidance,
        ...(classification.errorCode ? { errorCode: classification.errorCode } : {}),
        sideEffects: classification.sideEffects,
      });
      record(classification.guidance, true);
      finishToolProgress("failed", classification.message);
      continue;
    }

    let output: unknown;
    try {
      output = validateToolOutput(tool, rawOutput);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      try {
        await triggerHooks("PostToolUse", {
          event: "PostToolUse",
          toolName: tool.name,
          args: args.data,
          scope: "subagent",
          executionStatus: "returned",
          sideEffects: "committed_or_unknown",
          error: errorMessage,
          threadId: input.teammateName,
        } satisfies PostToolUseBlock);
      } catch (hookError) {
        transcriptEntries.push({
          role: "system",
          kind: "hook_error",
          hook: "PostToolUse",
          toolName: tool.name,
          error: hookError instanceof Error ? hookError.message : String(hookError),
        });
      }
      const guidance =
        `${errorMessage}\nThe tool returned after execution; side effects may already exist. ` +
        "Do not retry blindly.";
      transcriptEntries.push({
        role: "tool",
        toolName: tool.name,
        error: guidance,
        sideEffects: "committed_or_unknown",
      });
      record(guidance, true);
      finishToolProgress("failed", errorMessage);
      continue;
    }

    try {
      // PostToolUse 仅用于观测；失败会被记录，但不会改写已经确定的成功事实。
      await triggerHooks("PostToolUse", {
        event: "PostToolUse",
        toolName: tool.name,
        args: args.data,
        scope: "subagent",
        executionStatus: "returned",
        sideEffects: "committed_or_unknown",
        result: output,
        threadId: input.teammateName,
      } satisfies PostToolUseBlock);
    } catch (error) {
      transcriptEntries.push({
        role: "system",
        kind: "hook_error",
        hook: "PostToolUse",
        toolName: tool.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    transcriptEntries.push({ role: "tool", toolName: tool.name, result: output });
    record(
      tool.mapResultToModelContent
        ? await tool.mapResultToModelContent(output)
        : formatTeammateToolResult(output),
    );
    finishToolProgress("completed");
  }

  return { kind: "continue", results, transcriptEntries };
}

function createSendMessageTool(
  bus: MessageBus,
  fromAgent: string,
): SubAgentToolDefinition<typeof sendMessageSchema> {
  return {
    name: "send_message",
    description: "Send a message to lead or another teammate through the file-backed MessageBus.",
    inputSchema: sendMessageSchema,
    permission: {
      profile: "message-bus",
      description: "Send a structured mailbox message to another agent.",
      scopes: ["subagent"],
      effects: ["workflow.delegate"],
      sandbox: "workspace",
      approval: "never",
    },
    async execute(args) {
      const type = (args.msg_type ?? "message") as AgentMailboxMessageType;
      const message = await bus.send({
        from: fromAgent,
        to: args.to_agent,
        content: args.content,
        type,
      });
      return `Sent ${message.type} to ${message.to}.`;
    },
  };
}

function createRequestPlanApprovalTool(
  bus: MessageBus,
  states: ProtocolStateStore,
  fromAgent: string,
): SubAgentToolDefinition<typeof requestPlanApprovalSchema> {
  return {
    name: "request_plan_approval",
    description:
      "Submit a concrete high-risk or broad-change plan to lead and wait for an approval response before changing files.",
    inputSchema: requestPlanApprovalSchema,
    permission: {
      profile: "message-bus",
      description: "Request lead approval for a teammate implementation plan.",
      scopes: ["subagent"],
      effects: ["workflow.delegate"],
      sandbox: "workspace",
      approval: "never",
    },
    async execute(args) {
      await states.hydrate();
      const existing = states.findPending({
        type: "plan_approval",
        sender: fromAgent,
        target: "lead",
      });
      if (existing) {
        return `Plan approval ${existing.requestId} is already pending. Wait for lead's response.`;
      }

      const request = states.createRequest({
        type: "plan_approval",
        sender: fromAgent,
        target: "lead",
        payload: args.plan,
      });
      await states.flush();
      try {
        await bus.send({
          from: fromAgent,
          to: "lead",
          type: "plan_approval_request",
          content: args.plan,
          payload: { requestId: request.requestId },
        });
      } catch (error) {
        states.remove(request.requestId);
        await states.flush();
        throw error;
      }
      return `Plan approval ${request.requestId} is pending. Do not make changes until lead responds.`;
    },
  };
}

function createTeammateApprovalHandler(input: {
  bus: MessageBus;
  inbox: TeammateInboxBuffer;
  name: string;
  signal: AbortSignal;
  pollMs: number;
}): ToolApprovalHandler {
  return async (request) => {
    const requestId = crypto.randomUUID();
    await input.bus.send({
      from: input.name,
      to: "lead",
      type: "permission_request",
      content: `Tool ${request.toolName} needs approval: ${request.reason}`,
      payload: {
        requestId,
        toolName: request.toolName,
        args: request.args,
        reason: request.reason,
        detail: formatToolApprovalDetail(request.toolName, request.args),
      },
    });

    while (!input.signal.aborted) {
      const messages = await input.inbox.takeAll();
      const shutdown = messages.some((message) => message.type === "shutdown_request");
      if (shutdown) {
        input.inbox.pushBack(messages);
        return false;
      }

      const response = messages.find(
        (message) =>
          message.type === "permission_response" && message.payload?.requestId === requestId,
      );
      input.inbox.pushBack(messages.filter((message) => message !== response));
      if (response) {
        return response.payload?.approved === true;
      }
      await sleep(input.pollMs, input.signal);
    }

    return false;
  };
}

async function generateTeammateResponse(input: {
  options: SpawnTeammateThreadOptions;
  systemPrompt: string;
  transcript: Array<Record<string, unknown>>;
  modelMessages: AgentModelMessage[];
  tools: AgentToolSchema[];
  task: string;
  signal: AbortSignal;
  onThinkingChunk?: (chunk: string) => void;
}): Promise<AgentModelContentBlock[]> {
  const result = await callModelWithRecovery({
    gateway: input.options.gateway,
    systemPrompt: input.systemPrompt,
    promptPayload: {
      task: input.task,
      transcript: input.transcript,
    },
    model: input.options.model,
    workspaceRoot: input.options.workspaceRoot,
    threadId: input.options.name,
    signal: input.signal,
    tools: input.tools,
    messages: ensureToolResultPairing(input.modelMessages),
    stream: input.onThinkingChunk ? { onThinkingChunk: input.onThinkingChunk } : undefined,
  });
  return result.content;
}

function formatInboxForTeammate(messages: AgentMailboxMessage[]): string {
  const formatted = messages.map((message) => {
    if (message.type !== "plan_approval_response") return message;
    const requestId = readProtocolRequestId(message.payload);
    const status = message.payload?.approve === true ? "approved" : "rejected";
    return {
      ...message,
      content: `[Plan ${status}] ${requestId}: ${message.content}`,
    };
  });
  return `<inbox>${JSON.stringify(formatted)}</inbox>`;
}

function withIdentityIfCompacted(
  messages: AgentModelMessage[],
  name: string,
  role: string,
  assignment: string,
): string {
  if (messages.length > 3) return assignment;
  return `<identity>You are '${name}', role: ${role}. Continue your work.</identity>\n${assignment}`;
}

function requiresApprovedPlan(toolName: string): boolean {
  return toolName === "WriteFile" || toolName === "EditFile" || toolName === "bash";
}

function formatTeammateToolResult(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    if (typeof timeout === "object" && "unref" in timeout) {
      timeout.unref();
    }
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
