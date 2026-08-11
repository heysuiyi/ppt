# Agent PPT 工程能力地图

> 文档类型：现行能力盘点
> 最后核对：2026-08-12
> 事实来源：`src/`、`skills/`、`tests/` 与 `package.json`

下文中 `src/...`、`tests/...` 和 `docs/...` 均相对本仓库根目录。

## 1. 文档目的

本文回答两个问题：

1. Agent PPT 需要哪些让 Agent 长期、可恢复、安全执行任务的工程能力；
2. 当前代码已经实现到哪里，哪些只是部分能力或路线图。

量化分域评分见 [系统能力评价](./capability-scorecard.md)（评价快照，非行为契约）。
端到端分层与 Layer 2 导出 golden 见 [端到端质量证据](./e2e-quality.md)。

这里的“工程能力”不是功能菜单，而是运行时机制。能力状态统一使用：

| 状态 | 含义 |
|---|---|
| **Implemented** | 当前代码已有明确实现，并有测试或可执行入口 |
| **Partial** | 主链路存在，但覆盖范围、协议或产品闭环尚未完整 |
| **Proposed** | 只存在于 `docs/roadmap/`，不能作为当前行为依赖 |
| **Not adopted** | 不属于当前 PPT 产品边界 |

状态描述的是 Agent PPT；目录存在不等于能力可用，必须以代码与验证入口为准。

## 2. Agent PPT 能力总表

| 能力域 | 当前状态 | Agent PPT 落点 |
|---|---|---|
| 独立 Query Loop | **Implemented** | `src/main/agent/runtime/query/query.ts`、`src/main/agent/runtime/query/query-types.ts` |
| Run 生命周期 | **Implemented** | `src/main/agent/runtime/agent-runtime.ts`、`src/main/agent/runtime/lifecycle/agent-run-scope.ts`、`src/main/agent/runtime/agent-run-finalizer.ts` |
| Provider Gateway | **Implemented** | `src/main/agent/gateway/`（统一调用源；对内 `chat` / `responses` / `anthropic`） |
| 本地凭据存储 | **Implemented** | `src/main/credential-store.ts`、`src/shared/credentials.ts`（Main-only `safeStorage`；Renderer 只见状态） |
| 模型调用恢复 | **Implemented** | `src/main/agent/runtime/turns/model-call-recovery.ts`、`src/main/agent/runtime/model/with-retry.ts` |
| Context 压缩 | **Implemented** | `src/main/agent/runtime/context-compact/` |
| System Prompt 分区 | **Implemented** | `src/main/agent/runtime/prompts/` |
| 动态工具系统 | **Implemented** | `src/main/agent/tools/tool-registry.ts`、`src/main/agent/tools/tool-loader.ts`、`src/main/agent/runtime/tools/` |
| 文件安全操作 | **Implemented** | `src/main/agent/tools/files/workspace-file-service.ts`、`src/main/agent/tools/core/workspace-files.ts` |
| 项目文件管理 | **Implemented** | `src/main/project/project-file-service.ts`、`src/shared/ipc.ts`、`src/renderer/src/components/ProjectFilesPage.tsx` |
| 权限与审批 | **Implemented** | `src/main/agent/runtime/tools/permission-check.ts`、`src/main/agent/runtime/tools/tool-approval-broker.ts`、`src/main/agent/gate/commit-gate.ts` |
| Skill 渐进加载 | **Implemented** | `src/main/agent/skills/loadSkillsDir.ts`、`src/main/agent/tools/core/load-skill.ts`、`skills/` |
| Task / teammate | **Implemented** | `src/main/agent/task/`、`src/main/agent/teammate/`、`src/main/agent/subagent/` |
| 后台任务 | **Partial** | `src/main/agent/runtime/background/` |
| 持久化与恢复 | **Implemented** | `src/main/agent/persistence/`、`src/main/agent/runtime/lifecycle/checkpoint-coordinator.ts` |
| Web / 图片检索 | **Implemented** | `src/main/agent/search/`、`src/main/agent/tools/core/web-search.ts`、`src/main/agent/tools/core/search-slide-images.ts` |
| SVG-native 创建 | **Implemented** | `skills/ppt-workflow/`、`preview-svg-page.ts`、`submit-svg-deck.ts` |
| Layout Grammar / element-IR | **Not adopted** | 作者工具与共享库已从仓库删除；产品 STRICT SVG-only。空 Deferred 壳（`SearchExtraTools` / `ExecuteExtraTool`）有意保留且不进默认注册表 |
| 渲染反馈与质量门 | **Implemented** | deck validators、quality gate、`PreviewSvgPage` 预览门禁 |
| Artifact / Job 生命周期 | **Implemented** | `src/shared/presentation-lifecycle.ts`、`src/main/presentation-lifecycle/` |
| MCP / Plugin / LSP | **Not adopted** | 无对应产品入口 |
| Daemon / Remote Control / ACP | **Not adopted** | 无对应产品入口 |
| 通用 Shell / Computer Use | **Partial** | teammate-only `src/main/agent/subagent/workspace-tools.ts` |

## 3. 核心 Agent 能力细节

### 3.1 Query、Run 与应用三层

当前主链路不是一个“大 AgentService”完成所有工作，而是三层：

```text
Renderer / IPC
  → AgentService                         应用用例与并发入口
  → PresentationAgentRunFactory         组装一次 Run 的依赖
  → AgentRuntime / AgentRunScope         lease、恢复、资源与终态
  → query() AsyncGenerator               model → tools → transition
  → ModelTurnRunner / ToolTurnRunner     单圈执行
```

关键不变量：

- `AgentQueryParams` 在 Query 开始时组装一次，不在循环中偷偷更换依赖；
- `AgentQueryState` 只保存完整提交的跨圈事实；
- `AgentIterationWorkspace` 保存本圈未提交的 assistant/tool 增量；
- `tool_use` 批次必须得到一一配对的 `tool_result` 后才能整体提交；
- UI 活动流是观察投影，不能反向成为 History 的事实源；
- Query terminal、Run terminal 与 Presentation artifact 状态是不同协议。

详见 [Query](../agent/query.md)、[Agent Loop](../agent/loop.md) 和
[Agent Runtime](../agent/runtime.md)。

### 3.2 Gateway 与内容协议

`AgentGateway` 是系统**统一模型调用源**（类比 OAuth2 Client）：所有打模型的请求都经
此出口，调用方只依赖中性协议，不直接接触 provider SDK，也不选择内部通路。

**对内协议面（barrel `src/main/agent/gateway`）：**

- 统一类型：`AgentModelRequest`、`AgentModelResponse`、`AgentModelStreamChunk`、
  `AgentModelContentBlock` 等；`stopReason` 已归一为 Gateway 枚举
  （`end` / `max_tokens` / `tool_use` / `other`），Runtime 不再接触 raw provider 字符串；
- 标准错误：`AgentGatewayError`（含 `retryAfterMs`、`code` 与 `provider`；用户中断为
  `aborted`）；raw provider/HTTP 错误只在 Gateway 内经 `normalizeProviderError` 吸入；
- 公共 helper：`textFromContentBlocks`、`toolUseBlocksFromContent`、
  `ensureToolResultPairing`、`isOutputTruncated`、`classifyGatewayRecovery` 等；
  其中 `classifyGatewayRecovery` 只接受 `AgentGatewayError`，裸 status/message
  一律视为不可恢复；
- 程序消费者应只从 barrel import，不应 deep-import 子模块。
- 退避延时、用户可读错误文案、主 agent 响应协议 guidance 在 Runtime / prompts /
  service；不属于 Gateway 合同。one-shot `callLLM` / `callTool` 包装已删除：
  调用方直接 `queryModel` / `queryModelStream`；compact 摘要在本地断言
  （非空 markdown、拒 tool_use、拒截断）。

**配置身份与路由：**

Gateway 的内存配置同时保留 provider 默认配置与 `configurationId` 精确配置。主模型
始终注册为对应 provider 的默认配置；带 ID 的主模型和 fallback 另按 ID 注册，未带 ID
的 fallback 则按 provider + model 注册，因此同 provider 的 fallback 不会覆盖主模型。
显式携带 `configurationId` 的选择必须命中同一 provider/model 的精确配置，否则以
`configuration` 错误 fail closed；未携带 ID 时依次查找 provider + model fallback、
provider 默认配置，最后才使用进程环境配置。

`AgentGatewayConfig` 只含模型网关运行参数（`timeoutMs` / `maxOutputTokens` /
`fallbackModel`）。搜索凭据在独立的 `AgentSearchConfig` 中；Renderer 的持久化设置和
Agent run IPC 只携带非敏感选择与搜索配置。Main 在配置 Gateway 和搜索服务前从
`CredentialStore` 注入凭据，再由 `splitAgentRunServicesConfig` 拆分运行配置。工具经
`ToolContext.searchConfig` 取凭据，不再从 `getGatewayConfig()` 读取 webSearch 字段。

模型与 Tavily API Key 只由 Main 持久化，并通过 Electron `safeStorage` 的正常后端加密。
Renderer 只在用户录入时短暂持有明文，并仅能调用写入/删除凭据 IPC；不存在读取 Secret
的 IPC。凭据与模型配置身份或搜索端点绑定，绑定信息变化后必须重新录入，避免复用旧
凭据指向不同服务。旧版 v1 Renderer `localStorage` 中的明文 Key 不自动导入，升级时保留
非敏感设置但要求重新录入并建议轮换旧 Key。`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 和
`TAVILY_API_KEY` 环境变量 fallback 继续可用，但只允许官方端点或由对应 Base URL/搜索
端点环境变量显式绑定的路由；远程凭据端点强制 HTTPS，HTTP 仅允许 loopback。Linux
`basic_text` 后端可用但状态明确为
`degraded`，不能等同于安全凭据服务。

**私有 call-path / driver 层：**

Gateway 对内归一三条通路 `callPath ∈ { chat, responses, anthropic }`，再经
`AgentProviderDriver` 注册表调度。对外仍使用 `provider` + 可选 `openaiApiMode`
（设置高级覆盖 / env / `baseURL` 启发式）；`callPath` 与 `openaiApiMode` 均不出现在
`ResolvedAgentModelConfig`。`chat` / `responses` / `anthropic` 各自负责 SDK 双向映射、
原生流事件与 `stopReason` 映射。流中实时暴露 `text_delta`（及 Anthropic
`thinking_delta`），最终 `complete` 以 SDK final response 为权威来源。每个 attempt
只允许一次 SDK 请求，不得在 driver 内做隐藏重试、非流式 fallback 或跨 attempt 合并
usage。各 driver 内部的 content type / role 映射差异属于通路方言，不在 Gateway 合并统一。

**Runtime 恢复：**

`src/main/agent/runtime/turns/model-call-recovery.ts` 根据 Gateway 返回的
`AgentGatewayError` 与归一化 `stopReason` 决定 attempt 之间的恢复，包括退避、
Context 压缩、输出 token 升级、截断续写和 fallback model。thinking-only 且因
token 上限结束也走这条 Runtime 恢复路径。新增通路时应实现相同的
prepared-request/response driver 协议，不能把通路分支扩散进 Query Loop
或 Presentation 工具。

验证入口：

- `tests/agent-gateway.test.ts`
- `tests/anthropic-gateway-adapter.test.ts`
- `tests/openai-gateway-adapter.test.ts`
- `tests/model-call-recovery.test.ts`
- `tests/context-compact.test.ts`
- `tests/native-tool-use.test.ts`
- `tests/response-contract.test.ts`
- `tests/agent-gateway-routing.test.ts`
- `tests/agent-gateway-errors.test.ts`
- `tests/agent-gateway.integration.test.ts`（按 provider 凭据可选执行）

### 3.3 Context 预算与压缩

Context 管理已经不是简单截断聊天数组。当前能力包含：

| 机制 | 目的 | 代码入口 |
|---|---|---|
| token 估算 | 在请求前判断预算 | `src/main/agent/runtime/context-compact/estimate-tokens.ts` |
| tool result budget | 避免单个工具结果吞掉上下文 | `src/main/agent/runtime/context-compact/tool-result-budget.ts` |
| micro compact | 优先清理低价值局部内容 | `src/main/agent/runtime/context-compact/micro-compact.ts` |
| snip compact | 对大块内容做局部裁剪 | `src/main/agent/runtime/context-compact/snip-compact.ts` |
| canonical compact | 生成可继续推理的紧凑历史 | `src/main/agent/runtime/context-compact/compact-history.ts` |
| emergency trim | 正常压缩仍超限时保住协议有效性 | `src/main/agent/runtime/context-compact/emergency-trim.ts` |
| native message compact | 压缩并保持 tool pairing | `src/main/agent/runtime/context-compact/model-messages.ts`、`src/main/agent/runtime/context-compact/prepare-context.ts` |
| request projection | Gateway 临时注入 request context，不污染 History | `src/main/agent/gateway/protocol.ts`、`src/main/agent/gateway/message-pairing.ts` |

压缩必须保留 system/user 意图、未完成工具配对、关键决策和当前任务状态。Renderer transcript 可以更丰富，但不能拿 UI 文本代替 canonical provider messages。

### 3.4 工具注册、发现与执行

工具系统分为三个概念：

1. **Registered**：代码知道该工具；
2. **Resolved / Visible**：load policy、category 与 `isEnabled(context)` 允许本次暴露；
3. **Authorized / Executable**：本次输入通过 schema、permission、审批和 Hook，可以执行。

stage 只影响建议与排序，permission 只在 Preflight/执行前裁决；二者都不参与
Registry 的 `Resolved / Visible` 过滤。

统一执行链为：

```text
resolve registered core tool
  → parse and validate requested input
  → resolve delegation target when declared
  → parse and validate target input
  → non-removable permission / approval
  → mutable PreToolUse hooks
  → execute
  → output validation / PostToolUse hooks
  → bounded model result
  → emit paired tool_result
```

Core tools 提供高频基础能力；Deferred 机制保留在 ToolLoader / ToolRegistry 上，但**产品默认 Deferred 发现面为空**，也不注册空壳 `SearchExtraTools` / `ExecuteExtraTool`。该空平台是有意工程能力（供管线测试与未来可发现工具复用），不是待删死代码；仅在确认永不恢复 Deferred 发现面后再考虑删壳并改写测试。Runtime-only 能力服务宿主运行，不应暴露给模型。协作工具（Task\* / teammate）当前注册为 Core。

详见 [Tool 系统](../agent/tools.md)。

### 3.5 文件操作与并发安全

读写工具不是薄文件 API，而是并发协议。Agent PPT 将该协议集中到 `WorkspaceFileService`：

- 所有路径相对受控 workspace 解析；
- 读文件建立 receipt/baseline；
- 覆盖已有文件和 Edit 必须先读；
- Edit 使用精确 old/new text，拒绝零匹配和歧义匹配；
- 提交前校验文件未偏离读取基线；
- 写入使用临时文件加原子替换；
- Main Agent 与 teammate 使用同一服务，不维护两套语义；
- 工具结果区分可给模型的摘要与本地富数据。
- 超预算结果与 Context 归档只在模型可读 workspace 中返回恢复路径；checkpoint 等
  application runtimeRoot 状态不暴露为文件工具路径。

这套能力保护 workspace 文本文件，不替代 Presentation 的 Proposal、CommitGate 和 artifact revision。

Renderer 的项目文件管理也复用同一安全边界，但使用独立的应用协议：

```text
list workspace files
  → open UTF-8 text file
  → issue editToken + sha256 version
  → inspect detail / diff
  → save(editToken, expectedVersion)
  → WorkspaceFileService compare-and-commit
```

`editToken` 绑定 session、workspace root、相对路径和一次隔离的读取 scope；其他调用者
重新读取同一文件不能刷新这份基线。保存时 token 或 SHA-256 version 任一不匹配都会
拒绝写入。`ProjectFileService` 的既有 artifact 读写也已委托
`WorkspaceFileService`，因此 Renderer、Agent 和项目持久化共享 UTF-8、symlink、
inode/hash、跨进程锁和原子替换语义。

当前管理页提供 artifact 分组、文件列表、详情、diff 和文本编辑。只有归属于已注册、
可编辑 artifact 的普通文本文件可以保存；`deck`、`history` 和未知 artifact 文件只读，
从 Main 的 `saveProjectFile` 也会强制拒绝写入，避免绕过 Presentation 与导出事实源。
页面不提供删除、重命名或二进制编辑。它管理的是当前 workspace 文件，不生成
immutable Artifact Revision，也不把一次保存自动解释为 `ready/verified`。

详见 [文件操作](../agent/file-operations.md)。

### 3.6 Prompt、Skill 与 Hook

三者职责不同：

| 机制 | 负责 | 不负责 |
|---|---|---|
| System Prompt section | 身份、稳定规则、当前上下文和能力说明 | 真正的权限拦截 |
| Skill | 按需注入领域知识、步骤建议和检查表 | 强制 Runtime 阶段转换 |
| Hook | 在确定执行点观察、阻塞或补充行为 | 修改 canonical state 的任意旁路 |

Prompt 采用稳定前缀和动态后缀，section 顺序与 cache key 由 assembler 管理。PPT 的
`ppt-workflow`（SVG-native 新建）、`ppt-design`、`ppt-design-layout`、`ppt-build`、
`ppt-edit`、`ppt-beautify`、`ppt-review`、`ppt-export` 等 Skill 是渐进式知识包；
`stages` frontmatter 是唯一推荐真相源，只改变推荐度，不应把其他安全工具变为不可用。

### 3.7 多 Agent、任务与后台工作

多 Agent 的目标方向是六项能力：并行处理、上下文隔离、专业化、独立判断与交叉验证、长任务委派与生命周期管理、组织协作。它是可选协作层，不是 SVG-native 作者路径的必经步骤。

当前协作能力由四个相互独立的对象构成：

- `TaskStore`：任务身份、状态、依赖和持久化；
- teammate conversation：子 Agent 自己的消息历史与工具上下文；
- message bus / inbox：Agent 间消息传递；
- background task manager：前台 Query 之外的受控执行。

teammate 必须有独立 Agent identity，但共享 workspace 安全边界和文件服务。任务完成、失败、取消和 shutdown 都应进入终态，不能只靠进程/Promise 消失判断完成。Lead 侧 Task\* / `spawn_teammate` 等协作工具当前注册为 Core（产品默认无 Deferred 发现壳）。

当前 `Partial` 的是“后台平台”而非基本后台执行：Agent PPT 尚未具备 daemon、跨进程
attach、`ps/logs/kill`、Remote Control 或 ACP 接入。

详见 [Multi-Agent](../agent/multi-agent.md)。

### 3.8 持久化、恢复与取消

持久化分为三类事实：

| 数据 | 保存内容 | 不能保存 |
|---|---|---|
| History | 已提交的 canonical 对话 | 未配对的临时 tool result |
| Checkpoint | Run phase、inflight、恢复 fence | UI 展示组件状态 |
| Transcript / activity | 可读审计与进度投影 | Provider History 的替代品 |

writer lease 防止两个执行者同时推进同一 Run；CAS 防止旧快照覆盖新状态；checkpoint coordinator 在模型提交、工具副作用和终态之间建立恢复边界；cancellation 负责停止后续调度，但已经发生的外部副作用仍需通过 checkpoint 和幂等边界处理。

详见 [持久化与恢复](../agent/persistence.md)。

## 4. Presentation 专属工程能力

Agent PPT 的产品价值来自以下领域层。

### 4.1 产品创建路径

- **Agent SVG-native（产品唯一创建/作者路径）**：`design/design-spec.json` → `slides/page-plan.json` → `slides/svg/PNN.svg` → `PreviewSvgPage` → `SubmitSvgDeck` → CommitGate。
- **Layout Grammar / element-IR**：共享库、element-IR slide 模型与 Agent 作者工具均已**移除**
  （`tests/svg-native-tool-surface.test.ts`）。Presentation 现为 STRICT SVG-only。

所有可达写入最终进入同一 Presentation schema、CommitGate、renderer 与 exporter，不能各自产生不兼容的“第二套 slide 事实”。

### 4.2 设计与布局

当前能力包括：

- SVG-native 页面作者源与 `visualSource.kind === "svg"`；
- `src/design-system/` 中的 DesignSystemV2 schema、preset、brand profile、颜色、背景与图片处理；
- HTML 预览、Renderer 镜像与 PPTX 导出使用 SVG-native Presentation 模型。

SVG-native 路径下模型直接写作完整页面 SVG；产品作者表面不含 layout handler、
element-IR 或 Grammar 工具。Grammar / layout-plan 共享库与未注册实现已从仓库删除；
空 Deferred 平台（搜索/委托壳）属有意工程保留，见 [Tool 系统](../agent/tools.md)。

### 4.3 提案、质量与交付

写入链路是：

```text
tool proposal（SubmitSvgDeck）
  → preview / diff
  → schema and deck validators
  → risk policy
  → CommitGate
  → canonical presentation
  → thumbnail / preview
  → PPTX export
  → postflight
```

自动质量能力覆盖 SVG 预览门禁、layout/style/asset 与 deck validators。最终约束由确定性代码执行，不能由模型绕过。

详见 [工作流与状态](../presentation/workflow.md) 和
[Visual Expression System](../presentation/visual-system.md)。

## 5. 明确不采用的能力

以下能力有价值，但当前不属于 PPT Runtime 产品边界：

| 能力 | 暂不采用的原因 | 重新评估条件 |
|---|---|---|
| 任意 Bash / PowerShell | 权限面过大；当前只保留 teammate 的 fail-closed 只读 direct-exec 子集 | 出现无法由结构化工具覆盖的明确用例，并先具备可证明的 OS sandbox |
| MCP / Plugin Marketplace | 会显著扩大配置、权限和兼容面 | 产品需要第三方数据源/企业连接器 |
| LSP / IDE 集成 | 与 Presentation 主任务无关 | 产品扩展为通用内容开发环境 |
| Computer Use / Chrome Control | 外部副作用与隐私边界复杂 | 明确需要浏览器内采集或演示 |
| Daemon / Remote Control / ACP | Electron 当前是本地交互入口 | 需要无人值守、移动端或远程协作 |
| 多 Provider 全兼容 | 维护成本高，且语义能力并不等价 | 有明确用户、模型能力和测试矩阵 |
| Feature flag 大矩阵 | 当前规模下会隐藏真实行为组合 | 发布渠道或实验数量确实需要 |

新增这些能力前，必须先定义产品用例、权限模型、持久化影响和验收矩阵。

## 6. 当前能力缺口与优先级

### 已完成：Artifact 与 Job 生命周期

现行实现已经建立每个 `PresentationId` 唯一的长期 `PptJob`，并用 immutable
ArtifactRevision 串联 design-spec、page-plan、SVG、preview、candidate、quality、
proposal、committed Presentation 与 export：

- Query completion 与 PptJob 业务状态正交；
- dependency revision/hash 驱动精确 stale 传播；
- ProposalId、PresentationRevisionId 与 ExportArtifact 分别证明审批、应用与交付；
- apply/export 使用 side-effect claim，恢复时不盲目重放；
- Renderer 通过只读 PptJobProjection 消费状态。

文件页面的 SHA-256 CAS 仍只负责编辑并发，不等于 ArtifactRevision。详细实现与
dev 数据策略见
[Presentation Artifact 与 Job 生命周期](../roadmap/presentation-lifecycle.md)。

### P1：后台执行产品闭环

基础 manager、task 和 inbox 已存在，仍需在出现真实无人值守需求后定义：

- Electron 退出时的任务语义；
- 跨进程 owner/lease；
- 可观察的 logs、cancel 和 retry；
- 凭据与 workspace 生命周期；
- 完成通知。

在这些契约明确前，不应将当前后台 Promise 描述为 daemon 能力。

### P1：端到端质量证据

分层契约见 [端到端质量证据](./e2e-quality.md)。**Layer 2 导出 golden 已进默认
`npm.cmd test`**（`tests/export-golden.test.ts`）：固定 fixture 走
`DeckExportService`，锁定抬升层与 PPTX 包内容。它证明导出回归，不证明模型发挥、
Electron 缩略图或 Office 打开。

其余层仍为 Proposed，发布验收还需要：

- Layer 1：Anthropic/OpenAI 真实网关闭环（扩展现有 integration 门控）；
- Layer 3：Electron 缩略图/HTML 像素对照；
- Layer 4：LibreOffice 近似 + PowerPoint/WPS/Keynote 人工抽查；
- 网络搜索和图片来源失败场景；
- `evaluation.ts` 仅作离线分数漂移，不是产品门禁。

## 7. 验证矩阵

| 变更范围 | 最小验证 | 扩展验证 |
|---|---|---|
| Query / Runtime | `agent-query-*`、`agent-runtime-*`、`tool-result-pairing` | cancellation、checkpoint、recovery |
| Gateway | adapter、routing、response contract、model recovery | `npm.cmd run test:integration:agent` |
| Tool / Permission | tool pipeline、access policy、approval、hooks | 对应真实工具副作用测试 |
| 文件操作 / 项目文件管理 | `tests/workspace-file-service.test.ts`、`tests/project-file-editor-safety.test.ts` | 编辑 token 隔离、只读 artifact、并发修改、路径逃逸、UTF-8 与原子写失败；页面状态/交互测试 |
| Multi-Agent | task、message bus、teammate recovery | background 与 shutdown 场景 |
| Presentation model | schema、layout、design、compiler | sample fixture 与渲染快照 |
| Export | exporter、postflight、deck export、**`tests/export-golden.test.ts`** | Layer 4 LibreOffice / 人工打开 PPTX（见 [e2e-quality.md](./e2e-quality.md)） |
| 全仓 | `npm.cmd run typecheck`、`npm.cmd test` | `npm.cmd run build` |

文档更新至少应检查 Markdown 相对链接和代码路径是否存在。真实网关测试需要凭据，PPTX 视觉验收需要生成 artifact 后人工检查，二者不能被普通单元测试替代。

## 8. 清扫收工后的工作流划分

Grammar / 未接线双轨 / 频谱残骸清扫已结束。后续不要再开「扫死代码」轮次覆盖下列事项：

| 类别 | 内容 | 入口 |
|---|---|---|
| **产品主线** | 模板管理与自动选择（已选定） | [template-management.md](../roadmap/template-management.md) |
| **远期导出** | 原生可编辑图表/形状 | [visual-system.md](../presentation/visual-system.md) §6；不与模板争主线 |
| **有意保留** | 空 Deferred 壳、`evaluation.ts`、Skill `allowed-tools` 不 enforce | [tools.md](../agent/tools.md)、design-system/evaluation |
| **风险 backlog** | Linux `basic_text` 凭据降级、daemon、E2E Layer 1/3/4/5、AppData 迁移 | [capability-scorecard.md](./capability-scorecard.md)、[e2e-quality.md](./e2e-quality.md) |

## 9. 维护规则

- 能力状态必须由代码和验证入口支持，目录存在不等于 **Implemented**；
- 新能力只有在改善 PPT 主链路正确性时才进入本表；
- 实现能力后同步更新状态、关键代码入口、测试入口和相应专题文档；
- 路线图能力落地前保持 **Proposed**，不要在现行架构中使用未来时态伪装现状；
- 删除或移动实现时先更新本表，避免能力索引成为失效目录清单；
- Provider、工具、Artifact 或恢复协议发生变化时，同时检查安全边界和持久化兼容性。
