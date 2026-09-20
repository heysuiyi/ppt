# Agent PPT 文档

[English](./README.en.md) · [产品 README](../README.md)

本地优先的 AI 演示文稿工作台：模型通过工具协作产出可审批的 SVG-native 演示；代码以 CommitGate、权限与持久化约束安全边界。本文档集是**现行架构与契约索引**，行为事实以代码和测试为准。

## 界面一览

三栏工作台（会话 / Agent 过程与审批 / PPT 镜像）。下方为默认外观与 Agent 产出示例。

<table>
  <tr>
    <td width="50%"><img src="../images/首页.png" alt="三栏工作台" /><br/><sub>三栏工作台（默认外观）</sub></td>
    <td width="50%"><img src="../images/设置.png" alt="设置：用量与费用" /><br/><sub>设置：用量与费用</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="../images/放映.png" alt="放映示例" /><br/><sub>放映：结构化页面示例</sub></td>
    <td width="50%"><img src="../images/放映-暗.png" alt="放映深色创意封面" /><br/><sub>放映：深色创意封面示例</sub></td>
  </tr>
</table>

## 工作台主题定制（宣传）

工作台外观可通过 `~/.agent-ppt/themes/<名>/theme.css` 定制，**不影响**幻灯片 DesignSystem 与 PPTX 导出。以下为 Catnip 定制主题宣传图（非默认外观）。

<p align="center">
  <img src="../images/猫娘定制版.png" alt="Catnip 工作台主题宣传图" width="100%" />
</p>

<p align="center"><sub>食谱见 <a href="./user-manual/css-themes.md">CSS 主题指南</a> · 契约见 <a href="./architecture/ui-themes.md">工作台 UI 主题</a></sub></p>

## 文档范围

本树只保留三类内容：

- **现行架构**：代码正在遵守的稳定契约
- **本轮目标契约**：正在收敛、不得反向引入旧设计的边界
- **活跃提案或实施记录**：未实现标记 `Proposed`；已落地路线图标记 `Implemented`

已完成、已被替代的实施计划不归档在主文档树中。

## 从这里开始

| 文档 | 内容 |
|---|---|
| [架构总览](./architecture/overview.md) | 五层架构、数据流、状态边界与自主性原则 |
| [工程能力地图](./architecture/engineering-capabilities.md) | 能力落点、成熟度、缺口与验证入口 |
| [系统能力评价](./architecture/capability-scorecard.md) | 0–10 分域评分（含工作台 CSS/UI 主题）；评价快照，非行为契约 |
| [端到端质量证据](./architecture/e2e-quality.md) | 分层验收：Layer 1 网关闭环 + Layer 2 导出 golden（Implemented）；视觉/Office（Proposed） |
| [本地日志与运行诊断](./architecture/observability.md) | JSONL 日志、关联身份、事件级别、脱敏与容量边界 |
| [工作台 UI 主题](./architecture/ui-themes.md) | `themes/<名>/theme.css`、semantic token、`data-ui-region` |
| [Query](./agent/query.md) | QueryParams、QueryState、IterationWorkspace、身份与恢复 |
| [Agent Loop](./agent/loop.md) | 独立 AsyncGenerator、显式 outcome、工具批次与事件 |
| [Agent Runtime](./agent/runtime.md) | Service、RunFactory、RunScope、Runtime 与 Finalizer |
| [UI 请求与后端受理](./agent/submission.md) | 单次提交、配置归属、受理事务、准备状态与旧配置迁移 |

## 用户手册

| 文档 | 内容 |
|---|---|
| [用户手册索引](./user-manual/README.md) | 面向使用与定制的说明入口 |
| [CSS 主题指南](./user-manual/css-themes.md) | 工作台主题：能力清单、变量、背景/输入区/字体食谱 |

## Agent 系统

| 文档 | 内容 |
|---|---|
| [Tool 系统](./agent/tools.md) | ToolDefinition、动态解析、单一执行管线、权限和并发 |
| [文件操作](./agent/file-operations.md) | Glob / Read / Write / Edit，读后写与原子提交 |
| [System Prompt 与 Context](./agent/system-context.md) | 稳定/动态分区、Section Registry、Skill stage 建议化 |
| [持久化与恢复](./agent/persistence.md) | History、checkpoint、lease、inflight 恢复 |
| [Multi-Agent](./agent/multi-agent.md) | TaskStore、teammate、mailbox 与后台任务 |

## Presentation 系统

| 文档 | 内容 |
|---|---|
| [工作流与状态](./presentation/workflow.md) | SVG-native 创建路径、artifact、Proposal 与 CommitGate |
| [Presentation Artifact 与 Job 生命周期](./roadmap/presentation-lifecycle.md) | Query / PptJob / ArtifactRevision、恢复与数据根 |
| [Visual Expression System](./presentation/visual-system.md) | DesignSystemV2、SVG `visualSource`、三端渲染 |

## 活跃路线图

| 文档 | 状态 |
|---|---|
| [Presentation 模板管理与自动选择](./roadmap/template-management.md) | Proposed；SVG-native 对齐；自动选择 / 参考上传 / 母版分期 |
| [PPT 任务模型与流程选择](./roadmap/ppt-task-planning.md) | Proposed（推荐已有初版）；意图与难度、步骤数据处理、质量反馈与多 Agent 验收 |

## 核心设计约束

1. Query Loop 由独立 `AsyncGenerator` 驱动，不嵌入 UI 或固定 PPT 阶段机。
2. `QueryParams → QueryState → IterationWorkspace` 是唯一 Query 状态层级。
3. 观察事件只做投影，不能成为第二个事实源。
4. 工具按当前 Context 动态解析；注册工具不等于始终暴露。
5. Main Agent 可直接使用安全的 Glob/Read/Write/Edit，不强制借 teammate 写文件。
6. 覆盖/Edit 必须 read-before-write，文本写入使用原子替换。
7. Skill stage 只影响推荐和排序，不是权限 allow-list。
8. System Prompt 使用稳定前缀、动态后缀和 Section Registry。
9. 权限、tool pairing、CommitGate 和持久化不变量由代码执行，不依赖 Prompt。
10. `QueryId` 管一次请求；每个 `PresentationId` 一个长期 `PptJob`；`ArtifactRevision` 证明已校验产出。身份与 `runId/threadId` 分离。
11. 项目文件管理只投影当前 workspace；文本保存须带隔离 `editToken` 与 SHA-256 version，不能等同于 artifact revision。
12. 产品创建路径仅为 Agent SVG-native（`PreviewSvgPage` → `SubmitSvgDeck`）。`executionStrategy` 是审批策略，不是创建模式。
13. Query completed、Proposal ready、Presentation applied、Export completed 是四个独立事实；Renderer 只读消费 `PptJobProjection`。
14. 应用持久数据写入 `~/.agent-ppt`（含 `themes/`）；Electron userData 位于 `~/.agent-ppt/electron`；workspace 仍在用户项目目录。
15. 工作台 UI 主题只改软件壳，不改 DesignSystem / SVG 纸面 / PPTX 导出。
16. dev 阶段不 backfill 或迁移 AppData 旧数据；旧路径由开发者手工清理。

## 本轮重构状态

| 系统 | 状态 | 当前边界 |
|---|---|---|
| Query / Loop | Implemented | 独立 AsyncGenerator、Params/State/Workspace、完整批次提交 |
| Runtime | Implemented | 生命周期 facade；装配、循环和 finalization 分离 |
| Model Context | Implemented | canonical 压缩、request-scoped 投影、max-output 恢复 |
| Tools | Implemented | 动态可用性、统一 permission/hook/execution 管线 |
| System Prompt | Implemented | Section Registry、稳定/动态边界、stage 建议化 |
| File operations | Implemented | read receipt、精确 Edit、冲突检测与受保护提交 |
| Project file management | Implemented | design-spec / page-plan / Page SVG 等为第一公民；CAS 编辑 |
| SVG-native create | Implemented | DesignSpec → PagePlan → PageSvg → Preview → Proposal |
| Presentation lifecycle | Implemented | 跨 Query PptJob；revision/stale；apply/export side-effect recovery |
| Application data root | Implemented | SQLite、blobs、logs、runtime、token usage、`themes/` → `~/.agent-ppt` |
| Workbench UI themes | Implemented | `themes/<名>/theme.css` 注入、semantic token、`data-ui-region` |

## 文档维护规则

- 代码重构完成后，更新现行文档并删除对应阶段计划。
- 活跃提案必须标记 `Proposed`，不能写成“当前已经如此”。
- 已落地且因架构决策或 dev 数据策略需保留的路线图标记 `Implemented`，并同步 workflow 与本索引。
- 文档引用实际路径；移动文件时同步检查链接（含中英索引与 `../images/`）。
- 状态转换优先用类型、表格或图表达，不用模糊进度文案。
- 新规则先判断属于模型建议还是代码不变量；只有后者进入 Runtime/Policy。
- 中英索引（`README.md` / `README.en.md`）保持结构对称；截图变更时两端同步更新。
