# UI 请求与后端受理

> 文档类型：现行架构
> 最后核对：2026-09-18

## 状态归属

- Renderer 持有输入草稿、模型选择 ID、当前页选择和乐观消息。
- Main 的 `AgentSettingsStore` 持有模型连接、Gateway/搜索配置、步数限制、默认执行策略和默认模板；凭据仍由安全存储独立管理。
- Session、Service thread 和 Run 记录决定后端如何继续。展示消息和卡片不再决定 start/continue。
- Query 内部的 `QueryParams / QueryState / IterationWorkspace` 不变。

## 提交契约

`agent:submit` 接收 `SubmitAgentRequest`：请求 ID、用户/assistant 消息关联 ID、目标 Session 或新建意图、prompt、modelId、编辑上下文，以及 message/edit/answer/inbox 动作。

编辑提交目标消息 ID；追问回复提交原 questionRunId。后端校验它们仍属于当前会话，拒绝过期回复。用户对本次请求明确选择的执行策略可以作为枚举覆盖默认值。

不传完整模型、备用模型、步数、服务配置、历史消息或 PPT 快照。新会话目录是用户显式选择时才传入的输入；默认模板由 Main 读取。

## 受理和执行

1. IPC 严格解析命令，在任何异步工作前占用前台运行槽位。
2. Main 读取配置快照，校验模型启用状态、Session、编辑/追问目标及页面选择。重复 requestId 不会再次执行。
3. 新会话先准备工作区；Session、消息分支、用户输入、assistant 锚点和 preparing Run 在同一 SQLite 事务中提交。事务失败不发布内存状态。文件系统准备不属于 SQLite 事务，失败时可能留下未注册的工作区文件，不自动删除用户目录；受理后的工作区镜像失败记录警告，不反转已提交的受理结果。
4. 推送 `agent:accepted`，包含权威 Session 快照和运行身份。前端此时才清空已发送的草稿。
5. 后端补充凭据、加载 Runtime、恢复 durable thread、配置 Gateway，再进入 AgentService。准备失败或取消也写入已受理 Run 的终态。
6. 按原有流式事件和结果处理完成、追问、审批、失败及中断。

Renderer 的提交阶段为 `idle → submitting → preparing → running → idle`。受理前拒绝保留草稿并撤回乐观消息；受理后失败保留已经持久化的用户消息。Run 表保存 preparing/running 和终态；聊天消息的 running 表示本次调用尚未结束。应用重启会将 preparing 和 running 都标记为中断。

同一发送不再依次调用 createSession、saveSessionMessages、start/continue。UI 收到受理事件可更新工作区，但后端不等待 UI 回传后才执行。

## 配置迁移与保存

应用挂载前读取 Main 设置；仅 Main 尚无配置时迁移旧 localStorage 中的无密钥配置，成功后移除旧执行配置键。已有 Main 配置不会被旧浏览器配置覆盖。界面主题和模型选择 ID 仍属于 UI 偏好。

设置变更时保存到 Main；发送仅等待已经发起的配置保存，不增加一次配置查询或回传 IPC。保存失败阻止使用旧配置启动并显示错误。本次受理解析出的配置不受之后设置编辑影响。

核心代码：`src/shared/agent-settings.ts`、`src/shared/ipc.ts`、`src/main/agent-settings-store.ts`、`src/main/agent/submit-agent-request.ts`、`src/main/index.ts`、`src/renderer/src/app/agent/useAgentRunController.ts`。
