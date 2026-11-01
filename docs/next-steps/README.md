# 下一步计划目录

[通用包身份修正](package-identities.md)及[单包多厂商 models 抽取](models-package.md#12-实施与验收记录)已完成本地验收。M3 的 [A](m3-a-composition.md#10-后续独立复核与完成结论)、[B](m3-b-lifecycle.md#10-后续独立审核与完成结论)、[C](m3-c-persistence.md#12-c1c3-增量实施与验收记录)、D/E 均已验收；独立审核提出的 D 内容断言缺口已补齐并通过 [最终门禁](m3-d-recovery.md#137-修复实施与最终验收记录)，M3 本轮计划范围完成最终收口。E 的独立通过保持，不因本次收口启动 M4/PPT 或第二后端。

每个迭代或独立切片使用一个文件，设计、实施记录和验收证据保留在对应文件内。

页面侧[独立 UI 设计体系执行方案](ui-design-system.md)的前置宿主分类已完成本地验收：根级 `app/` 承载桌面，`cli/` 承载终端，证据见方案第 12 节。随后 CLI 已独立为生产 Node 入口，不再借用 Electron。UI 的 U0–U5 仍待执行，先完成契约再进入独立预览和 U2 表单闭环；未接新后端或切换生产 UI。

CLI 已按[生产直切方案](cli-terminal.md#83-下一步执行方案生产-cli-一次直切)同轮实施 C1–C4：inline TUI、单输入 owner、安全配置包、Windows DPAPI、Node SQLite/模型/能力宿主及生产/开发入口；旧 CLI/Electron 桥接已删除，无双轨或预览入口。分层验收见[实施记录](cli-terminal.md#84-生产直切实施与验收记录)，包括真实 ConPTY，以及 4 次 MiMo 远程请求完成无插件对话、文件审批、跨进程恢复与落盘校验。

CLI 的[状态与输入交互优化](cli-terminal.md#87-状态与输入交互优化t0t3)已实施 T0–T3：统一状态与按键说明、审批上下文、补全与草稿、显示行导航及差异刷新。定向/全量回归、类型/边界和 Windows 真实终端场景通过；复杂 emoji 原生显示及其他终端的限制见该节证据。不复刻参考截图，不改 Harness、授权语义或 print/JSONL 协议，不借用 C0–C4 的历史证据。

## 迭代计划

| 步骤 | 状态 | 独立文档 |
| --- | --- | --- |
| M1：Harness 公开面收敛 | 已完成本地验收及审核修复 | [公开协议、插件作用域与边界门禁](m1-public-api.md) |
| M2-A：通用会话宿主装配 | 已完成本地验收 | [通用机制与具体运行配置分离](m2-a-session-host.md) |
| M2-B：独立包边界与实际消费 | 已完成本地验收 | [构建、包导出、tarball 与 Electron 消费](m2-b-package-boundary.md) |
| M3：扩展与可靠性通用验收 | A～E 已验收，独立审核修复通过，最终收口完成 | [总计划](m3-reliability.md)；[A：组合](m3-a-composition.md)；[B：隔离与排空](m3-b-lifecycle.md)；[C：持久并发与兼容](m3-c-persistence.md)；[D：最终验收](m3-d-recovery.md#137-修复实施与最终验收记录)；[E：观察与入口](m3-e-observation.md) |

M3 的既有集中证据与限制见 [E 的验收记录](m3-e-observation.md#8-本轮实施与验收记录)，独立审核修复、第三 PID 完整内容及最终门禁见 [D 第 13.7 节](m3-d-recovery.md#137-修复实施与最终验收记录)。M3 本轮收口完成；M4 仍按具体宿主需求单列，不自动切换生产 UI/PPT 或删除旧链路。P3 第二后端与 P4 迁移/包化继续独立安排；有限观察验收不等于容量有界或任意 OS 管道阻塞下仍可推进。

M0 的既有闭环与 M4 的后续消费侧迁移见[整体路线](../project-plan.md#6-通用-harness-演进路线)；没有独立详细计划的阶段不新增占位文件。生产 UI/PPT、旧 Agent/Gateway 未因本次文档拆分而迁移。

## 独立切片与前序记录

| 切片 | 文档 |
| --- | --- |
| 页面 UI 设计体系 | [独立组件、页面与使用规则执行方案](ui-design-system.md)，前置 app/cli 分类已完成本地验收；新 UI 目标为 app/renderer，U0–U5 仍待执行；CLI 纯 Node 化及后端接入不在 UI 切片范围 |
| 独立 CLI 终端 | [终端设计与生产直切方案](cli-terminal.md)，C0–C4 已实施；[生产 Node CLI 与分层验收](cli-terminal.md#84-生产直切实施与验收记录)，旧 CLI 桥接已删除，不设独立预览或兼容路径 |
| Tools 收敛 | [插件公开面、共享文件支撑与实施证据](tools-package.md#12-实施与验收记录)，单包五入口已实施并完成本地验收；真实安装、原始恢复、生产编辑器、四包监听与 ASAR 消费通过 |
| 持久化职责与后端替换 | [P1/P2 实施与验收](persistence-backends.md#13-p1p2-实施与验收记录)已完成：SQLite 职责收敛、原子 Thread 准入、真实进程/CLI 恢复及包消费；未新建 SQL 包，P3/P4 和 PG/MySQL 认证待执行 |
| 多厂商模型包 | [单一 models 包、统一创建与厂商内部模块](models-package.md#12-实施与验收记录)已落地；[后续协议补齐](models-package.md#13-旧-gateway-协议接入新模型端口)已实现 MiMo、OpenAI Chat Completions、OpenAI Responses、Anthropic Messages，并完成本地 SDK/CLI 验证 |
| 通用包身份修正 | [当前包名、消费与发行边界](package-identities.md) |
| 日志包抽取 | [包边界、实际消费与验收记录](logs-package.md) |
| 桌面日志替换 | [logs 包接入与实施证据](logs-package.md#9-桌面切换实施与验证证据)，旧日志引擎已删除；宿主上下文、历史治理、清理与退出已接通，相关回归、类型/边界、真实桌面及日志 ASAR 消费通过；全量运行有 3 项未修改范围的模型/CLI 失败，不切换 Agent/Gateway |
| MiMo 与 CLI | [原生模型、开发入口与权限切片记录](mimo-cli.md)，完整模型方案仍见 [MiMo 实施方案](../mimo-token-plan-cn.md) |
| logs/tools | [日志设计、工具诊断接入与历史验收](logs-tools.md) |

## 当前基线

当前私有 workspace 为 `@agent-harness/core@0.1.0`、`@agent-harness/logs@0.1.0`、`@agent-harness/models@0.1.0`、`@agent-harness/tools@0.1.0`、`@agent-harness/configuration@0.1.0`，根 workspace 名称为 `agent-harness`。前四包的独立切片与本轮 configuration/Node CLI 的证据各归所属记录；M3/新 UI 状态仍以各自记录为准。生产聊天/PPT、旧 Agent/Gateway 未切换，其共享文件消费已改用 tools 受控 Node 入口。前轮包名/源码路径仅供历史追溯，原 `@agent-ppt/*` 无兼容别名；CLI 与配置包闭包不依赖 app、根 src 或 Electron，不自动迁移桌面数据。整体方向见 [项目整体规划](../project-plan.md)，持续约束见 [AGENTS.md](../../AGENTS.md)。

历史包名、源码路径和验收数字属于对应阶段，不因移动文档而升级为当前实现或新增验收。后续修改应在对应步骤文件中记录，避免重新汇总成单个大文件。
