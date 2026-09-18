import type { AgentModelSelection } from "@shared/agent";
import type { AgentStepLimits } from "@shared/agent-step-limits";
import type { AgentTaskNode } from "@shared/agent-task-list";
import type { Presentation } from "@shared/presentation";
import type {
  ArtifactDependency,
  ArtifactKind,
  ArtifactPointer,
  BlobReference,
  PptCapability,
  PptJobProjection,
  PptStage,
  QueryId,
  ValidationReport,
} from "@shared/presentation-lifecycle";
import type { TeammateProgressListener } from "@shared/teammate-progress";
import type { z } from "zod";
import type { ArtifactChangeObservationSource } from "../../presentation-lifecycle/artifact-change-observer-types";
import type { PptReviewReport } from "../../presentation-lifecycle/presentation-lifecycle-orchestrator";
import type { AgentModelGateway, AgentModelImageBlock, AgentModelTextBlock } from "../gateway";
import type { PromptStage } from "../runtime/prompts/prompt-stage";
import type { ToolApprovalHandler } from "../runtime/tools/permission-check";
import type { ToolPermissionProfile, ToolRisk } from "../runtime/tools/tool-access-policy";
import type { PptTaskPlanSession } from "../runtime/ppt-task/ppt-task-session";
import type { SkillRegistry } from "../skills/loadSkillsDir";
import type { SkillSession } from "../skills/skill-types";
import type { TaskCommandPrincipal, TaskStore } from "../task/task-store";
import type { MessageBus } from "../teammate/message-bus";
import type { TeammateManager } from "../teammate/spawn-teammate";
import type { WorkspaceFileService } from "./files/workspace-file-service";
import type { ToolRegistry } from "./tool-registry";

/**
 * 工具加载策略。
 * - core: 首次模型请求可见，低风险，默认加载。
 * - deferred: 默认不可见，需通过 SearchExtraTools 发现后，再由 ExecuteExtraTool 调用。
 * - runtime: 仅系统内部调用，对模型永远不可见。
 * - disabled: 禁用。
 */
export type ToolLoadPolicy = "core" | "deferred" | "runtime" | "disabled";

/**
 * 单个 Agent Runtime 会话中的延迟工具发现状态。
 *
 * SearchExtraTools 只能向集合中追加实际返回给模型的 Deferred Tool 名称。
 * ExecuteExtraTool 只能执行集合中已有的名称。该状态按 thread 隔离，不能跨会话复用。
 */
export interface ToolDiscoverySession {
  discoveredToolNames: Set<string>;
}

export interface PptLifecycleToolBridge {
  readonly queryId: QueryId;
  withTransaction<T>(operation: () => T): T;
  observeArtifactChanges(input: {
    workspaceRoot: string;
    paths?: readonly string[];
    source: Extract<
      ArtifactChangeObservationSource,
      "capability_probe" | "agent_read" | "agent_write" | "preview" | "submit"
    >;
  }): Promise<void>;
  beginCapability(input: { capability: PptCapability; instruction: string }): PptJobProjection;
  requireActiveCapability(
    allowedCapabilities?: readonly PptCapability[],
    options?: { allowCompleted?: boolean },
  ): PptJobProjection;
  commitArtifact(input: {
    artifactId: string;
    kind: ArtifactKind;
    stage: PptStage;
    value: unknown;
    dependencies?: ArtifactDependency[];
    validation: ValidationReport;
    idempotencyKey: string;
  }): ArtifactPointer;
  storeBlob(value: Uint8Array, mediaType: string): Promise<BlobReference>;
  assertBlob(reference: BlobReference): Promise<void>;
  submitReview(report: PptReviewReport): PptJobProjection;
}

export type ToolRuntimeCapability =
  | "command_proposal"
  | "user_interaction"
  | "skill_load"
  | "tool_discovery";

export type ToolTerminalResultType = "command_proposal" | "ask_user";

export interface ToolCompletionBehavior {
  /**
   * The validated result protocol that can end the current Query.
   *
   * `always` means returning any other result is a tool contract violation.
   * `when_matching` lets a tool return ordinary diagnostic output as well.
   */
  terminalResult: ToolTerminalResultType;
  expectation: "always" | "when_matching";
  /**
   * Tools that can terminate must be isolated before execution so every
   * provider tool_use in the assistant batch receives a paired tool_result.
   */
  exclusiveBatch: true;
}

export interface ToolBackgroundBehavior<TArgs = unknown> {
  isRequested: (args: TArgs) => boolean;
  describe: (args: TArgs) => string;
}

export interface ToolDelegationTarget {
  toolName: string;
  input: unknown;
}

export interface ToolDelegationBehavior<TArgs = unknown> {
  /**
   * Resolve a model-visible dispatcher call to the real registered tool.
   * The runtime executes the resolved target through the same permission,
   * hook, validation and result-delivery pipeline as a direct tool.
   */
  resolve: (args: TArgs, context: ToolContext) => ToolDelegationTarget;
  allowedCategories: ReadonlyArray<ToolDefinition["category"]>;
  allowedLoadPolicies: ReadonlyArray<ToolLoadPolicy>;
}

export interface ToolPresentationBehavior<TArgs = unknown> {
  /**
   * Product runtimes with a lifecycle bridge require one of these active
   * capabilities before the tool can execute. Isolated/offline tool runtimes
   * without a bridge remain usable.
   */
  allowedCapabilities: ReadonlyArray<PptCapability>;
  /** Limit the guard to inputs that address Presentation-owned artifacts. */
  isRequired?: (args: TArgs) => boolean;
}

export interface ToolConcurrencyBehavior<TArgs = unknown> {
  /** Only explicitly opted-in tools may execute alongside sibling calls. */
  mode: "parallel";
  /**
   * Calls whose resource-key sets intersect are placed in different waves.
   * An empty set means the tool owns no mutable runtime resource shared with
   * sibling calls. Keys are runtime-only and are never accepted from models.
   */
  resourceKeys?: (args: TArgs, context: ToolContext) => ReadonlyArray<string>;
  /** Short model-facing explanation of the conflict boundary. */
  conflictScope?: "workspace_path";
}

export interface ToolRuntimeBehavior<TArgs = unknown> {
  capabilities?: ReadonlyArray<ToolRuntimeCapability>;
  completion?: ToolCompletionBehavior;
  background?: ToolBackgroundBehavior<TArgs>;
  delegation?: ToolDelegationBehavior<TArgs>;
  presentation?: ToolPresentationBehavior<TArgs>;
  concurrency?: ToolConcurrencyBehavior<TArgs>;
}

/**
 * 工具执行的只读上下文环境，包含当前 PPT 快照、选区和会话历史等。
 */
export interface ToolContext {
  /** 当前 PPT 快照（克隆快照，防模型或工具直接篡改真实状态） */
  readonly presentation: Presentation;
  /** 当前用户请求，用于校验提案是否满足本轮明确边界。 */
  readonly request?: string;
  /** 当前编辑页 ID */
  readonly currentSlideId?: string;
  /** 当前选中的元素 ID 列表 */
  readonly selectedElementIds: string[];
  /** 延迟工具发现会话 */
  readonly discoverySession: ToolDiscoverySession;
  /** 当前 Runtime 使用的工具注册表，只允许通过注册表发现和执行工具 */
  readonly registry: ToolRegistry;
  /** 历史消息上下文 */
  readonly messageHistory: Array<{ role: "user" | "assistant"; content: string }>;
  /** Session project sandbox root for teammate workspace tools. */
  readonly workspaceRoot?: string;
  /** Per-thread workspace read receipts and optimistic file versions. */
  readonly fileService?: WorkspaceFileService;
  /** Model gateway for teammate delegation. */
  readonly gateway?: AgentModelGateway;
  /** Search credentials for web/image tools; not read from model gateway config. */
  readonly searchConfig?: import("@shared/agent-gateway-config").AgentSearchConfig;
  /** Active model selection for teammate delegation. */
  readonly model?: AgentModelSelection;
  readonly signal?: AbortSignal;
  readonly requestToolApproval?: ToolApprovalHandler;
  /** Streams task-graph teammate progress to the UI. */
  readonly onTeammateProgress?: TeammateProgressListener;
  /** Emits task-list updates to the UI after Task mutations. */
  readonly notifyTaskListUpdated?: (input: {
    tasks: AgentTaskNode[];
    goal?: string | null;
    listRevision?: number;
    state?: "open" | "closed" | "archived";
    archive?: {
      outcome: "completed" | "abandoned";
      reason?: string;
      archivedBy: string;
      archivedAt: string;
    };
  }) => void;
  /** File-backed task graph store (`.tasks/` under workspace). */
  readonly taskStore?: TaskStore;
  /** Trusted runtime identity for Task commands; never sourced from model input. */
  readonly taskPrincipal?: TaskCommandPrincipal;
  /** Runtime actor id used to construct the trusted Task principal. */
  readonly taskListOwner?: string;
  /** Skills catalog scanned at harness startup (Layer 1). */
  readonly skillRegistry?: SkillRegistry;
  /** Per-run loaded skill tracking (Layer 2). */
  readonly skillSession?: SkillSession;
  /** Advisory context used to rank Skills and explain the current artifact shape. */
  readonly promptStage?: PromptStage;
  /** Query-level PPT task assessment/route session (advisory; not business state). */
  readonly pptTaskSession?: PptTaskPlanSession;
  /** Step limit config for teammate agents. */
  readonly agentStepLimits?: AgentStepLimits;
  /** File-backed inbox bus for long-lived teammates. */
  readonly messageBus?: MessageBus;
  /** Long-lived teammate manager for spawn_teammate. */
  readonly teammateManager?: TeammateManager;
  /** Presentation business lifecycle for this Query; absent in isolated tool tests. */
  readonly presentationLifecycle?: PptLifecycleToolBridge;
}

/**
 * 所有 Agent 工具的统一元数据与执行契约。
 */
export interface ToolDefinition<
  TParams extends z.ZodObject<any> = z.ZodObject<any>,
  TResult = any,
> {
  name: string;
  description: string;
  category: "core" | "deferred" | "runtime";
  loadPolicy: ToolLoadPolicy;
  inputSchema: TParams;
  /** Compact, valid JSON examples shown in the model-visible tool catalog. */
  examples?: string[];
  /** Optional runtime guard for the rich local result returned by execute(). */
  outputSchema?: z.ZodType<TResult>;
  /** Optional compact mapping for the result sent back to the model. */
  mapResultToModelContent?: (result: TResult, context: ToolContext) => string | Promise<string>;
  /** Optional multimodal provider-facing result; rich local data remains available to hooks and UI. */
  mapResultToModelBlocks?: (
    result: TResult,
    context: ToolContext,
  ) =>
    | Array<AgentModelTextBlock | AgentModelImageBlock>
    | Promise<Array<AgentModelTextBlock | AgentModelImageBlock>>;
  /** Runtime capability check; unavailable tools are not exposed or executable. */
  isEnabled?: (context: ToolContext) => boolean;
  /** Runtime orchestration semantics; execution code must not infer these from names. */
  behavior?: ToolRuntimeBehavior<z.infer<TParams>>;
  risk: ToolRisk;
  permission?: ToolPermissionProfile;
  execute: (args: z.infer<TParams>, context: ToolContext) => Promise<TResult>;
}
