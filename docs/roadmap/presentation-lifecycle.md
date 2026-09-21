# Presentation Artifact 与 Job 生命周期实施记录

> 文档类型：已落地架构记录
> 状态：Implemented，现行代码事实
> 最后更新：2026-07-31

## 0. Dev 阶段数据策略（已定）

当前处于 **dev 开发阶段**，**不处理历史 session/workspace 的兼容迁移**。

- 应用级持久数据的唯一根目录是 `~/.agent-ppt`
  （Windows：`C:\Users\<you>\.agent-ppt`），不再写入 AppData。
- Electron `userData` 固定为 `~/.agent-ppt/electron`；应用 SQLite、blob store、
  token usage、logs 与 runtime 也全部位于 `~/.agent-ppt` 下，各自使用独立子目录或文件。
- Workspace / sandbox 仍在用户选择的项目目录内，例如
  `Documents/ppt/.agent-ppt-project.json` 与 `Documents/ppt/sandboxes/<sessionId>/`；
  它们不随应用数据根搬迁，也不会被应用自动删除。
- 引入 PptJob / ArtifactRevision 时，旧的
  `%APPDATA%\.agent-ppt`、`%APPDATA%\agent-ppt` 及其他误放数据
  **由开发者手工删除或视为可丢弃**。代码不自动清库、不搬迁、不扫描导入。
- 不实现 backfill、hydrate、启动迁移或“无 Job 旧项目”双轨兼容。旧 workspace
  不保证能被新版本打开；需要验证新流程时使用新的 workspace / sandbox。
- 临时导出中间文件仍可使用 `os.tmpdir()`；它不是应用持久数据。
- Renderer 的 localStorage 随 Electron `userData` 一起换根，旧 AppData 中的配置自然失效。

产品发布前若要保留用户数据，应另开迁移设计；本实现不以历史兼容为约束。

## 1. 已解决的边界问题

过去，文件存在、Query 结束、Proposal ready、Presentation applied 与 Export completed
容易被压成一个“完成”。现行实现把它们拆成正交事实：

> Query 管一次模型与工具请求如何运行；PptJob 管一份 Presentation 如何跨 Query 演化；
> ArtifactRevision 证明一个业务阶段可靠地产出了什么。

- 普通聊天 Query 可以 completed，但不会因此创建或推进 PptJob。
- 命令 Proposal 产生后，该 Query 已 completed；PptJob 独立进入 `waiting_approval`。
- 只有已提交的 Artifact、Proposal、PresentationRevision、QualityReport 或
  ExportArtifact 才能推进 PptJob。
- Presentation applied 与 Export completed 都有自己的 immutable revision 证明，
  不从聊天文案或 activity 状态推断。

## 2. 身份与生命周期所有权

| ID | 现行含义 |
|---|---|
| `PresentationId` | 一份长期演化的演示；一个 Presentation 只能有一个 PptJob |
| `PptJobId` | 该 Presentation 跨请求的长期业务工作流 |
| `QueryId` | 一次用户请求；不得等于或复用 `runId` / `threadId` |
| `PptCapabilityRequestId` | 一个 Query 声明的 create/edit/restyle/review/export 能力 |
| `PptStageRunId` | 某一 stage 的一次可诊断执行 attempt |
| `ArtifactId` | 一个逻辑 artifact 的稳定身份 |
| `ArtifactRevisionId` | 一个不可变、已校验 artifact 版本 |
| `PresentationRevisionId` | 已应用 Presentation snapshot 的不可变业务版本 |
| `ProposalId` | 可恢复、可幂等审批的 Proposal 身份 |

数字 `Presentation.revision` 仍是 CommandBus 的 CAS revision；
`PresentationRevisionId` 是 immutable lifecycle identity。两者不能替换或混用。

新用户请求产生新 `QueryId`。同一 Query 因 `waiting_user` 恢复时沿用原 `QueryId`；
新的跨请求继续操作拥有新 `QueryId`，但仍推进同一个 PptJob。

## 3. Schema

PptJob 状态：

```text
running / waiting_user / waiting_approval / completed / cancelled / failed
```

只有业务终态证明可以产生 `completed`。活跃 PPT Query 若以普通 message 结束且没有
业务终态证明，PptJob 转为 `waiting_user`，并记录最后 committed stage。

Stage：

```text
intent / design_spec / page_plan / page_svg / preview / candidate /
quality / proposal / presentation / export
```

Artifact kind：

```text
intent / edit_intent / restyle_intent / design_spec / page_plan /
source_asset / page_svg / preview_receipt / candidate_commands /
candidate_deck / quality_report / command_proposal /
presentation_revision / export_artifact
```

共享 schema 位于 `src/shared/presentation-lifecycle.ts`，Renderer、Main 与测试消费同一类型。

## 4. 持久化与事务

`PresentationLifecycleRepository` 是独立领域 repository，但与 conversation/session
状态共享应用 SQLite 连接。它持久化：

- job、capability request 与 stage attempt；
- immutable artifact revision、artifact head、dependency 与 stale edge；
- Proposal、side-effect claim 与 job event。

关键不变量：

- `presentation_id` 唯一，保证一份 Presentation 只有一个 PptJob。
- PptJob 的数字 `stateRevision` 使用 CAS；合法业务转换由
  `PresentationLifecycleOrchestrator` 强制，repository 只提供原子原语。
- stage candidate 先创建 attempt；校验失败或取消只保留 attempt 诊断，不创建 revision。
- revision value 使用 canonical JSON SHA-256；依赖固定到上游
  `ArtifactRevisionId + contentHash`。
- SVG、图片、完整命令数组和 Presentation snapshot 等大值进入
  `~/.agent-ppt/blobs` 的 content-addressed blob store。SQLite revision 只保存
  blob reference、媒体类型和字节数，不复制大内容。
- session snapshot、PresentationRevision、Proposal transition、PptJob State 与
  side-effect claim 可在同一 SQLite transaction 内提交。

## 5. Query 与 capability 边界

模型执行 create/edit/restyle/review 前必须调用核心工具 `BeginPptCapability`。
该工具按当前 Query 幂等创建 `PptCapabilityRequest` 与 Intent revision。

- 普通聊天不调用该工具，不创建 capability request，也不改变现有 PptJob。
- Presentation 领域工具没有 active capability request 时拒绝执行。
- 导出与 Renderer 的手工 execute/undo/redo 由 Main 创建内部 capability request，
  仍然经过相同 lifecycle。
- `runId` 只表示一次执行尝试；`threadId` 只负责对话关联与 Query 恢复。
- `query_completed(command_proposal)` 保持 Query completed；等待审批只写 PptJob。
- Query durable state 不再持久化 `proposal_ready` 或 pending approval。

`QueryId` 已进入 Query params、checkpoint、事件与 run 记录，不能由 run/thread identity
隐式代替。

## 6. SVG-native 作者链

产品新建的权威链路是：

```text
Intent
  → DesignSpec
  → PagePlan
  → SourceAsset / PageSvg
  → PreviewReceipt
  → CandidateDeck / QualityReport
  → CommandProposal
  → PresentationRevision
```

- design-spec、page-plan 与 SVG validator 由工具和 lifecycle 共用。
- `PreviewSvgPage` 读取当前 locks、页面与本地素材；校验和真实渲染成功后提交
  DesignSpec、PagePlan、SourceAsset、PageSvg 与 PreviewReceipt revisions。
- PreviewReceipt 已是 durable revision；进程内集合只允许作为缓存。
- `SubmitSvgDeck` 要求当前文件 hash、PageSvg head 与 PreviewReceipt dependency
  全部匹配；任一 missing、stale 或不一致都会拒绝。
- CommitGate 成功后提交 CandidateDeck/Commands、QualityReport 与 CommandProposal，
  并生成稳定 `ProposalId`。
- 外部编辑器变化在下一次 read/probe/preview/submit 时检测；没有新增常驻文件监听器。

## 7. Proposal、Presentation 与 Review

审批身份是 `ProposalId`。`AgentApprovalRequest` 同时携带 `jobId / queryId / proposalId`；
`threadId` 只保留聊天关联用途。

自动审批与人工审批进入同一个 `PresentationCommitService`：

1. 重新读取 immutable Proposal command blob；
2. 核对 Proposal、base revision、stale edge 与 CommitGate；
3. CommandBus 在临时 snapshot 中 prepare execute/undo/redo；
4. session snapshot、PresentationRevision artifact、Proposal 状态、PptJob State 与
   apply claim 在一个 SQLite transaction 中提交；
5. transaction 成功后才同步内存 CommandBus 与 workspace `deck/snapshot.json`。

重复批准同一个 Proposal 不会重复应用。结果不确定或已有 `in_progress` / `failed`
claim 时，系统拒绝盲目重放。

`presentation:execute/undo/redo` 同样通过该服务，每次真实变更都会产生
PresentationRevision；没有绕过 PptJob 的 Main 写入入口。

结构化 review 使用 `SubmitPptReview` 提交 QualityReport。报告必须依赖当前、
non-stale PresentationRevision；成功提交即可完成该 review capability，但不会伪造新的
Presentation revision。

## 8. Export

Renderer 导出 IPC 只提交 `sessionId + options`，不上传 Presentation snapshot。
Main 从 session/CommandBus 读取权威 Presentation。

导出幂等 key 包含：

```text
PresentationRevisionId + options + destination
```

成功后提交 ExportArtifact revision，记录格式、路径、文件 hash、字节数与 postflight，
并依赖当前 PresentationRevision。若进程崩溃后可以通过已写文件与 hash 证明导出成功，
系统补交 revision；无法证明时进入 `waiting_user`，不会盲目重复导出。

## 9. stale、项目注册表与 UI

默认项目 artifact / probe 已以 design-spec、page-plan、Page SVG、assets、deck 与
export history 为第一公民。brief、outline、research 是可选资料；
storyboard 是可选叙事上游，不是 lifecycle 事实源；layout-plan 只保留遗留旁路。

所有 Agent 与项目编辑入口复用 artifact change 观察逻辑：

- design-spec、page-plan、SVG 或素材 hash 改变时，只标记其传递下游 stale；
- immutable 旧 revision 与已应用 Presentation 都保留；
- PptJob 给出最早需重跑 stage 与具体 stale edge；
- Agent Query 进行中的自身写入维持 `running`；用户或外部修改使 Job
  `waiting_user`。

`draft/ready/stale` 手工 metadata 与确认 IPC 已移除，不再充当业务工作流真相。
文件页面的 loading、dirty、diff 与保存冲突仍是局部 UI 状态。

Renderer 只读消费 `PptJobProjection`，通过 `ppt-job:get/changed` 获得 capability、
status、stage、committed heads、stale reason、waiting reason、Proposal、
Presentation 与 Export 指针。聊天 activity/runStatus 只投影 Query 执行。

## 10. 恢复与完整性

Query checkpoint 与 PptJob persistence 正交：

- Query 恢复半个模型/工具批次；
- PptJob 从 immutable heads、attempt、Proposal 与 side-effect claim 恢复；
- command、Presentation、SVG 与素材 blob 每次读取都校验字节数和 content hash；
- 损坏或缺失 blob 会拒绝 apply/submit，不把损坏数据写入 Presentation；
- apply/export 仅在有 durable proof 时补交，不能靠重放猜测结果。

## 11. 产品路径与兼容边界

- 产品创建仅为 Agent SVG-native。
- 不把已下线的「Lean commercial compiler」叙事当作 lifecycle 入口或 stage 依据。
- storyboard 是可选叙事上游；Layout Plan 仅遗留旁路；二者都不是新建事实源。
- 不为旧 AppData、session 或 workspace 添加 backfill、hydrate、双写或启动迁移。

## 12. 关键实现

- `src/main/application-data.ts`
- `src/shared/presentation-lifecycle.ts`
- `src/main/presentation-lifecycle/`
- `src/main/plugins/ppt/tools/begin-ppt-capability.ts`
- `src/main/plugins/ppt/tools/svg-deck-lifecycle.ts`
- `src/main/plugins/ppt/tools/preview-svg-page.ts`
- `src/main/plugins/ppt/tools/submit-svg-deck.ts`
- `src/main/plugins/ppt/tools/submit-ppt-review.ts`
- `src/main/session-store.ts`
- `src/main/index.ts`
- `src/shared/ipc.ts`
- `src/renderer/src/components/project-store.ts`

测试覆盖 branded identity、canonical/blob hash、Job CAS、immutable revision、
dependency/stale propagation、attempt failure、Proposal exactly-once、direct
execute/undo/redo、review、export recovery、blob tamper rejection、PptJobProjection
与 Query/Proposal/Presentation/Export 的 UI 事实分离。

## 13. 完成定义（已达到）

- 每个 Presentation 只有一个长期 PptJob，跨 Query 继续演化。
- Query completion 不再等同于 Proposal ready、Presentation applied 或 Export completed。
- 关键阶段由 immutable ArtifactRevision、hash、dependency 与 validation 证明。
- SVG-native create、command edit、restyle、review、approval、manual edit 与 export
  都进入同一 lifecycle。
- stale 传播保留旧 revision 和已应用 Presentation。
- apply/export 使用幂等 side-effect claim，恢复时不盲目重放。
- 应用持久数据统一到 `~/.agent-ppt`，workspace/sandbox 位置不变。
