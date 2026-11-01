# 下一步计划目录

[通用包身份修正](package-identities.md)及[单包多厂商 models 抽取](models-package.md#12-实施与验收记录)已完成本地验收。[M3-A](m3-a-composition.md#10-后续独立复核与完成结论)与 [M3-B](m3-b-lifecycle.md#10-后续独立审核与完成结论)均已验收。持久化 P1/P2 已完成 SQLite 职责收敛与 [M3-C2 原子准入修复](m3-c-persistence.md#10-c2-随持久化-p1p2-实施)，同进程/跨进程回归、第三进程重开和实际 CLI 审批恢复通过；完整 C1/C3、D–E 及第二后端仍待执行，无新增远程厂商调用。

每个迭代或独立切片使用一个文件，设计、实施记录和验收证据保留在对应文件内。

页面侧[独立 UI 设计体系执行方案](ui-design-system.md)的前置宿主分类已完成本地验收：根级 `app/` 承载桌面，`cli/` 承载终端命令、向导和交互执行，类型/构建、行为回归、真实入口与 Windows ASAR 烟测通过，证据见方案第 12 节。CLI 仍借用 Electron 平台桥接，纯 Node 化另行实施。UI 的 U0–U5 仍待执行，先完成契约再进入独立预览和 U2 表单闭环；未接新后端或切换生产 UI。

CLI 采用[独立 Node 终端设计与生产直切方案](cli-terminal.md)；[C0 契约](cli-terminal.md#82-c0-定稿与实施证据)已通过编译/Node 消费烟测和全仓类型检查。按最新决定，[下一轮合并 C1–C4 直接交付生产 CLI](cli-terminal.md#83-下一步执行方案生产-cli-一次直切)：终端、真实 Node 配置/安全凭据/持久化、根入口及旧桥接删除同轮完成，不先交付独立预览、不保留旧 CLI 兼容路径。Tools 五入口已有本地验收记录；新生产 CLI 仍待实施，本轮只修改方案。

## 迭代计划

| 步骤 | 状态 | 独立文档 |
| --- | --- | --- |
| M1：Harness 公开面收敛 | 已完成本地验收及审核修复 | [公开协议、插件作用域与边界门禁](m1-public-api.md) |
| M2-A：通用会话宿主装配 | 已完成本地验收 | [通用机制与具体运行配置分离](m2-a-session-host.md) |
| M2-B：独立包边界与实际消费 | 已完成本地验收 | [构建、包导出、tarball 与 Electron 消费](m2-b-package-boundary.md) |
| M3：扩展与可靠性通用验收 | A/B 已验收；C2 已修复并通过跨进程窗口验证；完整 C1/C3、D–E 待执行 | [总计划](m3-reliability.md)；[A：组合与安装原子性](m3-a-composition.md)；[B：执行隔离与关闭排空](m3-b-lifecycle.md)；[C：持久并发准入与恢复兼容](m3-c-persistence.md) |

M3 当前下一轮只补 [C1/C3 增量验收](m3-c-persistence.md#11-p1p2-完成后的下一轮执行安排)：复用 P1/P2 结构和已接入的进程夹具，不重复实施准入修复。acquire 提交确认未知归 D2；P3 第二后端与 P4 迁移/包化继续独立规划。

M0 的既有闭环与 M4 的后续消费侧迁移见[整体路线](../project-plan.md#6-通用-harness-演进路线)；没有独立详细计划的阶段不新增占位文件。生产 UI/PPT、旧 Agent/Gateway 未因本次文档拆分而迁移。

## 独立切片与前序记录

| 切片 | 文档 |
| --- | --- |
| 页面 UI 设计体系 | [独立组件、页面与使用规则执行方案](ui-design-system.md)，前置 app/cli 分类已完成本地验收；新 UI 目标为 app/renderer，U0–U5 仍待执行；CLI 纯 Node 化及后端接入不在 UI 切片范围 |
| 独立 CLI 终端 | [终端设计与生产直切方案](cli-terminal.md)，C0 契约已验收；[下一轮执行安排](cli-terminal.md#83-下一步执行方案生产-cli-一次直切)合并 C1–C4 同轮实现、直接切生产并删除旧 CLI 路径，不设独立预览交付，尚未实施 |
| Tools 收敛 | [插件公开面、共享文件支撑与实施证据](tools-package.md#12-实施与验收记录)，单包五入口已实施并完成本地验收；真实安装、原始恢复、生产编辑器、四包监听与 ASAR 消费通过 |
| 持久化职责与后端替换 | [P1/P2 实施与验收](persistence-backends.md#13-p1p2-实施与验收记录)已完成：SQLite 职责收敛、原子 Thread 准入、真实进程/CLI 恢复及包消费；未新建 SQL 包，P3/P4 和 PG/MySQL 认证待执行 |
| 多厂商模型包 | [单一 models 包、统一创建与厂商内部模块](models-package.md#12-实施与验收记录)，已完成实施与本地验收，当前真实适配器仅 MiMo |
| 通用包身份修正 | [当前包名、消费与发行边界](package-identities.md) |
| 日志包抽取 | [包边界、实际消费与验收记录](logs-package.md) |
| 桌面日志替换 | [旧日志到 logs 包的替换方案](logs-package.md#桌面旧日志替换方案设计尚未实施)，已完成代码调研与实例清理/重建烟测；宿主上下文、历史治理、完整清理与退出接入尚未实施，不切换 Agent/Gateway |
| MiMo 与 CLI | [原生模型、开发入口与权限切片记录](mimo-cli.md)，完整模型方案仍见 [MiMo 实施方案](../mimo-token-plan-cn.md) |
| logs/tools | [日志设计、工具诊断接入与历史验收](logs-tools.md) |

## 当前基线

当前私有 workspace 为 `@agent-harness/core@0.1.0`、`@agent-harness/logs@0.1.0`、`@agent-harness/models@0.1.0`、`@agent-harness/tools@0.1.0`，根 workspace 名称为 `agent-harness`。包身份修正阶段未开始 MiMo 抽取或 M3；随后模型包与工具包各自完成独立切片，M3/新 UI/新 CLI 状态仍以各自记录为准。生产聊天/PPT、旧 Agent/Gateway 未切换，但其共享文件消费已改用 tools 的受控 Node 入口。前轮包名/源码路径仅供历史追溯，原 `@agent-ppt/*` 无兼容别名；原 `src/agent/`、`src/agent-host/`、`src/logs/`、`src/models/`、`src/tools/` 已迁入四包，不默认改变持久化版本或新增远程调用。整体方向见 [项目整体规划](../project-plan.md)，持续约束见 [AGENTS.md](../../AGENTS.md)。

历史包名、源码路径和验收数字属于对应阶段，不因移动文档而升级为当前实现或新增验收。后续修改应在对应步骤文件中记录，避免重新汇总成单个大文件。
