# 下一步计划目录

[通用包身份修正](package-identities.md)及[单包多厂商 models 抽取](models-package.md#12-实施与验收记录)已完成本地验收。[M3-A](m3-a-composition.md#10-后续独立复核与完成结论)已通过定向、原生消费及全仓独立复核并验收完成。下一步为 [M3-B](m3-b-lifecycle.md)：方案已制定，迟到 binding 清理错误丢失已复现，修复及新增验收待执行；C–E 未推进。模型包工作不计入 M3-A/B，两者均不新增远程厂商调用。

每个迭代或独立切片使用一个文件，设计、实施记录和验收证据保留在对应文件内。

页面侧[独立 UI 设计体系执行方案](ui-design-system.md)的前置宿主分类已完成本地验收：根级 `app/` 承载桌面，`cli/` 承载终端命令、向导和交互执行，类型/构建、行为回归、真实入口与 Windows ASAR 烟测通过，证据见方案第 12 节。CLI 仍借用 Electron 平台桥接，纯 Node 化另行实施。UI 的 U0–U5 仍待执行，先完成契约再进入独立预览和 U2 表单闭环；未接新后端或切换生产 UI。

## 迭代计划

| 步骤 | 状态 | 独立文档 |
| --- | --- | --- |
| M1：Harness 公开面收敛 | 已完成本地验收及审核修复 | [公开协议、插件作用域与边界门禁](m1-public-api.md) |
| M2-A：通用会话宿主装配 | 已完成本地验收 | [通用机制与具体运行配置分离](m2-a-session-host.md) |
| M2-B：独立包边界与实际消费 | 已完成本地验收 | [构建、包导出、tarball 与 Electron 消费](m2-b-package-boundary.md) |
| M3：扩展与可靠性通用验收 | A 已完成；B 方案已制定、待实施；C–E 待执行 | [总计划](m3-reliability.md)；[A：组合与安装原子性](m3-a-composition.md)；[B：执行隔离与关闭排空](m3-b-lifecycle.md) |

M0 的既有闭环与 M4 的后续消费侧迁移见[整体路线](../project-plan.md#6-通用-harness-演进路线)；没有独立详细计划的阶段不新增占位文件。生产 UI/PPT、旧 Agent/Gateway 未因本次文档拆分而迁移。

## 独立切片与前序记录

| 切片 | 文档 |
| --- | --- |
| 页面 UI 设计体系 | [独立组件、页面与使用规则执行方案](ui-design-system.md)，前置 app/cli 分类已完成本地验收；新 UI 目标为 app/renderer，U0–U5 仍待执行；CLI 纯 Node 化及后端接入不在 UI 切片范围 |
| Tools 收敛 | [插件公开面、共享文件支撑与完整迁移方案](tools-package.md)，方案已设计、待实施；单个 tools 包、五个精确入口，保留新旧文件语义与生产恢复协议 |
| 多厂商模型包 | [单一 models 包、统一创建与厂商内部模块](models-package.md#12-实施与验收记录)，已完成实施与本地验收，当前真实适配器仅 MiMo |
| 通用包身份修正 | [当前包名、消费与发行边界](package-identities.md) |
| 日志包抽取 | [包边界、实际消费与验收记录](logs-package.md) |
| MiMo 与 CLI | [原生模型、开发入口与权限切片记录](mimo-cli.md)，完整模型方案仍见 [MiMo 实施方案](../mimo-token-plan-cn.md) |
| logs/tools | [日志设计、工具诊断接入与历史验收](logs-tools.md) |

## 当前基线

当前私有 workspace 使用 `@agent-harness/core@0.1.0`、`@agent-harness/logs@0.1.0` 与 `@agent-harness/models@0.1.0`，根 workspace 名称为 `agent-harness`。包身份修正阶段未开始 MiMo 抽取或 M3；随后模型包完成独立切片，当前 M3-A 状态以目录首段和独立记录为准。生产 UI/PPT、旧 Agent/Gateway 未切换。前轮源码路径与包名是当时事实，原记录中 `@agent-ppt/*` 仅供历史追溯；原通用包消费使用[包身份表中的新名](package-identities.md#通用包身份修正)，新模型包使用本段名称，无兼容别名。原 `src/agent/`、`src/agent-host/`、`src/logs/`、`src/models/` 已迁入三个包；不默认改变持久化版本或新增远程厂商调用。整体方向见 [项目整体规划](../project-plan.md)，持续约束见 [AGENTS.md](../../AGENTS.md)。

历史包名、源码路径和验收数字属于对应阶段，不因移动文档而升级为当前实现或新增验收。后续修改应在对应步骤文件中记录，避免重新汇总成单个大文件。
