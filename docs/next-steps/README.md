# 下一步计划目录

[通用包身份修正](package-identities.md)及[单包多厂商 models 抽取](models-package.md#12-实施与验收记录)已完成本地验收。M3 的 [A](m3-a-composition.md#10-后续独立复核与完成结论)、[B](m3-b-lifecycle.md#10-后续独立审核与完成结论)、[C](m3-c-persistence.md#12-c1c3-增量实施与验收记录)、D/E 均已验收；独立审核提出的 D 内容断言缺口已补齐并通过 [最终门禁](m3-d-recovery.md#137-修复实施与最终验收记录)，M3 本轮计划范围完成最终收口。下一阶段按 [M4 宿主消费侧计划](m4-host-consumption.md)推进；当前仅制定计划，不启动 PPT 或第二后端。

每个迭代或独立切片使用一个文件，设计、实施记录和验收证据保留在对应文件内。

页面侧[独立 UI 设计体系](ui-design-system.md)保留 U0–U2、R1/R2 与 Select 的历史证据；现已按用户要求完成[新桌面 UI 真实接入](ui-design-system.md#125-新桌面-ui-真实接入)：默认 renderer 使用新会话/分类设置，复用 CLI 宿主机制，接通真实模型、目录、审批、取消、历史与重启恢复。独立 `ui:dev` 仍为无后端设计预览；PPT 插件及完整 U3–U5 不因桌面接入自动完成。

CLI 已按[生产直切方案](cli-terminal.md#83-下一步执行方案生产-cli-一次直切)同轮实施 C1–C4：inline TUI、单输入 owner、安全配置包、Windows DPAPI、Node SQLite/模型/能力宿主及生产/开发入口；旧 CLI/Electron 桥接已删除，无双轨或预览入口。分层验收见[实施记录](cli-terminal.md#84-生产直切实施与验收记录)，包括真实 ConPTY，以及 4 次 MiMo 远程请求完成无插件对话、文件审批、跨进程恢复与落盘校验。

CLI 的[状态与输入交互优化](cli-terminal.md#87-状态与输入交互优化t0t3)保留前序实现和验收；最新前端目标与证据统一维护于 [`cli/docs/`](../../cli/docs/README.md)。[整体交互方案](../../cli/docs/interaction-design.md)的 F0–F4 已实施并完成[本地技术验收](../../cli/docs/next-steps.md#7-交付和证据记录)：连续启动、模型名/路径上下文、会话协调交接、正文/工具时间线、面板焦点和分级错误返回；真实 Windows TTY、受控 SDK/HTTP、跨进程 waiting 恢复与冷配置保密通过。风格待用户复核；未调用远程厂商，不改变 Core 规范消息、授权、持久恢复或 JSONL 协议。

## 迭代计划

| 步骤 | 状态 | 独立文档 |
| --- | --- | --- |
| M1：Harness 公开面收敛 | 已完成本地验收及审核修复 | [公开协议、插件作用域与边界门禁](m1-public-api.md) |
| M2-A：通用会话宿主装配 | 已完成本地验收 | [通用机制与具体运行配置分离](m2-a-session-host.md) |
| M2-B：独立包边界与实际消费 | 已完成本地验收 | [构建、包导出、tarball 与 Electron 消费](m2-b-package-boundary.md) |
| M3：扩展与可靠性通用验收 | A～E 已验收，独立审核修复通过，最终收口完成 | [总计划](m3-reliability.md)；[A：组合](m3-a-composition.md)；[B：隔离与排空](m3-b-lifecycle.md)；[C：持久并发与兼容](m3-c-persistence.md)；[D：最终验收](m3-d-recovery.md#137-修复实施与最终验收记录)；[E：观察与入口](m3-e-observation.md) |
| M4：宿主消费侧迁移与收口 | A、B 已完成本地验收；C～E 待实施 | [总计划](m4-host-consumption.md)；[A：实施与本地验收](m4-a-host-boundary.md#9-实施与本地验收记录)；[B：实施与本地验收](m4-b-desktop-lifecycle.md#8-实施与本地验收记录) |

M3 的既有集中证据与限制见 [E 的验收记录](m3-e-observation.md#8-本轮实施与验收记录)，独立审核修复、第三 PID 完整内容及最终门禁见 [D 第 13.7 节](m3-d-recovery.md#137-修复实施与最终验收记录)。M3 本轮收口完成；[M4](m4-host-consumption.md)以已接入的 CLI/新桌面为基线，先收敛宿主与终端展示边界，再验收生命周期、兼容和旧路径退出，不自动迁移 PPT 或删除整个旧链路。P3 第二后端与 P4 迁移/包化继续独立安排；有限观察验收不等于容量有界或任意 OS 管道阻塞下仍可推进。

M0 的既有闭环与后续消费侧迁移见[整体路线](../project-plan.md#6-通用-harness-演进路线)。新桌面已切换通用会话入口，未迁移旧数据库；PPT 领域/旧 Agent/Gateway 的删除或插件化不属于本次接入。

## 独立切片与前序记录

| 切片 | 文档 |
| --- | --- |
| 页面 UI 设计体系 | [组件、页面及使用规则](ui-design-system.md)；[新桌面真实接入与验证](ui-design-system.md#125-新桌面-ui-真实接入)，设计预览与真实桌面入口分离，旧 PPT 能力未接入 |
| 独立 CLI 终端 | [前端整体方案与执行记录](../../cli/docs/README.md)，F0–F4 已完成本地技术验收、风格待用户复核；[历史终端设计](cli-terminal.md)保留 C0–C4 生产直切、前序优化及分层验收，不设独立预览或兼容路径 |
| Tools 收敛 | [插件公开面、共享文件支撑与实施证据](tools-package.md#12-实施与验收记录)，单包五入口已实施并完成本地验收；真实安装、原始恢复、生产编辑器、四包监听与 ASAR 消费通过 |
| 持久化职责与后端替换 | [P1/P2 实施与验收](persistence-backends.md#13-p1p2-实施与验收记录)已完成：SQLite 职责收敛、原子 Thread 准入、真实进程/CLI 恢复及包消费；未新建 SQL 包，P3/P4 和 PG/MySQL 认证待执行 |
| 多厂商模型包 | [单一 models 包、统一创建与厂商内部模块](models-package.md#12-实施与验收记录)已落地；[后续协议补齐](models-package.md#13-旧-gateway-协议接入新模型端口)已实现 MiMo、OpenAI Chat Completions、OpenAI Responses、Anthropic Messages，并完成本地 SDK/CLI 验证 |
| 通用包身份修正 | [当前包名、消费与发行边界](package-identities.md) |
| 日志包抽取 | [包边界、实际消费与验收记录](logs-package.md) |
| 桌面日志替换 | [logs 包接入与实施证据](logs-package.md#9-桌面切换实施与验证证据)，旧日志引擎已删除；宿主上下文、历史治理、清理与退出已接通，相关回归、类型/边界、真实桌面及日志 ASAR 消费通过；全量运行有 3 项未修改范围的模型/CLI 失败，不切换 Agent/Gateway |
| MiMo 与 CLI | [原生模型、开发入口与权限切片记录](mimo-cli.md)，完整模型方案仍见 [MiMo 实施方案](../mimo-token-plan-cn.md) |
| logs/tools | [日志设计、工具诊断接入与历史验收](logs-tools.md) |

## 当前基线

当前私有 workspace 为 `@agent-harness/core@0.1.0`、`@agent-harness/logs@0.1.0`、`@agent-harness/models@0.1.0`、`@agent-harness/tools@0.1.0`、`@agent-harness/configuration@0.1.0`，根 workspace 名称为 `agent-harness`。新桌面与 CLI 均消费通用执行链，桌面 safeStorage 配置和独立 Harness 数据库不与 CLI DPAPI/旧 PPT 会话库混用。旧 PPT 领域实现保留，文件消费复用 tools 受控入口；未公开发布包或迁移历史数据库。整体方向见 [项目整体规划](../project-plan.md)，持续约束见 [AGENTS.md](../../AGENTS.md)。

历史包名、源码路径和验收数字属于对应阶段，不因移动文档而升级为当前实现或新增验收。后续修改应在对应步骤文件中记录，避免重新汇总成单个大文件。
