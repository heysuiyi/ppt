import type { AgentModelGateway } from "../../agent/gateway";
import { AgentRunFactory } from "../../agent/runtime/agent-run-factory";
import { AgentRuntime } from "../../agent/runtime/agent-runtime";
import type { AgentRunScope } from "../../agent/runtime/lifecycle/agent-run-scope";
import type { RuntimePlugin } from "../../agent/runtime/runtime-plugin";
import type { AgentRuntimeOptions } from "../../agent/runtime/runtime-types";
import { createEmptySkillRegistry, type SkillRegistry } from "../../agent/skills/loadSkillsDir";
import type { PptLifecycleToolBridge } from "../../agent/tools/tool-definition";
import type { ToolRegistry } from "../../agent/tools/tool-registry";
import type { ConversationDatabase } from "../../conversation-database";
import { requirePresentation } from "./context";
import { createPptFilePolicy } from "./file-policy";
import {
  buildSystemPromptContext,
  clearSystemPromptCache,
  getSystemPrompt,
} from "./prompts/system-prompt";
import { createPptTaskSession, type PptTaskPlanSession } from "./task/ppt-task-session";
import { createPptTeammateDomain } from "./teammate-domain";

export type ResolvePptLifecycle = (input: {
  queryId: AgentRunScope["queryId"];
  options: AgentRuntimeOptions;
}) => PptLifecycleToolBridge | undefined;

/** One instance per host session; all PPT-specific prompt and context assembly lives here. */
export function createPptPlugin(
  skillRegistry: SkillRegistry,
  resolveLifecycle?: ResolvePptLifecycle,
): RuntimePlugin {
  const taskSessions = new Map<string, PptTaskPlanSession>();
  return {
    id: "ppt",
    validateOptions(options) {
      if (!options.presentationSnapshot)
        throw new Error("PPT plugin requires a Presentation snapshot.");
    },
    createRunState(options, recovered) {
      const prior = taskSessions.get(options.threadId);
      const recoveredPlan = recovered?.version === 2 ? recovered.pptTaskPlan : undefined;
      const session =
        options.startMode.type === "resume_query"
          ? createPptTaskSession({ plan: recoveredPlan ?? prior?.plan })
          : createPptTaskSession();
      taskSessions.set(options.threadId, session);
      return {
        toolContext: { pptTaskSession: session },
        checkpoint: () => ({
          baseRevision: options.presentationSnapshot!.revision,
          ...(session.plan ? { pptTaskPlan: structuredClone(session.plan) } : {}),
        }),
      };
    },
    promptRevision: (context) => context.pptTaskSession?.plan?.revision ?? null,
    configureContext(scope, context) {
      const lifecycle = resolveLifecycle?.({ queryId: scope.queryId, options: scope.options });
      return {
        ...context,
        presentation: structuredClone(scope.options.presentationSnapshot),
        currentSlideId: scope.options.currentSlideId,
        selectedElementIds: [...scope.options.selectedElementIds],
        presentationLifecycle: lifecycle,
        filePolicy: createPptFilePolicy(lifecycle),
        teammateDomain: createPptTeammateDomain(skillRegistry),
      };
    },
    async buildPrompt(scope, context, coreTools) {
      clearSystemPromptCache(scope.options.threadId);
      const promptContext = await buildSystemPromptContext({
        request: scope.options.request,
        presentation: requirePresentation(context),
        coreTools,
        skillCatalog: skillRegistry.listCards(),
        skillRegistry,
        workspaceRoot: scope.options.workspaceRoot,
        currentSlideId: scope.options.currentSlideId,
        messageHistory: scope.options.messageHistory,
        requiredOutcome: scope.options.requiredOutcome,
        stepLimits: context.agentStepLimits,
        stageHint: scope.options.stageHint,
        pptTaskPlan: context.pptTaskSession?.plan,
      });
      return {
        text: getSystemPrompt(promptContext, scope.options.threadId).text,
        promptStage: promptContext.stage,
      };
    },
    clearSession(threadId) {
      taskSessions.delete(threadId);
      clearSystemPromptCache(threadId);
    },
  };
}

export function createPptRuntime(
  registry: ToolRegistry,
  gateway: AgentModelGateway,
  skills: SkillRegistry = createEmptySkillRegistry(),
  database?: ConversationDatabase,
  resolveLifecycle?: ResolvePptLifecycle,
): AgentRuntime {
  return new AgentRuntime(
    new AgentRunFactory(
      registry,
      gateway,
      skills,
      database,
      createPptPlugin(skills, resolveLifecycle),
    ),
  );
}
