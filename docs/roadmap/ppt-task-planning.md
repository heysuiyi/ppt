# PPT 任务模型与流程选择

> 文档类型：设计提案
> 状态：总体方案 Proposed；任务评估与路径推荐已有初版代码，不能据此视为全文已实现
> 日期：2026-09-18
> 实施补充：2026-09-20；代码现状与步骤内部的数据处理、质量反馈方案见第 12 节
> 范围：梳理当前业务、流程和 Skill，设计由意图、事实与难度决定的能力组合模型。
> 不在本次范围：修改运行时代码、移除锁文件、开放新的工具权限、重写多 Agent 基础设施。

## 1. 目标与核心决策

保留业务骨架：

**理解需求与约束 → 记录必要的内容和视觉约定 → 生成 SVG → 真实渲染并检查 → 提交与应用。**

在第一步增加任务评估，产生可保存、可更新的状态对象。使用当前事实与任务评估组合 Skill，向模型提供适合本次任务的候选路径。后续执行仍由模型推进，Runtime 不按路径列表自动调用工具。

核心决策：

1. 意图决定交付终点和修改范围，难度决定各步深度，事实决定哪些工作可复用、缺失或需要重做。
2. 多 Agent 是协作维度，不是难度等级。复杂任务可以单 Agent，简单任务也可以按用户明确要求协作。
3. 路径是能力组合及依赖建议，不是新的固定阶段机，也不是权限表。
4. 先保留现有 Skill 和作者文件，通过选择条件管理使用方式；不先按数量合并或删除。
5. 难度降低不降低内容准确性、当前版本渲染、审批和提交一致性的底线。
6. 第一版仍遵守现有 design-spec/page-plan 契约。简化路径减少额外规划与重复设计，不声称已经能够绕过锁文件。

本文的“任务模型”指结构化领域模型，不是新增一个专用大模型或独立规划 Agent。由当前主模型解释自然语言，由确定性组合器生成候选和检查一致性。

## 2. 当前业务与状态边界

### 2.1 业务入口

| 用户目标 | 当前入口与主要能力 | 真实结束事实 |
|---|---|---|
| 讨论、咨询、解释 | 普通 Query；无需 BeginPptCapability | 回答完成 |
| 只要 brief、大纲或内容计划 | 可选上游 Skill + ReadFile/WriteFile | 请求的内容产物交付；不等于 deck 完成 |
| 新建整套演示 | create + workflow/design/design-layout/build | Proposal ready 与 Presentation applied 分别成立 |
| 修改页面或结构 | edit + ppt-edit | 当前源完成预览与提交，按审批策略应用 |
| 美化或整套换肤 | restyle + ppt-beautify | 受影响 SVG 完成预览与提交，按审批策略应用 |
| 结构化质量审查 | review + ppt-review + SubmitPptReview | QualityReport 绑定当前 PresentationRevision |
| PPTX 导出 | ppt-export 引导应用 UI；应用内部创建 export capability | ExportArtifact 与 Export completed |

`BeginPptCapability` 的 Agent 参数目前只有 create/edit/restyle/review；不能因为类型中存在 export 就推荐 Agent 调用该工具启动导出。

### 2.2 当前四类状态不能混为一体

| 状态 | 当前责任 | 新模型的关系 |
|---|---|---|
| QueryState / checkpoint | 一次请求内的对话、工具批次、恢复 | 保存本次任务评估与已选择路径 |
| PptJob / ArtifactRevision | 跨 Query 业务状态、已校验产物、依赖与 stale | 只读引用这些事实，不复制 ready/completed 等权威状态 |
| TaskStore / teammate | 子任务所有权、依赖、交付和验收 | 路径决定是否委派；真正执行仍使用现有协调机制 |
| PromptStage / SkillSession | 产物导出的推荐阶段、Skill 加载情况 | stage 降为事实提示；Skill 推荐使用新路径结果 |

现有 `executionStrategy` 表示 AUTO / REQUEST_APPROVAL 审批策略。新对象命名为 `PptTaskPlan`，不能复用或改变该字段语义。

### 2.3 当前主路径

```text
用户请求
  → workspace probe / Presentation / lifecycle 投影
  → resolvePromptStage（按产物事实）
  → SkillCard 排序 + LoadSkill
  → BeginPptCapability
  → ResolveProjectTemplate / GetDesignReference
  → design-spec → page-plan → 页面 SVG
  → PreviewSvgPage → SubmitSvgDeck
  → Proposal → CommitGate / 应用 → 按需 UI 导出
```

上述是主要业务依赖示意，不表示每个箭头都是独立模型轮次。

代码中的事实：

- `resolvePromptStage` 接收 request，但刻意不做自然语言意图分类；当前根据产物和页面形态返回阶段。
- `rankSkillCatalogForStage` 只按 frontmatter `stages` 推荐，其余按名称排序。
- 创建链依赖两个锁文件；Preview 在渲染前检查锁文件和页面归属，Submit 再检查锁、源与凭据。
- PageSvg revision 依赖 design-spec、page-plan 和素材，PreviewReceipt 依赖 PageSvg。锁变化可能使未改 SVG 的下游证据也过期。
- PNG 成功生成是渲染证据，不等于模型已经检查内容，也不等于设计质量通过。

### 2.4 当前缺口

1. 同一组 workspace 事实下，“改标题”“审查”“继续新建”得到的推荐可能近似；交付意图没有进入推荐计算。
2. 没有统一表达任务难度、不确定性、事实保真要求和协作偏好的对象。
3. 创建路径和轮次规则分散于 Skill、Prompt、Begin 工具反馈及锁文件恢复提示，新增推荐可能被旧规则覆盖。
4. 多 Agent 基础设施可用，但 `ppt-build` 和 `ppt-research` 正文限制主 Agent 执行；不能直接把这些 Skill 推荐给 teammate。
5. `ppt-review` 说明默认可同 review Query 修复并 SubmitSvgDeck；后者及 lifecycle 校验目前只接受 create/edit/restyle。这是已有契约不一致，设计不能把该组合标成可执行。

## 3. Skill 能力清单与选择条件

这里描述目标推荐语义；涉及正文改变的条目必须在实施时同步修改，不能仅更新目录排序。

| Skill | 负责的能力 | 何时选择 | 何时不需要新增工作 |
|---|---|---|---|
| ppt-workflow | 创建整体骨架、交付边界 | 完整新建、恢复未完成创建 | 普通问答、局部修改、只读导出 |
| ppt-brief | 澄清与记录需求 | 目标、受众或改写范围存在实质不确定性 | 输入已经清楚；已有有效约定 |
| ppt-research | 整理事实、来源与待核实项 | 用户要求调研、材料整理，或交付所需事实缺口处于已授权范围内 | 输入充分且无需外部事实；禁止联网时仅整理本地来源 |
| ppt-outline | 整套章节与论证结构 | 内容组织难、章节多、顺序尚未稳定 | 用户已给定可用顺序；简单内容可直达 page-plan |
| ppt-storyboard | 先探索逐页叙事 | 逐页内容边界仍不确定，需要先试排故事 | 已能直接写 page-plan；高难度不自动增加 storyboard |
| ppt-design | deck-wide 视觉与沟通约定 | 新建缺少设计约定，或授权改变整套设计 | 局部修改复用现有约定 |
| ppt-design-layout | 逐页内容与构图安排 | 新建、增页、跨页重构 | 未改变页面内容意图的局部视觉修改 |
| ppt-build | SVG 作者工作 | 从计划生成新页面 | 只要文字产物、已有 SVG 小改 |
| ppt-edit | 局部或结构编辑 | 用户指定已有页面修改 | 新建完整设计不必再加载一套编辑流程 |
| ppt-beautify | 视觉优化与一致性修复 | 用户要美化、排版或换肤 | 纯事实纠错、只要问题报告 |
| ppt-review | 内容/视觉/跨页检查 | 用户要求审查；高事实负担或复杂视觉需要专门检查 | 简单修改保留 build/edit 的基础检查即可，不为检查形式加载全部正文 |
| ppt-export | 导出条件与 UI 交付说明 | 用户明确需要导出 | 不在普通创建时提前加载；不能冒充真实导出工具 |

加载一次完整正文与重新创建该 Skill 的产物是两回事。已有有效文件可作为输入；不因为推荐某 Skill 就重新生成其文件。

## 4. 任务模型

### 4.1 三部分及其所有者

```text
TaskFacts（运行时观测，只读）
      +
TaskAssessment（主模型评估，有证据与待确认项）
      ↓
composePptTaskPlan（规则组合，生成候选并校验适用性）
      ↓
PptTaskPlan（推荐路径、备选、当前选择及选择理由）
```

事实不是模型自己声明的 verified；评估不是用户授权证明；路径不是产物完成证明。

### 4.2 概念类型

以下 TypeScript 用于说明字段边界，不是已经实现的接口。最终 schema 应复用现有 QueryId、artifact pointer、工具能力与消息引用类型。

```ts
type Level = "low" | "medium" | "high" | "unknown";
type Step = "understand" | "agree" | "author" | "inspect" | "submit";
type Operation = "answer" | "create" | "edit" | "restyle" | "review" | "export";
type Deliverable = "answer" | "content" | "deck" | "review-report" | "pptx";

interface AssessmentItem {
  level: Level;
  evidenceRefs: string[]; // 用户消息、已读取材料或真实工具结果
  summary: string;       // 可审计的简短判断，不存隐藏思维链
}

interface TaskAssessment {
  intent: {
    operation: Operation;
    deliverable: Deliverable;
    scope: "none" | "local" | "section" | "deck";
    targetSlideIds: string[]; // 按实际稳定 id；未定位时保留空并记录问题
    constraints: Array<{
      text: string;
      origin: "user" | "project" | "assumption";
      sourceRef: string;
    }>;
    requestedActions: string[]; // 如只审查、保留原文、生成后导出
  };
  difficulty: {
    workload: AssessmentItem;
    factBurden: AssessmentItem;
    visualComplexity: AssessmentItem;
    crossPageCoupling: AssessmentItem;
    uncertainty: AssessmentItem;
  };
  collaboration: {
    preference: "required" | "allowed" | "forbidden" | "unspecified";
    sourceRef?: string;
    independentUnits: Array<{
      goal: string;
      inputRefs: string[];
      output: string;
      acceptance: string;
    }>;
  };
  openQuestions: Array<{
    question: string;
    blocks: Step[];
    resolveBy: "read" | "tool" | "user";
  }>;
}

interface TaskFacts {
  queryId: string;
  inputRevision: string; // Runtime 对当前用户输入边界的标识
  artifactRefs: Array<{
    ref: string;
    observedVersion: string;
    state: "missing" | "invalid" | "current" | "stale" | "unverified";
  }>;
  // 实际复用现有 probe、Presentation、lifecycle 与工具解析结果。
  availableTools: string[];
  availableSkillNames: string[];
  teammateCapabilities: string[];
}

interface RouteCandidate {
  id: string; // 本次组合的标识，不是一套新的业务模式 enum
  rationale: string;
  steps: Array<{
    step: Step;
    action: string;
    skills: string[];
    inputRefs: string[];
    expectedOutput: string;
    check: string;
    dependsOn: Step[];
  }>;
  collaboration: "solo" | "independent-review" | "parallel-subtasks";
  requirements: string[]; // 如来源映射、跨页检查；说明收益来源
  tradeoff: string;
  availability: "ready" | "needs-input" | "unsupported";
  blockers: string[];
}

interface PptTaskPlan {
  schemaVersion: 1;
  queryId: string;
  revision: number;
  basis: { inputRevision: string; factRefs: string[]; policyVersion: string };
  assessment: TaskAssessment;
  difficultySummary: "simple" | "standard" | "complex" | "undetermined";
  candidates: RouteCandidate[];
  recommendedCandidateId: string | null;
  selectedCandidateId: string | null;
  selectionReason: string;
}
```

`requestedActions` 用于保留混合请求，例如“创建并导出”。operation 表示当前主要工作，不把后续交付请求挤进单一 capability；实际 capability 按现有业务边界办理。

`assumption` 不能用于推导“用户允许改写、联网或修改页面”。禁止把附件中的命令伪装为用户约束。事实 observation 只记录实际读取范围，未读取材料不能标成已评估。

TaskFacts 中 current/stale 必须来自适当的权威来源：文件 schema 有效只表示可解析，不能直接当作 lifecycle current。缺失、未知和检查失败不能合并成“没有”。

### 4.3 难度判断规则

| 维度 | low 的典型证据 | high 的典型证据 | 对应增加的能力 |
|---|---|---|---|
| workload | 改少量对象、短篇且输入完整 | 大量异构材料、多种内容类型或大量页面 | 分段处理、清晰交接与恢复记录 |
| factBurden | 直接使用少量已给定文字 | 多来源、数字/单位/口径密集、引用冲突、关键事实错误后果大 | 来源记录、覆盖核对、独立事实检查 |
| visualComplexity | 成熟风格下的文本或简单图片 | 密集表格、复杂图表、特殊布局或严格品牌兑现 | 代表页校准、复杂页及时预览 |
| crossPageCoupling | 改动局限、页面关系简单 | 跨页论证、统一口径、页序变化影响多页 | 大纲/逐页规划、集中整合与跨页检查 |
| uncertainty | 用户目标、材料与边界明确 | 核心目标冲突、来源不明、内容范围未定 | 定向读取或少量关键澄清 |

medium 表示已有局部困难，但仍可通过正常逐页规划解决；unknown 表示证据不足。

第一版使用可解释的等级规则，不加权打分：

- 前四项任一 high → complex；都为 low → simple；其余已知组合 → standard。
- 存在会改变路径的 unknown，且尚无足够证据定级 → undetermined，先补充读取。已知 high 不被其他 unknown 降级。
- uncertainty 独立决定哪些步骤暂不能开始，不把“需求模糊”直接等同于“需要研究 + 分镜 + 多 Agent”。
- 等级只用于摘要；具体能力由各维度触发。两份 complex 任务可以得到完全不同的组合。
- 页数是 workload 的证据之一，不是单独阈值。不得把所有短篇标为 simple。
- 用户要求“快一点”减少额外方案与重复工作，不授权省略事实核对或当前版本检查。

## 5. 如何由模型决定流程

### 5.1 决策过程

1. **读取足够事实。** Runtime 提供轻量 probe 和当前页面信息；主模型按需要读取材料。无需为了判断难度先读完整项目，也不能未看材料就认定简单。
2. **评估意图与难度。** 主模型提交 TaskAssessment。来源缺失或不确定的项显式保留，不假装已经得到用户确认。
3. **确定交付终点。** answer/content/review/export 不强行穿过完整 SVG 创建路径。
4. **复用已有产物。** current 且适用的约定直接使用；stale/invalid 只修复相关依赖，不整套重启。
5. **组合所需能力。** 按维度加入研究、规划、代表页检查、事实覆盖等措施，删除没有新增价值的重复步骤。
6. **叠加协作选择。** 根据用户偏好、可拆分性、工具支持生成单 Agent 或协作变体。
7. **提供少量候选。** 最多三条有实际差异的有效路径；只有一条合适时不凑数。每条说明适用原因、输入、产物、检查与代价。
8. **选择并执行。** 默认推荐最小充分路径，主模型可以选择另一条有效候选；说明新增价值即可，不要求用户批准内部路径。
9. **用新事实修订。** 目标变化、事实冲突、依赖过期、持续渲染失败等触发重评；普通工具成功不触发一次重新规划。

组合器负责稳定规则和结构校验，不用关键词正则替代主模型的语义理解。模型提出规则未覆盖的需要时，可以更新 assessment 或独立子任务，重新组合；不要求另造一种模式。

组合顺序固定为：**真实工具/权限边界与用户约束 → 交付终点 → 当前依赖缺口 → 难度措施 → 协作变体 → 去重与推荐**。后面的规则不能覆盖前面的限制。候选不能因为步骤少而漏掉前置依赖；unsupported 仅用于解释不能提供的组合，不可成为推荐或当前执行路径。needs-input 路径可以先执行不依赖缺失输入的部分。

规则输出的具体例子：factBurden=high 添加“来源记录 + 页面覆盖检查”，而不是笼统添加全部上游 Skill；crossPageCoupling=high 且结构缺失才添加 outline；visualComplexity=high 添加复杂页早期预览；collaboration=required 添加实际可执行的协作变体。多个条件命中时合并措施，不重复写同一份产物。

### 5.2 五步骨架如何伸缩

| 骨架步骤 | 最小充分执行 | 按难度增加 | 复用或停止条件 |
|---|---|---|---|
| 理解需求与约束 | 确定目标、范围、交付终点并评估 | 定向读取、事实整理、关键澄清 | 问答到回答完成；核心问题只阻断依赖它的工作 |
| 记录内容和视觉约定 | 创建时填写当前契约；编辑时读取相关约定 | 大纲、证据映射；必要时分镜探索 | 只要内容在此交付；已有约定不重复设计 |
| 生成 SVG | 直接生成/修改目标源 | 分批、代表页校准、独立素材工作 | 审查或导出没有作者步骤 |
| 真实渲染并检查 | 修改页渲染与内容/视觉检查 | 事实覆盖、复杂页、独立审查和跨页核对 | 不变页面是否可复用由真实依赖与凭据决定 |
| 提交与应用 | 同源提交，遵循现有审批 | 没有“高级模式”可绕过边界 | 报告提交、Proposal ready、applied、export 分开报告 |

步骤允许依赖驱动的回返，例如视觉检查发现内容过密，回到页面规划后重绘。不存在“进入 author 后禁止读研究材料”的限制。

现行 create Skill 的 P01 先行闸门仍是第一步接入时的约束。规则归一阶段再将其调整为“先校准代表页”；复杂页可作为代表页或追加样本。该调整属于明确的目标行为变更，不能仅改变推荐文案后假定已经生效。无论选择哪个样本，最终当前版本的预览凭据要求不变。

### 5.3 代表性路径组合

这些是组合示例，不是互斥的全局模式。

| 场景 | Skill 组合 | 计划与检查重点 | 协作 |
|---|---|---|---|
| 需求完整的短篇新建 | workflow + design + design-layout + build | 合法且简洁的两个锁文件；真实预览 | 通常 solo |
| 长篇且结构困难 | 上述 + outline；逐页叙事不稳定才加 storyboard | 章节推进、覆盖与跨页一致性 | 独立检查可委派 |
| 多来源事实密集 | 创建组合 + research + review；必要时 outline | 来源与数据口径、逐页覆盖、未决冲突 | 有独立主题时研究并行 |
| 单页文案修改 | edit | 目标源、原文要求、换行与预览；必要时同步计划 | 用户指定时增加独立核对 |
| 全套换肤 | beautify；改变整体约定时增加 design；必要时 review | 内容保留、代表页与跨页风格一致性 | Lead 整合；可独立核对 |
| 只要大纲 | outline；需求不明时 brief；材料需整理时 research | 请求的内容文件，不生成 SVG | 按材料独立性决定 |
| 只审查不修改 | review | 当前源与已应用版本的区别，输出 findings/QualityReport | 可分工核对，Lead 汇总报告 |
| 已完成 deck 导出 | export；审查证据缺失或过期时 review | 当前权威版本与 UI 导出事实 | 通常 solo |

对于同一份多来源材料，可以提供“主 Agent 完成研究和创作”与“独立研究并行、主 Agent 统一规划创作”两条候选。两者的事实保真要求相同，差异是执行分工，不是交付质量档次。

### 5.4 按需加载与推荐

推荐分三组：

- **现在需要**：当前已满足输入条件、下一步要使用的 Skill。
- **本路径稍后需要**：记录名字和用途，尚不加载正文。
- **其他可用**：继续保留完整目录，允许模型按新证据加载。

同一 Skill 命中多个能力时去重。已在有效上下文中持有正文时不重复加载；SkillSession 的 loaded 标记不应被误认为压缩后正文仍完整可见。现有上下文系统决定是否需要重新提供正文。

不通过难度隐藏或禁用 Skill。`stages` 不再与任务路径各自独立给出一套“当前推荐”；迁移后保留为产物提示或兼容读取信息，推荐权威统一为候选路径。

模型实际接收的动态摘要应保持简短，例如：

```text
意图：新增两页案例，保留现有风格；交付 deck。
事实：design-spec 当前有效；目标页面与源已定位；案例资料已读取。
难度：standard；事实负担中，跨页耦合低；无阻断问题。
推荐：复用设计 → 更新逐页计划 → 写新页 → 按真实依赖预览 → 提交。
现在需要：ppt-edit、ppt-design-layout；随后按需加载：ppt-build。
协作：用户未要求，当前无值得独立委派的工作，solo。
注意：计划版本变化后核对 stale 依赖，不能只按 SVG 是否变化判断复用。
```

完整评估和候选保存在查询状态中，不每轮向 Prompt 重复输出全部 JSON，也不让用户必须选择内部路径。

## 6. 多 Agent 组合规则

### 6.1 用户偏好与拆分条件

| 用户表达 | 处理 |
|---|---|
| “用多个 Agent 完成” | required；即使简单，也寻找最小真实分工，例如主 Agent 修改、一个 teammate 核对 |
| “可以多 Agent / 必要时并行” | allowed；只有存在独立工作且收益合理才启用 |
| “不要多 Agent” | forbidden；不因 complex 自动覆盖 |
| 未提及 | unspecified；按项目允许的自主委派规则和实际收益判断 |

难度高但任务强耦合时，默认集中设计；不能为了并行把同一页或同一锁文件交给多个作者。

明确要求多个 Agent 而没有可执行工具或有硬权限限制时：说明不能满足的部分，不静默改成 solo 并声称满足要求；先完成独立且已授权的读取，必要时询问是否接受替代方式。时间经过不能当作同意。

Skill 中的建议性禁止委派应在实现时改为条件性指导；真实工具与权限限制仍不可被用户意图评估字段覆盖。

### 6.2 第一版允许的协作范围

- 独立材料整理、事实核对、内容结构建议，以及在实际工具支持下的审查。
- Lead 持有 design-spec/page-plan 的最终写入权，负责页面 SVG 作者工作、整合、Preview 和 Submit。
- 本提案第一版不直接开放分布式页面作者流程。用户确实要求分头写页时，需先补齐页面所有权、共享约定版本、teammate 工具和验收能力；未具备前将该候选标记 unsupported，不能谎称已经支持。
- 独立视觉审查需要 teammate 能取得真实渲染图；只有源码读取能力时，只能称源码/事实核对。

### 6.3 委派最小契约

复用 TaskStore / assignment，不新增另一套子任务系统。每项委派必须包含：目标、输入引用及版本、写入范围、交付文件或结果、验收条件和已知约束。

交付必须区分已核实结论、来源、未解决问题；Lead 读取实际结果后验收，不能只接受“已完成”的消息。共享输入变更后，检查受影响结果；不依靠各 Agent 记忆保持一致。

在简单任务中，一个真实的独立检查足够；不建立空角色或重复创作来满足人数形式。

## 7. 事实保真与文件使用

### 7.1 文件由什么需求触发

| 文件/记录 | 使用条件 | 内容边界 |
|---|---|---|
| design-spec | 当前作者链要求；新建建立，修改按影响范围复用或更新 | deck-wide 约定，避免与 brief 重复维护同一事实 |
| page-plan | 当前作者链要求；结构变更同步 | 最终逐页内容与意图；复杂任务增加来源映射 |
| brief | 存在需要长期保留的需求澄清结果 | 用户目标、硬约束、明确假设 |
| outline | 跨页/跨章结构需要单独规划 | 论证关系，不复制全部最终文案 |
| storyboard | page-plan 之前确实存在逐页探索问题 | 草案；进入最终计划后不维护第二套最终内容 |
| research/notes.md | 多来源事实、数字口径、资料整理或调研 | 来源、事实、冲突与未决问题 |
| Task assignment / result | 发生真实委派 | 输入版本、交付与验收，引用事实文件而不是复制全集 |

第一版不新增强制 facts.json、strategy.json 或每任务目录。任务模型保存在 Query checkpoint，事实记录复用已有文件。以后是否收缩锁文件 schema，应由具体路径评估支持，作为独立契约变更实施。

### 7.2 高事实负担路径的闭环

```text
材料及来源位置
  → facts：关键事实、数值、单位、时间口径、来源、待核实状态
  → page-plan：对应页面和 evidenceRefs
  → SVG：可见内容
  → 检查：必含事实覆盖、数值口径一致、无无来源新增结论
```

仅记录影响结论或用户明确要求保留的事实，不逐字登记所有句子。因范围排除的事实记录原因，不要求把所有材料塞进 PPT。

事实冲突未解决时，不选一个数字填入最终页面。可以继续独立的视觉或结构工作；影响交付结论的缺口保持未完成。用 brief/page-plan 的长篇复述替代来源定位不能算完成保真工作。

机器检查与模型检查分开：哈希、schema、资源、页面集合可由代码确定；文案语义、图表含义、视觉层级仍需实际内容和图像检查。不得把字符串相等当成完整内容验收。

## 8. 状态更新、恢复与运行时接入

### 8.1 状态归属

`PptTaskPlan` 放入现有 AgentQueryState，并随现有完整工具批次提交到 checkpoint。不在 PptJob 添加第二个任务执行状态机，不新建业务完成标记，也不把可编辑 workspace JSON 当作权限来源。

TaskFacts 每次需要时从现有 probe/lifecycle/tool resolution 派生；计划仅保存决策依据引用和版本。Prompt 是它们的只读投影。路径步骤不保存另一套 done/running 状态：实际完成读取 artifacts、工具结果和 TaskStore。

跨 Query：旧计划只作为参考，新的用户请求重新判断意图与影响范围；同一 waiting-user Query 恢复：恢复已提交评估，加入用户答复并重新核对相关事实。不得把上次“大型创建”难度带入本次“改一个字”。

### 8.2 最小工具接入建议

新增一个查询级工具 `SetPptTaskAssessment`（提案名称）：

- 输入 TaskAssessment 和可选的候选选择意向；Runtime 绑定当前 Query、输入版本和事实依据。
- 输出经组合的 PptTaskPlan、当前推荐 Skill 及阻断原因。
- 工具不会创建 PptJob、授予权限、spawn Agent 或写作者文件。
- 初次登记采用默认推荐路径，无需再增加一次“确认计划”调用；改选已有有效候选可用同一工具完成。
- assessment 更新先进入本轮待提交状态，完整工具批次结束后由 Query reducer 提交。恢复时不重复派发副作用。
- 与独立读取可同批，但 assessment 若依赖该读取的结果，必须等结果返回；不能评估尚未看到的材料。

首次实质 PPT 创作/修改前形成评估；普通问答不强制工具仪式。最小任务的评估也可以非常短。第一版不增加一次独立 LLM 分类请求，不强制先加载新的路由 Skill。

`BeginPptCapability` 继续只负责真实业务声明。它的返回指引消费已选路径，不再无条件附加全套固定作者顺序。尚未形成评估时可提供简短评估提示；不能用分类工具替代 capability。

### 8.3 重新评估条件

| 触发 | 需要调整 | 不应做什么 |
|---|---|---|
| 新用户指令改变目标/范围/协作要求 | 更新 intent、受影响维度与候选 | 继承过期授权或无条件重启全部工作 |
| 材料出现事实冲突 | 增加来源核对与相关问题 | 仅提高 difficulty 标签而不改工作 |
| 锁或素材版本变化 | 读取真实 stale 依赖，调整复用与检查 | 只看 SVG 字节未变就复用全部凭据 |
| 新发现复杂图表或系统性渲染问题 | 增加代表页/专项检查 | 每次小修复都重新完整分类 |
| teammate 工具不可用或交付失败 | 重组可完成的分工；required 偏好显式处理 | 把未验收结果当作完成 |
| 上下文压缩或恢复 | 恢复评估并核对依据和所需材料 | 因摘要存在就假定所有事实仍在上下文 |

没有新证据不反复改变路径。已经完成且仍有效的工作保留，切换路径只补差额。切换不能自动扩展用户允许的页面范围或改写权限。

### 8.4 必须同步调整的现有落点

| 位置 | 目标改动 |
|---|---|
| `runtime/query/query-types.ts` 与 checkpoint snapshot | 保存评估和路径；通过现有批次提交与恢复 |
| `runtime/prompts/prompt-context.ts` | 注入计划投影及当前事实；缓存 key 包含模型可见计划与依据变化 |
| `runtime/prompts/skill-stage-policy.ts` / `prompt-sections.ts` | 路径驱动推荐；保留完整目录，去除相互冲突的固定顺序 |
| `tools/core/begin-ppt-capability.ts` | 按路径返回简短指引，保留业务声明语义 |
| `tools/core/svg-deck-locks.ts` | 保留当前校验；错误恢复提示按缺口恢复，不无条件要求整套重走 |
| 核心四个 Skill | 区分共同契约与可调整执行建议；清除重复路径决策 |
| `ppt-research` / `ppt-build` | 同步协作边界；第一版开放独立辅助工作，Lead 保持作者整合 |
| `ppt-review` / `ppt-export` 与 capability 边界 | 先解决 review 修复/提交矛盾；导出保持 UI 事实，不能让只读交付隐式进入改稿 |

不在本提案中改变 review capability 的权限。落地时先将不可执行组合排除，明确只审查路径；“审查并修复”的现有正文与 capability 转换需单独对齐后再启用，不能为了路线完整直接放宽 ACL。

## 9. 决策样例

### A. “把第 3 页标题改为‘增长恢复’，用多 Agent”

- intent：edit / deck / local；协作 required。
- facts：读取稳定 slide id、SVG 源和相关约定，避免按页码猜文件。
- difficulty：工作量、耦合低；检查原布局后确认视觉难度。
- 路径：ppt-edit；Lead 修改，一个 teammate 核对文字与范围，Lead 查看真实预览后提交。
- 不加载 brief/outline/storyboard；不重新选择模板；不能因任务简单忽略 required。

### B. “用这些报告做 24 页董事会材料，数字不要丢”

- factBurden 与 crossPageCoupling 高；先读报告结构和关键数据，再确定 workload。
- 路径：research → outline（结构未定时）→ design → design-layout → build → review。
- 关键事实记录来源和口径，计划中映射 evidenceRefs，检查 SVG 兑现。
- 有独立主题才产生并行研究候选；Lead 统一口径。storyboard 仅在逐页叙事仍需探索时加入。

### C. “做 3 页，但包含一张密集财务比较表”

- 页数少不等于 simple；factBurden、visualComplexity 可以高。
- 增加数值/单位核对和复杂表格页早期预览；不因短篇放弃事实保真。
- 无须为了 complex 强行增加大纲或多 Agent。

### D. “沿用现有风格，再加两页案例”

- 复用有效 design-spec，更新受影响 page-plan，生成新页。
- 计划变更后由 lifecycle 确定受影响凭据，不承诺只预览新增两页就一定能提交。
- 选择局部编辑与必要的逐页规划能力，不重新启动完整设计。

### E. “只列出问题，不要修改”

- intent：review / review-report；只读约束明确。
- 路径：读取当前源与真实渲染 → findings → SubmitPptReview。
- 即使发现明显错误也不写 SVG；难度不改变修改授权。

### F. “继续刚才的任务” / “现在只导出”

- 前者基于未完成目标与 durable facts 找最早必要缺口；不机械执行旧路径的第一步。
- 后者把交付终点切换为导出，检查当前已应用版本与证据；存在未提交修改时说明状态，不声称已经导出。
- 两者都不能只根据“workspace 有 page-svg”推荐 edit。

### G. “随便做个方案，我还没想好给谁看”

- uncertainty 高，其余维度可以 unknown。
- 如果受众会改变核心内容，先问一个关键问题；同时可整理用户已提供材料。
- 不因目标模糊自动启动外部研究、多 Agent 或长篇锁文件填写。

## 10. 实施顺序与验收

### 10.1 分步落地

1. **模型与推荐接入**：实现 TaskAssessment、事实引用、候选组合、Query 持久化和 Prompt 投影；现有作者锁和提交不变量不变。新建短路径仍填写现有必需字段，只减少额外文件与重复规划。
2. **规则归一与协作接入**：移除 Prompt/Skill/工具反馈中的冲突路径规则；实现辅助子任务交接，显式处理用户多 Agent 要求；对齐 review 边界。评估与正文同步完成后才能将对应候选标 ready。
3. **基于证据精简契约**：使用实际运行结果判断是否值得减少重复字段、重复提交参数或调整依赖粒度。此项是后续独立变更，不作为新模型生效的前提。

不一次性增加新工作流引擎、通用规则 DSL、多个分类 Agent、复杂评分器或新数据库表。候选组合先使用小型、可测试的规则函数。

### 10.2 规则与恢复验收

| 验收场景 | 预期 |
|---|---|
| workspace 相同，用户分别要求编辑/审查/导出 | 路径随意图改变，而非仅按事实推荐同一组 Skill |
| 一样是 complex，一份事实密集、一份视觉复杂 | 分别增加事实与视觉措施，不加载相同全套步骤 |
| simple + required multi | 至少一个真实、可验收的辅助分工；工具不可用时显式报告 |
| complex + forbidden multi | 有完整单 Agent 路径，不偷偷委派 |
| 可直接写最终计划 | 不额外要求 storyboard |
| 输入不足 | unknown 保留、读取/澄清定向，不能默认低难度 |
| 用户只要大纲/报告 | 在对应交付终点结束，不创建或修改 SVG |
| 共享锁变化而 SVG 未变 | 尊重实际 stale 依赖，不跳过必要重新验证 |
| 同 Query 恢复/新 Query 小改 | 前者恢复评估并复核；后者重新评估，不继承旧难度 |
| 计划改变但 Skill 名称相同 | Prompt cache 正确失效，模型看到新约束和检查要求 |
| 非选中 Skill 后续变得必要 | 可以按需加载，不因路径限制被拒绝 |
| 路径显示结束但 Proposal 尚未应用 | 不把计划进度当作 Presentation applied |

实施时先对组合函数和恢复边界做窄测试，再运行 `npm.cmd run typecheck`、`npm.cmd test`。涉及真实 gateway、并行或导出时，用已有集成入口及手工导出验证；没有运行条件则明确记录缺口。

### 10.3 效果验证

选择短篇新建、局部编辑、事实密集、复杂视觉、明确多 Agent、恢复继续等代表任务，对比当前流程与新模型。同一批输入、模型和工具条件下记录：

- 交付是否满足请求，遗漏或新增无依据事实的数量；
- 视觉问题、渲染失败、重新提交与人工修复情况；
- Skill 加载、额外规划文件、模型轮次、耗时与 token；
- 多 Agent 交接遗漏、冲突、重复工作及实际并行收益。

固定输入的规则测试只能证明组合符合预期，不能证明成品质量。先确认质量和用户约束不退步，再评价成本收益；不预先宣称某条短路径更快或同样好。

## 11. 依据与关联文档

- [当前 Presentation 工作流](../presentation/workflow.md)
- [System Prompt 与 Context](../agent/system-context.md)
- [Multi-Agent](../agent/multi-agent.md)
- [Presentation 生命周期](./presentation-lifecycle.md)
- [模板管理提案](./template-management.md)：本提案不改变模板选择优先级或品牌契约。
- [事实阶段推断](../../src/main/plugins/ppt/prompts/prompt-stage.ts)
- [当前 Skill 排序](../../src/main/plugins/ppt/prompts/skill-stage-policy.ts)
- [Skill 类型与加载层次](../../src/main/agent/skills/skill-types.ts)
- [Query 状态](../../src/main/agent/runtime/query/query-types.ts)
- [业务声明入口](../../src/main/plugins/ppt/tools/begin-ppt-capability.ts)
- [锁文件契约](../../src/main/plugins/ppt/tools/svg-deck-locks.ts)
- [页面与预览依赖](../../src/main/plugins/ppt/tools/svg-deck-lifecycle.ts)
- [预览工具](../../src/main/plugins/ppt/tools/preview-svg-page.ts)
- [提交工具](../../src/main/plugins/ppt/tools/submit-svg-deck.ts)
- [核心 workflow Skill](../../skills/ppt-workflow/SKILL.md)
- [build 协作边界](../../skills/ppt-build/SKILL.md)
- [research 协作边界](../../skills/ppt-research/SKILL.md)
- [review 当前约定](../../skills/ppt-review/SKILL.md)
- [export 当前约定](../../skills/ppt-export/SKILL.md)

## 12. 步骤内部如何落地：数据处理与质量反馈

本节是 2026-09-20 的实施设计。第 2 节记录原始提案的基线；以下区分当前已存在的接入与待开发行为。代码存在不等于生成质量已经通过实测。

### 12.1 当前落点与真正缺口

| 当前代码 | 已有能力 | 本轮设计需要补充什么 |
|---|---|---|
| `runtime/ppt-task/ppt-task-schema.ts` | 意图、五项难度、协作偏好与未决问题 | 保存必要的目标范围与判断依据，避免只剩等级标签 |
| `runtime/ppt-task/ppt-task-composer.ts` | 根据评估与事实生成候选，输出 now/later Skill | 输出具体工作措施及适用范围，不只推荐名称 |
| `runtime/ppt-task/ppt-task-types.ts` | `Route` / `PptTaskPlan` | 当前 Route 没有逐项质量措施；Plan 没有保存原始 assessment |
| `tools/core/load-skill.ts` | 返回正文与当前路径的推荐级别 | 附带与此 Skill 相关的工作措施；正文提供实际处理方法 |
| `skills/ppt-research/SKILL.md` | 来源笔记、待核实信息、条件性委派 | 事实身份、口径、来源位置、冲突处理与下游引用 |
| `skills/ppt-design-layout/SKILL.md` | finalCopy、意图与可选 evidenceRefs | 明确证据如何支持文案，以及如何回查遗漏 |
| `tools/core/preview-svg-page.ts` | 当前 SVG 的真实渲染凭据 | 继续与内容/视觉判断分开，不能把 PNG 成功当作审查通过 |
| `task/task-store.ts`、`tools/core/task-tools.ts` | 委派、依赖、review_required、Lead 验收 | 约定输入版本、交付范围和验收证据，无需新建任务系统 |
| `tools/core/submit-ppt-review.ts` | 针对已应用 PresentationRevision 的报告 | 不能冒用来审查尚未提交的工作区草稿；维持 review capability 边界 |

第一步只扩展这些现有接入点。不增加一个单独规划模型，不让 Runtime 自动执行步骤列表，也不增加每一步都必须调用的登记工具。

### 12.2 推荐结果增加措施，并保留评估依据

在现有 Route 上增加 `measures`，用少量有实际消费者的标识表达要增加的工作：

```ts
type WorkMeasure =
  | "source-traceability"
  | "cross-page-consistency"
  | "representative-preview"
  | "independent-check";

// 以下是目标增量示意；复用现有类型，不另建平行的 Plan。
interface RouteMeasure {
  kind: WorkMeasure;
  reason: string;
}
// Route.measures: RouteMeasure[]
// PptTaskPlan.assessment: TaskAssessment
```

同时在 TaskAssessment 中增加可选的目标 slide id 与简短依据引用。范围尚未定位时保持未知，不能把空数组解释成全套。引用实际用户消息、已读取路径及观察到的版本；Runtime 验证可解析的来源并生成版本信息，不接受模型伪造的 verified 标记。已有权限与文件写入边界仍是唯一授权依据。

组合规则：

- factBurden 高：增加 source-traceability。需要补足事实时 research 放到作者工作之前；材料已完整时只整理和检查，不自动联网。
- coupling 高：增加 cross-page-consistency；结构缺失才推荐 outline，不无条件增加 storyboard。
- visual 高：增加 representative-preview，明确优先检查密集表格、复杂图表等风险页面。
- 选中的协作路径：增加 independent-check；委派目标必须说明独立核对什么。
- 简单修改：措施可以为空，仍执行 edit 自带的基本事实核对、当前版本预览及提交要求。
- 多条件命中时去重。每个措施都要能指向具体动作和证据，不增加没有消费者的评分字段。

`formatPptTaskPlanProjection` 输出简短措施；`LoadSkill` 只投影与当前 Skill 相关的措施。固定处理知识放在 Skill，动态范围和材料来自当前任务，不能在 Prompt、工具返回和 Skill 三处复制完整流程。措施到 Skill 的映射集中维护在 ppt-task 模块中的小表，不引入可配置规则语言。

恢复时保存 assessment 与措施的 checkpoint 快照，并更新现有 Prompt cache key。新 Query 重新判断本次目标；同 Query 恢复先复核输入与相关版本。措施既不是权限，也不是另一套步骤完成状态。

### 12.3 每个 Skill 补齐一份可执行的方法

改动现有正文，不给每个 Skill 再创建一套强制机器 schema。统一说明六件事：适用条件、输入、处理方法、结果、检查、失败后的处理。基础方法保持短，复杂情况再增加内容。

| Skill | 核心处理方法 | 下游实际使用的结果 | 有效的质量证据 |
|---|---|---|---|
| research | 提取原始事实；保留单位/期间/口径；区分来源、推断和假设；显式记录冲突 | 可定位的事实与待核实项 | 对照原始来源的摘录或定位；计算有输入与方法 |
| outline | 按受众问题组织结论和证据；检查跨页推进；尊重用户固定顺序 | 必要时的章节与页面职责 | 请求的核心问题有对应内容，无重复或无依据跳跃 |
| design | 识别明确品牌要求；选择适合内容的视觉表达；说明重要取舍 | 一套可执行视觉约定 | 明确约束得到兑现；风险页能够验证字号、图表和密度 |
| design-layout | 从问题选择证据，再形成标题与正文；保留限定条件；建立页面证据引用 | finalCopy、页面职责、evidenceRefs | 每个关键结论有支持，必含事实有去向 |
| build / edit | 根据内容关系构图；事实不因排版被删改；容量不足先调整规划 | 完整 SVG 与当前版本预览 | 文字/数据核对与实际渲染检查分别完成 |
| review | 对照用户要求、来源、计划和渲染检查；给出可复现的问题位置 | 问题、依据、影响范围、修正建议 | 每个问题能回到具体源或页面；未检查项明确保留 |

示例应解释选择理由。例如“同维度比较应保持对齐”比“禁止三卡片”更可迁移。每个复杂主题只增加有代表性的正例、反例与修复方法，不把整个设计知识库注入每次请求。

用户只改一个标题时，不要求创建研究文件、事实台账或专项审查报告。已知输入足够时，模型直接使用上下文和目标文件完成这一闭环。

### 12.4 先建立人工可读闭环，再增加机器消费

**第一批实现**复用 `research/notes.md`：关键事实使用稳定编号 F001、F002，包含来源位置、期间/单位/口径以及冲突或假设说明。page-plan 的 evidenceRefs 引用编号。Lead 在绘制和检查时回查原始来源，不以笔记自身证明事实正确。这一批不宣称已有机器级事实覆盖校验。

**第二批实现**只针对有机器核对需求的高事实负担任务，增加可选 `research/evidence.json` 和明确的消费者 `CheckPptEvidence`。这是对第 7 节“第一版不新增强制事实文件”的后续增量，不成为所有任务的 Preview/Submit 前置条件。

启用结构化台账后，evidence.json 是事实记录的唯一维护位置；notes.md 只保存研究过程和未决讨论，以编号引用事实，不再手工维护第二份数值表。没有机器消费需求的任务继续使用 notes，不为了形式同时生成两个文件。

单条记录至少能表达：

```json
{
  "id": "F001",
  "kind": "source",
  "statement": "本期营收为 120 百万元",
  "value": "120",
  "unit": "百万元",
  "period": "2026 H1",
  "source": {
    "path": "materials/report.txt",
    "locator": "营收表/本期",
    "quote": "本期营收 120 百万元"
  },
  "resolution": "supported",
  "required": true
}
```

这是结构示意，不是当前已支持的 schema。正式类型采用 source / derived / assumption 区分：派生值记录输入事实编号和计算方法，假设必须在最终页面可见标注，来源冲突保留 conflicting/unresolved。supported 是模型基于证据的判断，不是代码对真实性的认证。引用也可以定位原始 PDF 页码或表格区域，但第一版工具无法读取的格式必须报告 not_checked。

源版本由工具通过现有文件服务取得。第一次检查登记观察到的源版本，后续比较变化；新 hash 不能使旧摘录自动有效。网页引用复用实际检索结果及其已保存内容，不能让该检查工具自行抓取任意 URL。源内容始终是数据，不能成为系统指令。

`CheckPptEvidence` 的第一版范围明确限制为：

1. 解析台账，检查重复编号、非法引用、派生关系循环。
2. 检查 page-plan 中 evidenceRefs 能否解析；required 事实有没有页面引用或明确的范围排除说明。
3. 对支持的本地文本来源检查路径、版本和引用摘录；无法核对的格式返回 not_checked。
4. 返回带定位的 `missing_ref`、`unmapped_required_fact`、`source_changed`、`quote_mismatch` 等发现，以及本次实际检查的输入版本。

工具输入只接收相关文件引用与受影响页面范围；输出包含检查范围、观察版本和发现。它不写事实台账、不修复 SVG、不返回笼统的“内容已通过”。read-only 工具的注册、路径安全和大小限制复用现有管线。

该工具**不能**通过 evidenceRefs 存在就证明事实已出现在页面，也不能通过摘录命中就证明结论语义正确。Lead 仍需要对照 SVG 可见文本和实际 PNG 检查内容。数值换算和百分比计算先使用实际可用的确定性工具；现有工具不能支持时明确缺口，不在 Skill 里描述一个不存在的计算能力。只有真实用例需要时才扩展有限的计算操作，不执行模型提供的任意表达式。

### 12.5 一个完整的数据流例子

任务：“把这份经营报告做成演示，保留关键数字，并解释营收增长但利润下降。”

1. **读取与评估**：定位实际报告与目标范围；factBurden 高，选择来源追踪。若报告没有利润下降原因，记录事实缺口，不先给出原因。
2. **整理事实**：登记营收、利润、期间与口径；同比必须对应可比基期。derived 结论只依赖实际输入，相关性不自动变成因果解释。
3. **组织内容**：page-plan 引用 F001 等证据，标题可以写“营收增长，利润承压”；只有证据足够时才写“主要由某因素导致”。
4. **绘制与检查**：SVG 使用计划中的可见数值、单位和限定条件；Lead 看图确认并列比较是否清楚，检查图表与数据是否一致。
5. **修正**：若引用不存在，修计划；若口径冲突，回到来源；若文字拥挤，修版面，必要时同步计划；任何页面或依赖变化继续遵守现有重新预览要求。
6. **交付**：Submit/CommitGate 证明提案与版本；内容检查说明实际覆盖范围。未解决且影响核心结论的问题不能包装成已验证交付。

数据随依赖向下传递，问题沿相应依赖返回。发现一条错误无需重启全套流程，但不能跳过生命周期判定的其他失效证据。

### 12.6 多 Agent 的输入、交付与验收

第一版继续由 Lead 持有作者源与锁文件的最终写入/提交。子 Agent 负责独立摘录、事实核对、结构建议；具有实际图像访问能力时才承担视觉检查。

使用 TaskCreate 的 `description` 表达以下交接模板，必要的结构化引用放入已有 userMetadata，并在实际读取时按约定验证。不为简单单 Agent 任务创建 TaskStore 节点：

```text
目标：核对 P03 的营收和利润表述
输入：用户要求引用、原始材料位置及观察版本、P03 计划与 SVG 版本
范围：只核对 P03；不修改共享作者文件
交付：问题位置、对应来源、已检查范围、未检查项
验收：数字/期间/单位/限定条件已逐项对照；没有依据的因果结论须指出
```

TaskCreate 使用 `executionTarget=teammate`、`completionPolicy=review_required`。Lead 读取真实结果，核对其依据及版本，再走现有 TaskReviewApprove/Reject；状态 completed 不等于事实正确。权限由现有工具管线执行，description 中的只读约定不能冒充运行时 ACL。

源变化后，Lead 利用真实版本重新验收受影响部分；不凭“上次已通过”沿用。required + simple 使用一个有实际检查内容的子任务；禁止为满足人数创建空角色。用户只是 allowed 时，只有存在独立价值才委派。工具不可用时报告限制，不伪造协作结果。

### 12.7 检查结果和修复怎样保存

- 简单任务：工具结果和现有对话记录足够，不新增报告文件。
- 长任务或存在委派：在现有研究记录/任务交付中保留输入版本、检查范围、具体发现、未决问题。记录采用通过/发现问题/未检查的区分，未检查不能被摘要成通过。
- 已应用 deck 的正式审查：使用 SubmitPptReview 与当前 PresentationRevision 绑定。
- 创建/修改中的草稿自查：使用当前 capability 的读、写、预览能力，记录工作结果，不调用仅支持 review 的正式报告工具来制造中间完成状态。
- 修复后按受影响范围重查，同时尊重现有 lifecycle stale 传播。持续失败时改变处理方法或明确真实阻断，不重复同一动作；不增加固定三轮评审仪式，也不为质量问题直接扩展用户授权范围。

### 12.8 按三个可验收增量实施

| 增量 | 文件与模块 | 完成标准 |
|---|---|---|
| A：措施与方法闭环 | ppt-task types/schema/composer/session、现有 Query checkpoint 与 Prompt cache、LoadSkill；research/design-layout/build/edit/review 正文 | 事实密集与视觉复杂任务得到不同的实际方法；简单任务不增加文件；恢复保留依据；所有规则冲突已对齐 |
| B：事实证据可检查 | 可选 evidence schema、page-plan evidenceRefs 校验、只读 CheckPptEvidence 及注册、research/review 指引 | 找到悬空引用、必含事实未映射和来源变化；明确无法检查的内容，不把图像或语义检查冒充已通过 |
| C：独立验收与实测 | TaskStore 交接与 review_required 的使用约定、teammate prompt、相关任务与集成测试 | 子 Agent 交付可回查且版本有效；Lead 拒绝无证据的“完成”；实测质量与成本得到比较 |

A 必须同时解决现存冲突：事实补足不能一律排到 build 后；复杂页早预览与 Skill 中 P01/全量后预览规则需同步；按实际授权允许的辅助委派不能被另一处正文无条件禁止。只改推荐文案不算完成。设计轴是否从自动硬锁改为建议、提交参数去重、全套作者锁精简继续作为独立变更，不混入本增量。

先贯通“事实密集任务”的一条链，再扩展其他方法。固定验收样例包括：

| 样例 | 要证明的行为 |
|---|---|
| 改一页标题 | 无研究台账或多余规划；改动范围与当前版本预览正确 |
| 同为 complex：事实密集 / 视觉复杂 | 分别触发来源追踪 / 风险页预览，避免全套措施齐上 |
| 相互冲突的两份报告 | 冲突显式保留，页面没有未经解决的确定性结论 |
| 台账有事实，但 SVG 漏写单位 | 不能仅靠引用检查宣称通过，内容/视觉检查能指出遗漏 |
| 简单任务 + required multi | 存在真实核对结果及 Lead 验收，没有重复作者工作 |
| 子 Agent 交付后原始材料改变 | 旧检查不能沿用到新版本 |
| 只要审查报告 | 不修改 SVG，不把草稿检查与已应用 deck 审查混用 |
| 断点恢复 | 找回输入引用、措施和未决项，不把未检查事项变成通过 |

验证分两层：规则/工具/恢复测试证明确定性行为，真实生成用例评估事实遗漏、无依据结论、视觉问题、返工、轮次、token 与耗时。使用相同输入与模型条件，对受影响的代表场景重复运行，保留失败样本；质量不退步后再评价节省成本。第一版不承诺具体提效百分比。

每个代码增量运行窄测试、`npm.cmd run typecheck`、`npm.cmd test`；真实 gateway/多 Agent/导出验证按实际触及范围执行，缺少条件就明确记录，不以 mock 通过代替生成效果证据。
