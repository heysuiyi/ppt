# 下一步计划目录

[通用包身份修正](package-identities.md)已完成本地验收；[M3：扩展与可靠性通用验收](m3-reliability.md)的计划已制定，实施与新增验收待执行。本次文档拆分不启动 MiMo 抽取或 M3 实施。

每个迭代或独立切片使用一个文件，设计、实施记录和验收证据保留在对应文件内。

## 迭代计划

| 步骤 | 状态 | 独立文档 |
| --- | --- | --- |
| M1：Harness 公开面收敛 | 已完成本地验收及审核修复 | [公开协议、插件作用域与边界门禁](m1-public-api.md) |
| M2-A：通用会话宿主装配 | 已完成本地验收 | [通用机制与具体运行配置分离](m2-a-session-host.md) |
| M2-B：独立包边界与实际消费 | 已完成本地验收 | [构建、包导出、tarball 与 Electron 消费](m2-b-package-boundary.md) |
| M3：扩展与可靠性通用验收 | 计划已制定，实施与新增验收待执行 | [执行计划与验收矩阵](m3-reliability.md) |

M0 的既有闭环与 M4 的后续消费侧迁移见[整体路线](../project-plan.md#6-通用-harness-演进路线)；没有独立详细计划的阶段不新增占位文件。生产 UI/PPT、旧 Agent/Gateway 未因本次文档拆分而迁移。

## 独立切片与前序记录

| 切片 | 文档 |
| --- | --- |
| 通用包身份修正 | [当前包名、消费与发行边界](package-identities.md) |
| 日志包抽取 | [包边界、实际消费与验收记录](logs-package.md) |
| MiMo 与 CLI | [原生模型、开发入口与权限切片记录](mimo-cli.md)，完整模型方案仍见 [MiMo 实施方案](../mimo-token-plan-cn.md) |
| logs/tools | [日志设计、工具诊断接入与历史验收](logs-tools.md) |

## 当前基线

通用包身份已修正并完成本轮本地验收：私有 workspace 使用 `@agent-harness/core@0.1.0` 与 `@agent-harness/logs@0.1.0`，根 workspace 名称为 `agent-harness`。本轮未开始 MiMo 抽取或 M3 实施；已有 M3 执行计划及前序证据保留。生产 UI/PPT、旧 Agent/Gateway 未切换。前轮源码路径与包名是当时事实，原记录中 `@agent-ppt/*` 仅供历史追溯，当前消费必须使用[包身份表中的新名](package-identities.md#通用包身份修正)，无兼容别名。原 `src/agent/`、`src/agent-host/`、`src/logs/` 已迁入两个包；不默认改变持久化版本或新增远程厂商调用。整体方向见 [项目整体规划](../project-plan.md)，持续约束见 [AGENTS.md](../../AGENTS.md)。

历史包名、源码路径和验收数字属于对应阶段，不因移动文档而升级为当前实现或新增验收。后续修改应在对应步骤文件中记录，避免重新汇总成单个大文件。
