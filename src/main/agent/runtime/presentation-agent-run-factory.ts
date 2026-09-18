import { getEffectiveMainMaxSteps, resolveAgentStepLimits } from "@shared/agent-step-limits";
import type { TeammateProgressEvent } from "@shared/teammate-progress";
import type { ConversationDatabase } from "../../conversation-database";
import type { AgentModelGateway } from "../gateway";
import { createEmptySkillRegistry, type SkillRegistry } from "../skills/loadSkillsDir";
import type { SkillSession } from "../skills/skill-types";
import { LEAD_TASK_PERMISSIONS } from "../task/task-store";
import {
  canonicalizeWorkspaceRoot,
  WorkspaceFileService,
} from "../tools/files/workspace-file-service";
import type {
  PptLifecycleToolBridge,
  ToolContext,
  ToolDiscoverySession,
} from "../tools/tool-definition";
import type { ToolRegistry } from "../tools/tool-registry";
import { toToolSchemas } from "../tools/tool-schema";
import { LeadInboxInputSource } from "./background/lead-inbox-input-source";
import { ensureDefaultHooks } from "./hooks/default-hooks";
import type { PostToolUseBlock, UserPromptSubmitBlock } from "./hooks/hook-blocks";
import { triggerHooks } from "./hooks/hook-registry";
import { AgentRunScope } from "./lifecycle/agent-run-scope";
import { rethrowIfRuntimeCancellation } from "./lifecycle/runtime-cancellation";
import { createPptTaskSession, type PptTaskPlanSession } from "./ppt-task/ppt-task-session";
import { PresentationCompletionPolicy } from "./presentation/presentation-completion-policy";
import {
  buildSystemPromptContext,
  clearSystemPromptCache,
  getSystemPrompt,
} from "./prompts/system-prompt";
import type { AgentRuntimeOptions, AgentRuntimeResult } from "./runtime-types";
import { ToolExecutionEngine } from "./tools/tool-execution-engine";
import { ToolPreflight } from "./tools/tool-preflight";
import { PreparedAgentRun } from "./turns/prepared-agent-run";

export type AgentRunPreparation =
  | { type: "ready"; run: PreparedAgentRun }
  | { type: "short_circuit"; result: AgentRuntimeResult };

/** Builds the Presentation-specific execution environment outside the stable loop. */
export class PresentationAgentRunFactory {
  private readonly discoverySessions = new Map<string, ToolDiscoverySession>();
  private readonly skillSessions = new Map<string, SkillSession>();
  private readonly pptTaskSessions = new Map<string, PptTaskPlanSession>();
  private readonly fileSessions = new Map<string, WorkspaceFileService>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly gateway: AgentModelGateway,
    private readonly skillRegistry: SkillRegistry = createEmptySkillRegistry(),
    private readonly conversationDatabase?: ConversationDatabase,
    private readonly resolvePresentationLifecycle?: (input: {
      queryId: AgentRunScope["queryId"];
      options: AgentRuntimeOptions;
    }) => PptLifecycleToolBridge | undefined,
  ) {}

  async open(options: AgentRuntimeOptions): Promise<AgentRunScope> {
    ensureDefaultHooks();
    return await AgentRunScope.open({
      options,
      conversationDatabase: this.conversationDatabase,
      resolveDiscoverySession: (recovered) => {
        const session = this.discoverySessions.get(options.threadId) ?? {
          discoveredToolNames: new Set<string>(recovered?.discoveredToolNames ?? []),
        };
        this.discoverySessions.set(options.threadId, session);
        return session;
      },
      resolveSkillSession: (recovered) => {
        const session = this.skillSessions.get(options.threadId) ?? {
          loadedSkillNames: new Set<string>(recovered?.loadedSkillNames ?? []),
        };
        this.skillSessions.set(options.threadId, session);
        return session;
      },
      resolvePptTaskSession: (recovered) => {
        const prior = this.pptTaskSessions.get(options.threadId);
        const recoveredPlan =
          recovered && recovered.version === 2 ? recovered.pptTaskPlan : undefined;
        // resume_query restores the plan; new_query starts empty (re-assess).
        const session =
          options.startMode.type === "resume_query"
            ? createPptTaskSession({ plan: recoveredPlan ?? prior?.plan })
            : createPptTaskSession();
        this.pptTaskSessions.set(options.threadId, session);
        return session;
      },
    });
  }

  async prepare(scope: AgentRunScope): Promise<AgentRunPreparation> {
    const { options, session, taskStore } = scope;
    const stepLimits = resolveAgentStepLimits(options.agentStepLimits);
    const maxSteps = options.maxSteps ?? getEffectiveMainMaxSteps(stepLimits);
    const emitProgress = scope.eventPorts.renderer.bind(scope.eventPorts);
    const contextBase: ToolContext = {
      presentation: structuredClone(options.presentationSnapshot),
      request: options.request,
      currentSlideId: options.currentSlideId,
      selectedElementIds: [...options.selectedElementIds],
      discoverySession: scope.discoverySession,
      registry: this.registry,
      messageHistory: options.messageHistory ?? [],
      workspaceRoot: options.workspaceRoot,
      fileService: this.resolveFileService(options.threadId, options.workspaceRoot),
      gateway: this.gateway,
      searchConfig: this.gateway.getSearchConfig?.(),
      model: options.model,
      signal: scope.signal,
      requestToolApproval: options.requestToolApproval,
      notifyTaskListUpdated: () => {
        if (taskStore) scope.taskSubscription?.notifyTasksUpdated(taskStore.identity.taskListId);
      },
      onTeammateProgress: options.onProgress
        ? (event) => emitProgress({ ...event, message: teammateProgressMessage(event) })
        : undefined,
      agentStepLimits: stepLimits,
      skillRegistry: this.skillRegistry,
      skillSession: scope.skillSession,
      taskStore,
      taskPrincipal: taskStore?.principal(scope.taskListOwner, "lead", LEAD_TASK_PERMISSIONS),
      taskListOwner: scope.taskListOwner,
      messageBus: options.messageBus,
      teammateManager: options.teammateManager,
      presentationLifecycle: this.resolvePresentationLifecycle?.({
        queryId: scope.queryId,
        options,
      }),
      pptTaskSession: scope.pptTaskSession,
    };
    const coreTools = this.registry.getCoreTools(contextBase);
    const promptContext = await buildSystemPromptContext({
      request: options.request,
      presentation: options.presentationSnapshot,
      coreTools,
      skillCatalog: this.skillRegistry.listCards(),
      skillRegistry: this.skillRegistry,
      workspaceRoot: options.workspaceRoot,
      currentSlideId: options.currentSlideId,
      messageHistory: options.messageHistory,
      requiredOutcome: options.requiredOutcome,
      stepLimits,
      stageHint: options.stageHint,
      pptTaskPlan: scope.pptTaskSession.plan,
    });
    const { text: systemPrompt } = getSystemPrompt(promptContext, options.threadId);
    const context: ToolContext = {
      ...contextBase,
      promptStage: promptContext.stage,
    };

    const promptBlock: UserPromptSubmitBlock = {
      event: "UserPromptSubmit",
      threadId: options.threadId,
      request: options.request,
      messageHistory: options.messageHistory,
    };
    const promptStop = await triggerHooks("UserPromptSubmit", promptBlock);
    if (promptStop) {
      return {
        type: "short_circuit",
        result: { type: "message", content: promptStop.reason },
      };
    }

    const runPostToolUseHook = async (block: PostToolUseBlock): Promise<string[]> => {
      try {
        await triggerHooks("PostToolUse", block);
        return [];
      } catch (error) {
        rethrowIfRuntimeCancellation(error, scope.signal, options.signal);
        const message = error instanceof Error ? error.message : String(error);
        session.appendTranscript({
          role: "system",
          kind: "hook_error",
          hook: "PostToolUse",
          toolName: block.toolName,
          content: message,
        });
        emitProgress({
          type: "workflow-warning",
          message: `工具 ${block.toolName} 已执行，但 PostToolUse Hook 失败：${message}`,
          toolName: block.toolName,
        });
        return [message];
      }
    };
    const leadInbox = new LeadInboxInputSource({
      messageBus: options.messageBus,
      teammateManager: options.teammateManager,
      requestToolApproval: options.requestToolApproval,
      session,
      commit: () => scope.persistCheckpoint(),
    });
    return {
      type: "ready",
      run: new PreparedAgentRun({
        scope,
        gateway: this.gateway,
        conversationDatabase: this.conversationDatabase,
        systemPrompt,
        toolSchemas: toToolSchemas(coreTools),
        context,
        maxSteps,
        stepLimits,
        leadInbox,
        toolPreflight: new ToolPreflight(this.registry),
        toolExecutionEngine: new ToolExecutionEngine(),
        presentationCompletionPolicy: new PresentationCompletionPolicy(),
        runPostToolUseHook,
        refreshSystemPrompt: async ({ toolUseContext, planRevision }) => {
          // Rebuild dynamic prompt sections after SetPptTaskAssessment commits a new plan.
          clearSystemPromptCache(options.threadId);
          const refreshedContext = await buildSystemPromptContext({
            request: options.request,
            presentation: toolUseContext.presentation,
            coreTools,
            skillCatalog: this.skillRegistry.listCards(),
            skillRegistry: this.skillRegistry,
            workspaceRoot: options.workspaceRoot,
            currentSlideId: options.currentSlideId,
            messageHistory: options.messageHistory,
            requiredOutcome: options.requiredOutcome,
            stepLimits,
            stageHint: options.stageHint,
            pptTaskPlan: toolUseContext.pptTaskSession?.plan,
          });
          void planRevision;
          return getSystemPrompt(refreshedContext, options.threadId).text;
        },
      }),
    };
  }

  clearSession(threadId: string): void {
    this.discoverySessions.delete(threadId);
    this.skillSessions.delete(threadId);
    this.pptTaskSessions.delete(threadId);
    this.fileSessions.get(threadId)?.clear();
    this.fileSessions.delete(threadId);
    clearSystemPromptCache(threadId);
  }

  private resolveFileService(
    threadId: string,
    workspaceRoot: string | undefined,
  ): WorkspaceFileService | undefined {
    if (!workspaceRoot) return undefined;
    const normalizedRoot = canonicalizeWorkspaceRoot(workspaceRoot);
    const current = this.fileSessions.get(threadId);
    if (current?.workspaceRoot === normalizedRoot) return current;
    current?.clear();
    const service = new WorkspaceFileService(workspaceRoot);
    this.fileSessions.set(threadId, service);
    return service;
  }
}

function teammateProgressMessage(event: TeammateProgressEvent): string {
  switch (event.type) {
    case "teammate-assignment-started":
      return `${event.teammateName} 开始处理：${event.description}`;
    case "teammate-thinking-chunk":
      return event.chunk;
    case "teammate-tool-started":
    case "teammate-tool-finished":
      return event.message;
    case "teammate-assignment-finished":
      return event.message ?? `${event.teammateName} 已结束当前任务。`;
    default:
      return "";
  }
}
