# Presentation 工作流与状态

> 文档类型：现行架构
> 最后核对：2026-08-01
> 生命周期实施记录见 [Presentation Artifact 与 Job 生命周期](../roadmap/presentation-lifecycle.md)

## 1. 工作流不是 Agent Loop

Agent Loop 负责一个 Query 内的模型和工具推进；Presentation 工作流负责一份演示从需求到交付的业务产物。

现行身份边界是：

```text
QueryId：一次用户请求的模型/工具执行
PresentationId → PptJobId：一份演示跨 Query 的长期业务演化
ArtifactId → ArtifactRevisionId：一个阶段已经校验并提交的不可变证据
PresentationRevisionId：已应用 deck snapshot 的不可变业务版本
```

`runId` 只标识一次执行尝试，`threadId` 只负责对话关联与恢复；二者都不能代替
`QueryId`。数字 `Presentation.revision` 是 CommandBus CAS，也不能代替
`PresentationRevisionId`。

模型可以根据用户目标选择：

- 直接回答，不创建 PPT；
- 对现有 deck 做一次轻量编辑；
- 使用 SVG-native Agent 路径新建整套演示；
- 从任一已有 artifact 继续；
- 只审查或导出。

Prompt stage 只提供当前事实和推荐能力，不能强迫所有请求经过固定六阶段。

## 2. 产品创建路径：SVG-native Agent

产品入口只走 Agent SVG-native 创建路径。

新建整套 PPT 的权威流程由 `skills/ppt-workflow` 约定：

```text
request
  → BeginPptCapability（PptCapabilityRequest + Intent revision）
  → design/design-spec.json（沟通契约 + deck-wide 设计锁）
  → slides/page-plan.json（逐页内容与构图意图）
  → slides/svg/PNN.svg（唯一页面视觉作者源）
  → PreviewSvgPage（逐页真实 PNG 门禁 + durable revisions）
  → SubmitSvgDeck（锁文件核对 + 素材内联）
  → CandidateDeck + QualityReport + CommandProposal
  → Query completed / PptJob waiting_approval
  → approval + CommitGate + PresentationCommitService
  → committed PresentationRevision
```

硬约束：

- 页面视觉事实源是完整页面 SVG（`viewBox="0 0 1280 720"`），不是 layout handler 填槽片段；
- 除 SVG 显式引用的本地 `assets/**` 图片外，背景、标题、正文、页码、图示与装饰都必须已在 SVG 中；
- 新建流程只走 `PreviewSvgPage` → `SubmitSvgDeck`（Grammar/命令轨作者工具已从默认注册表下架）；
- `SubmitSvgDeck` 要求 `communication` / `designSystem` / 每页 `id/path/narrative` 与锁文件一致；修订 SVG 会使旧 Preview 凭据失效。
- PreviewReceipt 是 durable ArtifactRevision，不再依赖进程内 WeakMap；Submit 时当前
  文件 hash、PageSvg head 与 PreviewReceipt dependency 必须全部匹配。
- SVG、素材、完整命令和 Presentation snapshot 等大值进入 content-addressed blob
  store；lifecycle SQLite 只保存 blob reference。

相关实现：`src/main/plugins/ppt/tools/preview-svg-page.ts`、
`src/main/plugins/ppt/tools/submit-svg-deck.ts`、
`src/main/plugins/ppt/tools/svg-deck-lifecycle.ts`、`skills/ppt-workflow/SKILL.md`。

## 3. 作者表面（SVG-only）

产品 Agent **作者表面**仅为 SVG-native。Grammar / 命令轨作者工具已从默认注册表
**下架**；`createPptToolRegistry()` 不再注册 `ExecuteLayoutPlan`、
`PreviewCommands`、`SubmitCommands`、`InsertSlideImage` 或旧 beautify/layout 工具。
该不变量由 `tests/svg-native-tool-surface.test.ts` 锁定。共享库物理删除是清理项。

产品新建只走 SVG；Presentation slide 必须带 `visualSource.kind === "svg"`。
遗留 element-IR / layout / grammarVariant 页应在加载或恢复时迁到 SVG-native，
而不是经 Grammar 再编译。

## 4. 当前 artifact

| Artifact | 作用 | 典型位置 | 角色 |
|---|---|---|---|
| Design Spec | 沟通契约与 deck-wide 设计锁 | `design/design-spec.json` | SVG-native 新建锁 |
| Page Plan | 有序逐页内容与构图意图 | `slides/page-plan.json` | SVG-native 新建锁 |
| Page SVG | 唯一页面视觉作者源 | `slides/svg/PNN.svg` | SVG-native 视觉事实 |
| Assets | SVG 显式引用的本地资源 | `assets/**` | 素材 |
| Brief / Outline / Research | 可选上游叙事材料（Skill + WriteFile） | `brief.md` / `outline.md` / `research/` | 可选知识产物；非硬锁 |
| Storyboard | 可选页级叙事上游（Skill + WriteFile） | `slides/storyboard.json` | 复杂 deck 可选；不是 lifecycle 事实源 |
| Layout Plan | 逐页 layout/variant（遗留） | `slides/layout-plan.json` | 非新建旁路；不是 lifecycle 事实源 |
| Brand / Design System | 品牌与视觉偏好 | `design/` | 与 Design Spec 并存演进 |
| Presentation | 已应用可编辑 deck | `deck/snapshot.json` + PresentationRevision | CommitGate 后事实 |
| Export | PPTX/HTML/JSON 与 postflight | export history + ExportArtifact | 交付物 |

文件存在不等于 artifact 已验证。默认项目注册表与 probe 已将 design-spec、page-plan、
Page SVG、assets、deck 与 export history 作为第一公民；brief、outline、research
是可选资料。只有 schema、依赖和领域校验通过后提交的 ArtifactRevision 才是阶段事实。

## 5. 业务状态与 UI 投影

Presentation 业务状态的唯一权威来源是持久化 `PptJobState`：

- `running / waiting_user / waiting_approval / completed / cancelled / failed`；
- 当前 capability、stage、committed heads 与 stage attempt；
- precise stale edge 与最早需重跑 stage；
- Proposal、PresentationRevision 与 ExportArtifact 指针；
- waiting reason。

Renderer 通过只读 `PptJobProjection` 和 `ppt-job:get/changed` IPC 消费这些事实。
项目状态区、artifact badge 与 Proposal card 都使用该投影。

`draft/ready/stale` 手工 metadata 与确认 IPC 已移除。文件页面自己的 loading、
dirty、diff、保存冲突仍是局部 UI 状态，不会推进 PptJob。聊天 activity/runStatus
只显示 Query 执行，不推断 artifact ready 或 Presentation applied。

## 6. 读取和写入

Main Agent 与 teammate 使用统一 Glob/ReadFile/WriteFile/EditFile：

- 读取建立 receipt/read-set；
- 覆盖和 Edit 执行乐观并发检查；
- 写入使用原子替换；
- 通用文件写入只保证文本与并发安全，不自动运行 artifact schema validator；
- 消费方在使用前负责解析和验证；`ready/verified` 不能只由文件存在推导。

Renderer 提供 workspace-level 项目文件管理页：

- 按 artifact 分组展示文件列表，并提供文本详情和保存前 diff；
- 只打开普通 UTF-8 文本，不跟随 symlink，也不编辑二进制文件；
- Main 在打开文件时返回隔离的 `editToken` 与 `sha256:` version；
- 保存必须同时提交同一 token 和 `expectedVersion`，由 `WorkspaceFileService`
  compare-and-commit；Agent、外部编辑器或另一个页面先修改文件时返回冲突；
- 只有归属于已注册、可编辑 artifact 的文本文件允许保存；`deck`、`history` 与未知
  artifact 文件只读，Main 在保存入口再次强制校验，不能由 Renderer 绕过；
- design-spec、page-plan、SVG 或素材变化通过统一 artifact-change observer 精确标记
  传递下游 stale，同时保留旧 revision 与已应用 Presentation；
- Agent Query 自身写入时 Job 保持 `running`；用户或外部修改在下一次
  read/probe/preview/submit 检出后进入 `waiting_user`。系统不新增常驻文件 watcher。

现有 `ProjectFileService` 的 artifact 读写同样委托 `WorkspaceFileService`，不再维护
一套弱化的路径、编码和原子写语义。当前页面不提供删除、重命名或二进制编辑。

不要通过 Shell 重定向生成工作流文件。

## 7. Proposal 与 CommitGate

模型不能直接篡改当前 Presentation 对象。

```text
Tool result
  → PresentationCommand[]
  → StageAttempt(candidate)
  → schema + sandbox apply + diff + risk
  → CandidateDeck/Commands + QualityReport revisions
  → CommandProposal revision + stable ProposalId
  → auto apply or ProposalId user approval
  → prepare CommandBus mutation
  → atomic session + lifecycle commit
  → new PresentationRevision
```

产品 Agent 提案入口为 `SubmitSvgDeck`（进入同一 CommitGate）。
`executionStrategy`（AUTO / REQUEST_APPROVAL）只控制审批，不是创建模式。

自动审批与人工审批进入同一个 `PresentationCommitService`。它重新读取 command blob，
核对 Proposal、base revision 与 stale edge，在临时 snapshot 中 prepare，再把 session
snapshot、PresentationRevision、Proposal transition、PptJob State 和 apply claim
提交到同一 SQLite transaction。成功后才同步内存 CommandBus 与 workspace deck。

Main 的 `presentation:execute/undo/redo` 也通过该服务，每次真实变更都产生
PresentationRevision。结构化 review 通过 `SubmitPptReview` 提交依赖当前
PresentationRevision 的 QualityReport。

必须区分：

- Query completed；
- Proposal ready / PptJob `waiting_approval`；
- Proposal approved 或 rejected；
- PresentationRevision applied；
- ExportArtifact completed。

任何一步都不能用普通聊天文本冒充下一步完成。

## 8. 用户交互点

只有真实产品决策才暂停：

- 目标/约束缺失且模型无法安全推断；
- 高风险命令审批；
- 用户明确要求比较方案；
- 素材授权需要确认；
- Proposal 与当前 revision 冲突。

“当前 stage 应该问用户”不是暂停理由。模型能通过读取事实或工具验证的信息应自行获取。

## 9. 修改已有 deck

轻量 edit：

1. 读取当前 snapshot/目标文件；
2. 定位用户指定范围；
3. 直接调用相应工具；
4. 生成最小 proposal；
5. 通过 CommitGate。

SVG-native deck 的可见修改应改对应 `slides/svg/PNN.svg` 并重新 `PreviewSvgPage`，再视需要 `SubmitSvgDeck`；不能只改 page-plan 期待提交工具代为重绘。

大规模 restyle/restructure 可以创建新的 design candidate，但在用户批准前不覆盖 committed Presentation。

## 10. 恢复

- Query checkpoint 恢复模型/工具批次；`waiting_user` 恢复沿用原 `QueryId`。
- PptJob repository 恢复 committed heads、attempt、stale edge、Proposal 与业务状态。
- command、Presentation、SVG 与素材 blob 在读取时校验 byte length 和 content hash；
  缺失或篡改会拒绝 submit/apply。
- PresentationRevision 恢复已应用 deck；Project 作者文件恢复可继续编辑的中间内容。
- apply/export 使用 durable side-effect claim。可以用已写文件和 hash 证明成功时补交
  revision；无法证明时进入 `waiting_user`，不盲目重放。
- 导出 IPC 只接收 `sessionId + options`，Main 读取权威 Presentation。ExportArtifact
  依赖当前 PresentationRevision，并记录 destination、format、file hash、byte length
  与 postflight。

它们不能互相替代。恢复时先读 durable facts，再让模型决定继续、修复或重新生成。

## 11. 持久数据与 workspace

应用级持久数据的唯一根是 `~/.agent-ppt`：

```text
~/.agent-ppt/
  conversations.sqlite
  blobs/
  logs/
  runtime/
  electron/              # Electron userData / Renderer localStorage
  token-usage.json
```

入口在 Electron `whenReady` 前调用 `app.setPath("userData",
join(homedir(), ".agent-ppt", "electron"))`，并设置 `AGENT_PPT_DATA_DIR`。
Workspace / sandbox 仍位于用户选择的项目目录，不迁入应用数据根。

dev 阶段不迁移 AppData 旧路径，不 backfill/hydrate 旧 session 或 workspace。开发者需要
手工删除 `%APPDATA%\.agent-ppt`、`%APPDATA%\agent-ppt` 等旧数据并使用新 workspace。

## 12. 关键实现

- `skills/ppt-workflow/SKILL.md`
- `src/main/application-data.ts`
- `src/shared/presentation-lifecycle.ts`
- `src/main/presentation-lifecycle/`
- `src/main/plugins/ppt/tools/begin-ppt-capability.ts`
- `src/main/plugins/ppt/tools/preview-svg-page.ts`
- `src/main/plugins/ppt/tools/submit-svg-deck.ts`
- `src/main/plugins/ppt/tools/submit-ppt-review.ts`
- `src/main/index.ts`
- `src/main/project/`
- `src/main/project/project-file-service.ts`
- `src/shared/ipc.ts`
- `src/renderer/src/components/project-store.ts`
- `src/renderer/src/components/ProjectFilesPage.tsx`
- `src/shared/project-artifact-state.ts`
- `src/main/plugins/ppt/gate/`
- `src/shared/commands.ts`（`CommandBus`；SVG deck 命令：add/remove-slide、titles、set-design-system、restore-slide）
- `src/shared/presentation.ts`（STRICT SVG-only `visualSource`）

## 13. 非目标与兼容边界

- 文件管理页的 SHA-256 version 是并发前置条件，不是 immutable Artifact Revision。
- 不保留已下线的「Lean commercial compiler」产品叙事；lifecycle stage/kind 不以该名称为准。
- storyboard 是可选叙事上游，不是 SVG-native 或 PptJob 视觉事实源；
  `slides/layout-plan.json` / Layout Grammar 不是产品新建路径（作者表面已下架）。
- 不实现旧 AppData/session/workspace 的 backfill、hydrate、启动迁移或双轨兼容。
- 不把 TaskStore、Query checkpoint、聊天文案或局部文件 UI 状态当作 PptJob。
