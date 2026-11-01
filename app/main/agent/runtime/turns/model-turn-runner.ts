import {
  ensureToolResultPairing,
  textFromContentBlocks,
  toolUseBlocksFromContent,
} from "../../gateway";
import { formatBackgroundNotifications } from "../background/background-task-manager";
import type { AgentIterationWorkspace, AgentQueryState } from "../query/query-types";
import { callModelWithRecovery } from "./model-call-recovery";
import type { AgentLoopTurnOutcome, PreparedAgentRun } from "./prepared-agent-run";

/** Runs one sealed model turn and returns an explicit loop decision. */
export class ModelTurnRunner {
  async run(
    run: PreparedAgentRun,
    state: AgentQueryState,
    workspace: AgentIterationWorkspace,
  ): Promise<AgentLoopTurnOutcome> {
    const { scope, params } = run;
    const { session, backgroundTasks } = scope;
    const deps = params.deps;
    const currentModelStep = session.totalModelSteps;
    const checkpointDecision = scope.applyTransition({ type: "model_input_prepared" });
    const inboxContent = await run.drainLeadInboxForModel();
    const notifications = backgroundTasks.collect();
    const userContent = [
      notifications.length > 0 ? formatBackgroundNotifications(notifications) : "",
      ...session.takePendingUserContent(),
      inboxContent ?? "",
    ]
      .filter((part) => part.trim())
      .join("\n\n");
    appendUserText(workspace.messagesForQuery, userContent);
    scope.setInflightQuery("model_streaming", workspace);
    if (checkpointDecision === "commit") await scope.persistCheckpoint();

    const promptPayload = {
      transcript: [],
      queryContext: {
        source: params.querySource,
        user: params.userContext,
        system: params.systemContext,
      },
    };
    const modelMessages = workspace.messagesForQuery;
    let attemptId = crypto.randomUUID();
    safeStreamEvent(deps.onStreamEvent, { type: "attempt_started", attemptId });
    let modelResult;
    try {
      const systemPrompt = await run.resolveSystemPrompt(
        workspace.updatedToolUseContext ?? state.toolUseContext,
      );
      modelResult = await callModelWithRecovery({
        gateway: deps.gateway,
        systemPrompt,
        promptPayload,
        model: params.model,
        fallbackModel: params.fallbackModel,
        maxOutputTokensOverride: workspace.maxOutputTokensOverride,
        // Context archives are model-addressable recovery artifacts. Keep them
        // in the guarded workspace that ReadFile can actually reach; runtimeRoot
        // remains reserved for application-owned checkpoints and transcripts.
        workspaceRoot: deps.workspaceRoot,
        threadId: deps.threadId,
        signal: deps.signal,
        tools: deps.toolSchemas,
        messages: ensureToolResultPairing(modelMessages),
        stream: deps.onStreamEvent
          ? {
              onChunk: (chunk) => {
                if (chunk.type === "text_delta" && chunk.text) {
                  safeStreamEvent(deps.onStreamEvent, {
                    type: "delta",
                    attemptId,
                    text: chunk.text,
                  });
                }
              },
              onThinkingChunk: (chunk) => {
                deps.onThinkingChunk?.(chunk, currentModelStep);
              },
            }
          : undefined,
        onRecovery: (message) => {
          safeStreamEvent(deps.onStreamEvent, {
            type: "attempt_reset",
            attemptId,
            reason: message,
          });
          attemptId = crypto.randomUUID();
          safeStreamEvent(deps.onStreamEvent, { type: "attempt_started", attemptId });
          run.emitProgress({ type: "request-status", message, progress: 0 });
        },
        onContextPrepared: (preparedPayload, notes, preparedMessages) => {
          if (preparedMessages) {
            workspace.messagesForQuery = structuredClone(preparedMessages);
            scope.setInflightQuery("model_streaming", workspace);
          }
          if (!deps.conversationDatabase) return;
          deps.conversationDatabase.saveContextSnapshotForRun(
            scope.runId,
            {
              payload: preparedPayload,
              messages: preparedMessages ?? ensureToolResultPairing(workspace.messagesForQuery),
            },
            notes,
          );
        },
      });
    } catch (error) {
      safeStreamEvent(deps.onStreamEvent, {
        type: "attempt_reset",
        attemptId,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    workspace.maxOutputTokensOverride = modelResult.maxOutputTokensOverride;
    workspace.maxOutputTokensRecoveryCount =
      state.maxOutputTokensRecoveryCount + modelResult.maxOutputTokensRecoveryCount;
    workspace.hasAttemptedReactiveCompact =
      state.hasAttemptedReactiveCompact || modelResult.hasAttemptedReactiveCompact;
    safeStreamEvent(deps.onStreamEvent, { type: "attempt_committed", attemptId });
    run.appendRuntimeEvent(
      "model_response",
      {
        modelStep: currentModelStep,
        content: structuredClone(modelResult.content),
        stopReason: modelResult.stopReason,
        model: modelResult.modelUsed,
      },
      "model_only",
    );

    const seenToolCallIds = new Set<string>();
    const toolUses = toolUseBlocksFromContent(modelResult.content).filter((call) => {
      if (!call.id || !call.name || seenToolCallIds.has(call.id)) return false;
      seenToolCallIds.add(call.id);
      return true;
    });
    if (toolUses.length > 0) {
      workspace.assistantMessages.push({
        role: "assistant",
        content: structuredClone(modelResult.content),
      });
      workspace.toolUseBlocks.push(...structuredClone(toolUses));
      scope.setInflightQuery("model_received", workspace);
      const responseDecision = scope.applyTransition({
        type: "model_response_received",
        content: modelResult.content,
        toolUses,
      });
      if (responseDecision === "commit") await scope.persistCheckpoint();
      return { type: "tool_batch" };
    }

    const responseText = textFromContentBlocks(modelResult.content);
    workspace.assistantMessages.push({
      role: "assistant",
      content: structuredClone(modelResult.content),
    });
    scope.applyTransition({
      type: "model_response_received",
      content: modelResult.content,
      toolUses: [],
    });
    if (deps.requiredOutcome === "command_proposal") {
      const proposalTools = deps.capabilityToolNames.command_proposal ?? [];
      const interactionTools = deps.capabilityToolNames.user_interaction ?? [];
      const proposalInstruction =
        proposalTools.length > 0
          ? `finish with a tool that provides command_proposal capability (${proposalTools.join(", ")})`
          : "continue until a command_proposal capability becomes available";
      const interactionInstruction =
        interactionTools.length > 0
          ? `Use ${interactionTools.join(", ")} if information is still missing`
          : "If information is missing, explain the blocking facts through an available interaction capability";
      const guidance =
        "This is an unresolved presentation action. Do not narrate future work. " +
        `${interactionInstruction}; otherwise continue tools and ${proposalInstruction}.`;
      session.appendTranscript({ role: "assistant", content: responseText, error: guidance });
      workspace.followUpMessages.push({
        role: "user",
        content: [{ type: "text", text: guidance }],
      });
      return { type: "continue", reason: "required_outcome" };
    }
    if (
      await run.drainBackgroundForModel(
        workspace,
        "Background tasks have completed. Use these results before giving the final response.",
      )
    ) {
      return { type: "continue", reason: "background_result" };
    }

    const finalInboxContent = await run.drainLeadInboxForModel();
    if (finalInboxContent) {
      workspace.followUpMessages.push({
        role: "user",
        content: [{ type: "text", text: finalInboxContent }],
      });
      return { type: "continue", reason: "inbox" };
    }
    run.appendRuntimeEvent("assistant_completed", { content: responseText });
    scope.stageConversationHistory(state, workspace);
    return {
      type: "terminal",
      result: { type: "message", content: responseText },
    };
  }
}

function appendUserText(messages: AgentQueryState["messages"], text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const last = messages.at(-1);
  if (last?.role === "user" && !last.content.some((block) => block.type === "tool_result")) {
    last.content.push({ type: "text", text: trimmed });
    return;
  }
  messages.push({
    role: "user",
    content: [{ type: "text", text: trimmed }],
  });
}

function safeStreamEvent(
  handler: PreparedAgentRun["params"]["deps"]["onStreamEvent"],
  event: Parameters<NonNullable<PreparedAgentRun["params"]["deps"]["onStreamEvent"]>>[0],
): void {
  try {
    handler?.(event);
  } catch {
    // Stream projections are observational and cannot replace the Runtime result.
  }
}
