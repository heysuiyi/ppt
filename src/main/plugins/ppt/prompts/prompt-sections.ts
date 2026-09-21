import type { AgentStepLimits } from "@shared/agent-step-limits";
import type { SkillRegistry } from "../../../agent/skills/loadSkillsDir";
import type { SkillCard } from "../../../agent/skills/skill-types";
import { toToolCard } from "../../../agent/tools/tool-card";
import type { ToolDefinition } from "../../../agent/tools/tool-definition";
import type {
  WorkspaceArtifactProbeDetails,
  WorkspaceArtifacts,
} from "../presentation/workspace-artifacts";
import { formatPptTaskPlanProjection } from "../task/ppt-task-composer";
import type { PptTaskPlan } from "../task/ppt-task-types";
import { formatSvgDeckLockContractBlock } from "../tools/svg-deck-locks";
import { describePromptStage, type PromptStage } from "./prompt-stage";
import { buildContentBlockResponseGuidance } from "./response-guidance";
import {
  isSkillRecommendedForStage,
  rankSkillCatalogForStage,
  skillTierFromPlan,
} from "./skill-stage-policy";

export type PromptSectionId =
  | "identity"
  | "responseProtocol"
  | "runtimeContext"
  | "tools"
  | "workspace"
  | "memory"
  | (string & {});

export type PromptSectionLoadPolicy = "always" | "conditional";
export type PromptSectionCacheScope = "global" | null;

export interface PromptSectionDef {
  id: PromptSectionId;
  loadPolicy: PromptSectionLoadPolicy;
  cacheScope: PromptSectionCacheScope;
  order: number;
}

/**
 * Default section metadata. Only sections whose bytes are independent of a
 * thread belong to the global prefix. Runtime, tool, workspace, and memory
 * facts stay after the cache boundary.
 */
export const PROMPT_SECTION_DEFS: Record<string, PromptSectionDef> = {
  identity: { id: "identity", loadPolicy: "always", cacheScope: "global", order: 10 },
  responseProtocol: {
    id: "responseProtocol",
    loadPolicy: "always",
    cacheScope: "global",
    order: 20,
  },
  runtimeContext: {
    id: "runtimeContext",
    loadPolicy: "always",
    cacheScope: null,
    order: 30,
  },
  tools: { id: "tools", loadPolicy: "always", cacheScope: null, order: 40 },
  workspace: { id: "workspace", loadPolicy: "always", cacheScope: null, order: 50 },
  memory: { id: "memory", loadPolicy: "conditional", cacheScope: null, order: 60 },
};

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "\n<!-- SYSTEM_PROMPT_DYNAMIC -->\n";

export interface IdentitySectionInput {
  stage?: PromptStage;
  stepLimits?: AgentStepLimits;
}

export interface ResponseProtocolSectionInput {
  requiredOutcome?: "any" | "command_proposal";
}

export interface RuntimeContextSectionInput {
  stage: PromptStage;
  requiredOutcome?: "any" | "command_proposal";
  stepLimits?: AgentStepLimits;
  enabledTools?: ToolDefinition<any, any>[];
  pptTaskPlan?: PptTaskPlan;
}

export interface ToolsSectionInput {
  stage: PromptStage;
  enabledTools: ToolDefinition<any, any>[];
  skillCatalog?: SkillCard[];
  skillRegistry?: SkillRegistry;
  pptTaskPlan?: PptTaskPlan;
}

export interface WorkspaceSectionInput {
  stage: PromptStage;
  workspaceRoot?: string;
  currentSlideId?: string;
  artifacts?: WorkspaceArtifacts;
  artifactDetails?: WorkspaceArtifactProbeDetails;
}

export interface MemorySectionInput {
  memories: string;
}

export function buildIdentitySection(_input: IdentitySectionInput = {}): string {
  return `你是一个专业的 PPT Agent，也是能够独立调查、编辑、验证和交付结果的工程型智能体。

## 工作原则

- 先理解用户本轮真实目标；问答就直接回答，需要行动就使用工具完成，不把所有输入强行套入固定流程。
- 普通问答不要创建 PPT capability。只要本 Query 将开始 create、edit、restyle 或 review，必须先且只需调用一次 \`BeginPptCapability\` 声明对应 capability；后续 Presentation 工具必须沿用该 Query 的 active request，不能用 runId 或 threadId 代替 QueryId。
- 实质 PPT 创作/修改前，可先调用 \`SetPptTaskAssessment\` 登记意图、难度与协作偏好，获取能力组合与 Skill 推荐；该工具不创建 capability、不授权修改、不写作者文件。已有评估时按路径推荐执行；新用户请求改变目标时重新评估。
- **工具顺序**：create/edit/restyle/review 必须先 \`BeginPptCapability\`，再 \`ResolveProjectTemplate\` / 写作者文件 / Preview / Submit。不要把 Presentation 作者工具与首次评估同批抢跑；Begin 之前调用会返回 invalid-input。
- **Capability 契约优先于路径文案**：\`SubmitSvgDeck\` 仅接受 create/edit/restyle；同一 Query 不能切换 capability。review Query 的交付终点是 \`SubmitPptReview\` QualityReport；审查并修复时，可执行方案是新开 edit/restyle capability 并在 inspect 套用检查表，或跨 Query 先报告再改稿。路径候选中的 unsupported 表示当前不可执行，不能靠放宽 ACL「修好」。
- 根据当前 Presentation、Workspace、任务状态和工具结果决定下一步。阶段标签只是上下文提示，不是控制流或能力白名单。路径候选是能力组合建议，也不是权限表。
- 在合理范围内自主推进：先检查必要事实，再修改，再验证。不要只描述将来会做什么。
- 降低模型往返：每一轮尽量把参数已知且互不依赖的读取、写入、预览、技能加载放进同一 assistant 响应；只有必须看见 tool_result 才能填下一参数时才开新轮。不要为了“看起来一步一步”而把独立工作拆成多轮。
- 新建整套 PPT 或整套重做时，以完整页面 SVG 为唯一视觉事实源：先锁定沟通契约、argument mode、visual style、reading mode 和逐页 audience move / rhythm / layout intent，再用 WriteFile 写 1280×720 的自包含 SVG，最后只用 SubmitSvgDeck 提交。每份 SVG 必须已经包含标题、背景、页码、图表、图片和装饰；不要调用固定 layout handler，也不要依赖预览器或导出器补视觉 chrome。
- 不要让用户在“标准排版 / 创意装饰”、safe / shifted / bold 或其他内部设计候选中做流程选择。只有用户明确要求比较方案时才展示候选；只有用户明确说“只要内容草稿”时才允许在未排版草稿处结束。
- 简单任务直接完成；只有工作确实可并行、需跨回合恢复或存在依赖时才创建 Task/teammate。
- 用户明确要求多 Agent 时：在真实工具可用的前提下寻找最小可验收分工（Lead 作者/整合，teammate 独立核对或资料辅助），并写清委派契约；工具不可用时显式说明，不静默改口。Lead 始终持有锁文件与页面 SVG 的最终写入与提交。
- 尊重用户范围和已有产物。不要因为模板流程而重做已完成工作，也不要把局部修改扩成整套重构。
- 工具失败是可恢复信息：阅读错误结果，调整参数或检查持久化产物；有副作用不确定时不要盲目重试。
- 真实变更必须通过本 Query 实际提供的受审 proposal 或 Workspace 写入能力完成；不要用文字假装已经执行。`;
}

export function buildResponseProtocolSection(_input: ResponseProtocolSectionInput = {}): string {
  return `${buildContentBlockResponseGuidance()}

## 完成与验证

- 只有实际结果已产生时才声称完成；能验证的修改应读取、预览或校验后再总结。
- 信息确实缺失且会改变内容事实或交付目标时才使用当前可用的用户交互能力；不要询问工具名、内部阶段、排版类型或实现细节。
- 不在文本中伪造 tool_use、tool_result、JSON envelope 或执行结果。`;
}

export function buildRuntimeContextSection(input: RuntimeContextSectionInput): string {
  const budget = input.stepLimits?.enabled
    ? `主 Agent ${input.stepLimits.mainMaxSteps} 次模型调用；子 Agent ${input.stepLimits.subMaxSteps} 次`
    : "未启用硬性步骤提示；仍应合并无意义的重复操作";
  const outcomeTools = (input.enabledTools ?? [])
    .filter((tool) => tool.behavior?.capabilities?.includes("command_proposal"))
    .map((tool) => `\`${tool.name}\``);
  const interactionTools = (input.enabledTools ?? [])
    .filter((tool) => tool.behavior?.capabilities?.includes("user_interaction"))
    .map((tool) => `\`${tool.name}\``);
  const requiredOutcome =
    input.requiredOutcome === "command_proposal"
      ? [
          "",
          `本回合要求产生 Presentation 行动结果：可执行时必须由 ${
            outcomeTools.length > 0 ? outcomeTools.join("、") : "当前清单中的行动能力"
          } 返回 command_proposal，不能用文字代替执行；信息不足时才使用 ${
            interactionTools.length > 0 ? interactionTools.join("、") : "当前可用的用户交互能力"
          }。`,
        ].join("\n")
      : "";
  const planBlock = formatRuntimeTaskPlanBlock(input.pptTaskPlan);

  return `## Runtime Context

- 建议阶段：\`${input.stage}\`（${describePromptStage(input.stage)}）
- 阶段语义：仅用于排序相关 Skill 和解释现有产物；模型可以根据证据跨阶段选择能力。
- 步骤预算：${budget}${requiredOutcome}${planBlock}`;
}

function formatRuntimeTaskPlanBlock(plan?: PptTaskPlan): string {
  if (!plan) return "";
  return `\n\n### PPT Task Plan\n\n${formatPptTaskPlanProjection(plan)}`;
}

export function buildToolsSection(input: ToolsSectionInput): string {
  const skillLoaders = input.enabledTools.filter((tool) =>
    tool.behavior?.capabilities?.includes("skill_load"),
  );
  const catalog = rankSkillCatalogForStage(
    input.skillCatalog ?? [],
    input.stage,
    input.skillRegistry,
    input.pptTaskPlan,
  );
  const skills =
    catalog.length > 0
      ? catalog
          .map((skill) => {
            const entry = input.skillRegistry?.get(skill.name);
            const pathTier = skillTierFromPlan(input.pptTaskPlan, skill.name);
            const stageRecommended = isSkillRecommendedForStage(skill.name, input.stage, entry);
            const badge =
              pathTier === "now"
                ? " [现在需要]"
                : pathTier === "later"
                  ? " [本路径稍后需要]"
                  : stageRecommended
                    ? " [当前上下文推荐]"
                    : "";
            const whenToUse = skill.whenToUse ? ` | 适用: ${skill.whenToUse}` : "";
            return `- \`${skill.name}\`${badge}: ${skill.description}${whenToUse}`;
          })
          .join("\n")
      : "（没有已注册 Skill）";
  const tools = input.enabledTools
    .map((tool) => {
      const { name, risk, approvalRequired, execution } = toToolCard(tool);
      return JSON.stringify({ name, risk, approvalRequired, execution });
    })
    .join("\n");
  const skillLoadingGuidance =
    skillLoaders.length > 0
      ? `目录会把当前任务路径相关项排在前面，但任何已注册 Skill 都可以在确有需要时通过 ${formatToolNames(
          skillLoaders,
        )} 加载。路径不隐藏或禁用 Skill；stages 仅作产物阶段提示。`
      : "目录会把当前任务路径相关项排在前面，任何已注册 Skill 都保留在目录中；只有实际工具清单提供加载能力时才能展开全文。";
  const guidance = [
    "- 用最直接的能力完成任务，不要为了遵守阶段模板而制造额外 Task、文件或模型轮次。",
    "- 默认交付可用结果：回答用户要求、事实与假设可区分、文字可读、没有明显裁切或重叠，当前版本预览与提交有效即可完成。没有具体缺陷时停止润色；不为追求完美构图扩大任务。",
    "- 按用户明确范围与现有资料评估工作量，不把自行增加的页数、研究或装饰算成用户要求。缺少资料但用户要求直接开始时，明确采用示例假设；数字与来源不得伪装成真实内部数据。",
    "- 每轮完成一个可验收的产物或合理批次。页面较多时分批写入，先完成下一页或少量页面，不在思考中预演整套 SVG。减少无效往返，不等于一次输出所有页面。",
    "- 实质 PPT 创作/修改前可先调用 SetPptTaskAssessment 登记评估并取得路径推荐；普通问答无需调用。",
    "- 参数彼此独立的工具调用应在同一个 assistant 响应中一次发出；即使工具标记为 serial，也应通过同批调用减少模型往返。",
    "- 如果某个调用的参数依赖兄弟调用的结果，必须等待结果后在下一轮调用；execution.batch=exclusive 的工具必须单独调用。",
    "- execution.mode=parallel 的调用会由 Runtime 安全并发；conflictScope=workspace_path 时，同一路径读写保持有序、不同路径可以并发。",
    "- 阶段切换或本轮即将发出 tool_use 时，须先输出 1–2 句可见 Markdown 意图（要查看什么、接着进入哪一阶段），再发本批工具；不要把意图只写在思考通道里。禁止“继续推进 / 接着我将…”类空话，也不要逐条复述工具名。不要为旁白把可同批的独立工具拆成多轮。开场目标、用户决策与收尾交付仍须写正文。",
  ];
  const batchExamples = buildIndependentBatchExamples(input.enabledTools);
  if (batchExamples) {
    guidance.splice(2, 0, `- 可同批示例：${batchExamples}`);
  }
  const availableFileTools = input.enabledTools.filter((tool) =>
    tool.permission?.effects.some(
      (effect) => effect === "workspace.read" || effect === "workspace.write",
    ),
  );
  if (availableFileTools.length > 0) {
    guidance.push(
      `- Workspace 文件能力（${formatToolNames(availableFileTools)}）受统一沙箱与版本协议保护；修改既有文件前先读取，冲突时重新读取后再编辑。`,
    );
  }
  const proposalTools = input.enabledTools.filter((tool) =>
    tool.behavior?.capabilities?.includes("command_proposal"),
  );
  if (proposalTools.length > 0) {
    guidance.push(
      `- ${formatToolNames(proposalTools)} 产生受审的 Presentation proposal；不能绕过 CommitGate。`,
    );
  }
  const discoveryTools = input.enabledTools.filter((tool) =>
    tool.behavior?.capabilities?.includes("tool_discovery"),
  );
  const delegationTools = input.enabledTools.filter((tool) => tool.behavior?.delegation);
  if (discoveryTools.length > 0) {
    guidance.push(`- ${formatToolNames(discoveryTools)} 只发现当前 Query 可用的可选增强能力。`);
  }
  if (delegationTools.length > 0) {
    guidance.push(
      `- ${formatToolNames(delegationTools)} 只路由本 Query 已发现且仍可用的能力；目标仍经过统一权限和执行管线。`,
    );
  }
  if (skillLoaders.length > 0) {
    guidance.push(
      `- ${formatToolNames(skillLoaders)} 可加载任意已注册 Skill；阶段匹配只影响推荐顺序。` +
        "已知需要多个技能时可同批多次调用，不要一技能一轮。",
    );
  }
  const interactionTools = input.enabledTools.filter((tool) =>
    tool.behavior?.capabilities?.includes("user_interaction"),
  );
  if (interactionTools.length > 0) {
    guidance.push(
      `- 只有涉及会实质改变结果的用户决策时才调用 ${formatToolNames(interactionTools)}。`,
    );
  }

  return `## Available Skills

Skill 是按需加载的知识，不是固定工作流。${skillLoadingGuidance}

${skills}

## Core Tools

以下清单来自本次 Query 的实际工具解析结果；未列出的工具不可直接调用。用途和参数以原生 tools schema 为准，此处仅补充审批与批次约束。

${tools}

## Tool Selection

${guidance.join("\n")}`;
}

function formatArtifactProbe(
  label: string,
  probe: { status: string; verified: boolean; reason?: string } | undefined,
  fallbackVerified?: boolean,
): string {
  if (probe) {
    if (probe.verified) return `- ${label}: verified`;
    if (probe.status === "invalid" && probe.reason) {
      return `- ${label}: invalid: ${probe.reason}`;
    }
    if (probe.status === "missing") return `- ${label}: missing`;
    if (probe.status === "empty") {
      return `- ${label}: empty${probe.reason ? `: ${probe.reason}` : ""}`;
    }
    if (probe.status === "default") {
      return `- ${label}: default/unverified${probe.reason ? `: ${probe.reason}` : ""}`;
    }
    return `- ${label}: ${probe.status}`;
  }
  if (fallbackVerified === undefined) return `- ${label}: （未探测）`;
  return `- ${label}: ${fallbackVerified ? "verified" : "missing/unverified"}`;
}

function formatArtifactState(
  artifacts?: WorkspaceArtifacts,
  details?: WorkspaceArtifactProbeDetails,
): string {
  if (!artifacts && !details) return "（未探测 Workspace 产物）";
  return [
    formatArtifactProbe("design/design-spec.json", details?.designSpec, artifacts?.designSpec),
    formatTemplatePolicyProbe(details?.templatePolicy, artifacts?.templatePolicy),
    formatTemplatePackProbe(details?.templatePack, artifacts?.templatePack),
    formatArtifactProbe("slides/page-plan.json", details?.pagePlan, artifacts?.pagePlan),
    formatArtifactProbe("slides/svg/*.svg", details?.pageSvg, artifacts?.pageSvg),
    formatArtifactProbe("assets/**", details?.assets, artifacts?.assets),
    formatArtifactProbe("deck/snapshot.json", details?.deck, artifacts?.deck),
    formatArtifactProbe("history/exports.json", details?.exportHistory, artifacts?.exportHistory),
    formatArtifactProbe("optional brief.md", details?.brief, artifacts?.brief),
    formatArtifactProbe("optional outline.md", details?.outline, artifacts?.outline),
    formatArtifactProbe("optional research/**", details?.research, artifacts?.research),
  ].join("\n");
}

function formatTemplatePolicyProbe(
  probe: { status: string; verified: boolean; reason?: string } | undefined,
  fallbackVerified?: boolean,
): string {
  if (probe) {
    const detail = probe.reason ? `: ${probe.reason}` : "";
    if (probe.verified) return `- design/template-policy.json: ${probe.status}${detail}`;
    if (probe.status === "invalid" && probe.reason) {
      return `- design/template-policy.json: invalid: ${probe.reason}`;
    }
    if (probe.status === "missing") return `- design/template-policy.json: missing`;
    return `- design/template-policy.json: ${probe.status}${detail}`;
  }
  if (fallbackVerified === undefined) return `- design/template-policy.json: （未探测）`;
  return `- design/template-policy.json: ${fallbackVerified ? "verified" : "missing/unverified"}`;
}

function formatTemplatePackProbe(
  probe: { status: string; verified: boolean; reason?: string } | undefined,
  fallbackVerified?: boolean,
): string {
  if (probe) {
    const detail = probe.reason ? `: ${probe.reason}` : "";
    if (probe.verified) return `- design/template-pack.json: ${probe.status}${detail}`;
    if (probe.status === "invalid" && probe.reason) {
      return `- design/template-pack.json: invalid: ${probe.reason}`;
    }
    if (probe.status === "missing") return `- design/template-pack.json: missing`;
    return `- design/template-pack.json: ${probe.status}${detail}`;
  }
  if (fallbackVerified === undefined) return `- design/template-pack.json: （未探测）`;
  return `- design/template-pack.json: ${fallbackVerified ? "verified" : "missing/unverified"}`;
}

function formatActiveTemplateSection(details?: WorkspaceArtifactProbeDetails): string {
  const pack = details?.templatePack;
  if (!pack?.verified || !pack.reason) return "";
  return `

### Template Active (design-reference)

- ${pack.reason}
- 必须调用 ResolveProjectTemplate（或直接沿用已种子化的 design-spec axes），把 selection → resolvedTemplate 与 designSystem 写入 design/design-spec.json。
- 禁止另选冲突 builtin visualStyle / 调色板 / 字体；GetDesignReference 仅提供构图纪律，不得覆盖 pack 外观。
- 不继承：PowerPoint 母版切换、原 placeholder 编辑、导出母版关系。
- 页面仍重生为 1280×720 SVG；logo/页眉页脚/标题框按 pack chrome 与 assets 路径绘制。`;
}

function shouldInjectSvgDeckLockContract(
  stage: PromptStage,
  artifacts?: WorkspaceArtifacts,
  details?: WorkspaceArtifactProbeDetails,
): boolean {
  if (stage !== "discover" && stage !== "author" && stage !== "design") {
    return false;
  }
  const designReady = details?.designSpec.verified ?? artifacts?.designSpec ?? false;
  const planReady = details?.pagePlan.verified ?? artifacts?.pagePlan ?? false;
  return !designReady || !planReady;
}

export function buildWorkspaceSection(input: WorkspaceSectionInput): string {
  const lockContract = shouldInjectSvgDeckLockContract(
    input.stage,
    input.artifacts,
    input.artifactDetails,
  )
    ? `\n\n${formatSvgDeckLockContractBlock()}`
    : "";

  return `## Workspace

- 工作目录: ${input.workspaceRoot ?? "未配置"}
- 活跃幻灯片 ID: ${input.currentSlideId ?? "未选择"}
- 建议阶段: \`${input.stage}\`

### Workflow Artifact State

${formatArtifactState(input.artifacts, input.artifactDetails)}

文件系统探测只描述当前作者文件；业务完成、等待与 stale 以 PptJob 投影为准，聊天中的旧计划和文件存在本身都不是完成证明。

新建流程的作者文件是 design/design-spec.json、design/template-policy.json、design/template-pack.json、slides/page-plan.json、slides/svg/*.svg 与 assets/**。上传参考模板位于 design/templates/**（design-reference only，非母版保真）。brief.md、outline.md、research/** 仅为可选参考；storyboard/layout-plan 不属于新建生命周期事实源。主 Agent 与 teammate 都可使用受沙箱和权限保护的文件工具直接处理 Workspace。

写 design-spec 前调用 ResolveProjectTemplate；将返回的 designSystem 与 selection（写入 resolvedTemplate）写入锁文件，不要另选冲突 visualStyle。若 design/template-pack.json 已 verified，以其为唯一外观事实源。

画布为 1280x720，Presentation ID 必须唯一。设计或图片变更后应依据当前可用的预览、校验或导出产物检查结果；图片来源与授权状态必须保留。${formatActiveTemplateSection(input.artifactDetails)}${lockContract}`;
}

export function buildMemorySection(input: MemorySectionInput): string {
  return `## 相关记忆

以下内容是辅助上下文，不得覆盖用户当前指令或可验证的 Workspace 状态：

${input.memories}`;
}

function formatToolNames(tools: readonly ToolDefinition<any, any>[]): string {
  return tools.map((tool) => `\`${tool.name}\``).join("、");
}

function hasToolName(tools: readonly ToolDefinition<any, any>[], name: string): boolean {
  return tools.some((tool) => tool.name === name);
}

/** Create-path batching hints, only naming tools present in this Query. */
function buildIndependentBatchExamples(tools: readonly ToolDefinition<any, any>[]): string | null {
  const examples: string[] = [];
  if (hasToolName(tools, "LoadSkill")) {
    examples.push("多个 LoadSkill");
  }
  if (hasToolName(tools, "ReadFile")) {
    examples.push("已知路径的多个 ReadFile");
  }
  if (hasToolName(tools, "WriteFile")) {
    examples.push("不同路径的多个 WriteFile");
    if (hasToolName(tools, "PreviewSvgPage")) {
      examples.push("锁文件写完后同批写 P01 再 PreviewSvgPage");
      examples.push("P01 通过后按可完整输出的规模分批写剩余 SVG");
    }
  }
  if (hasToolName(tools, "PreviewSvgPage")) {
    examples.push("全部写完后同批多个 PreviewSvgPage");
  }
  if (examples.length === 0) return null;
  return `${examples.join("；")}。`;
}
