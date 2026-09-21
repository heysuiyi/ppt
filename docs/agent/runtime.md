# Agent Runtime

> 文档类型：现行架构
> 最后核对：2026-07-25

## 1. Runtime 的职责

`AgentRuntime` 是一次 Run 的生命周期 facade，不是所有 Agent 逻辑的容器。

```text
normalize options
  → RunFactory.open
  → RunFactory.prepare
  → consume query() events
  → Finalizer.complete / fail
  → Scope.close
```

它负责保证 open、prepare、query、finalize 和 close 的异常安全顺序。具体模型圈由独立 `query()` 驱动。

## 2. 职责分解

| 对象 | 所有权 |
|---|---|
| `AgentService` | 应用用例、Renderer/IPC 输入、跨 Run 服务 |
| `AgentRunFactory` | 将宿主服务和可选 RuntimePlugin 装配成 Prepared Run |
| `createPptPlugin` | PPT 上下文、任务状态、Prompt/revision 与领域 checkpoint 内容 |
| `AgentRunScope` | lease、History、checkpoint、Session、取消、后台任务、事件端口 |
| `PreparedAgentRun` | QueryParams、初始 State/Workspace、runner 所需依赖 |
| `query()` | 单一线性 model → tools → next state 循环 |
| `ModelTurnRunner` | 上下文准备、Provider attempt、恢复分类 |
| `ToolTurnRunner` | 完整工具批次和结果配对 |
| `AgentRunFinalizer` | terminal candidate、fence、History 与对外结果 |

## 3. Open

`open()` 必须在同一并发临界区完成：

- 分配或验证 `runId/queryId/threadId`；
- 获取 writer lease；
- 读取与该 lease 一致的 previous checkpoint；
- 打开 canonical Conversation History；
- 创建 Runtime-owned cancellation；
- 初始化事件、后台任务和持久化资源。

不能先读 History，过一段时间再取 lease，否则新 owner 可能基于陈旧快照运行。

## 4. Prepare

`prepare()` 负责把应用输入转换为稳定 Query 边界：

- 加载/恢复 canonical messages；
- 构建 System Context 和 User Context；
- 解析当前工具集合与工具 schema；
- 创建 `ToolContext`；
- 组装 `AgentQueryParams`；
- 恢复 committed State 与 inflight Workspace；
- 处理无需进入 Query 的明确 short circuit。

Prepare 可以失败，但失败仍必须走统一 Finalizer/close。

## 5. Consume

Runtime 消费 `query()` 的事件，并显式取得生成器 return value：

```ts
const iterator = query(run);
while (true) {
  const next = await iterator.next();
  if (next.done) return next.value;
  notifyObserver(next.value);
}
```

事件处理器：

- 只读；
- best-effort；
- 不返回控制指令；
- 不能成为第二个状态推进器。

Runtime 不再复制 Query Loop，也不根据 UI event 修改 State。

## 6. Finalize

终态采用 candidate → sealed：

1. Query 产生 terminal outcome。
2. Finalizer 物化真实用户结果。
3. 写 terminal checkpoint/fence。
4. 写 canonical Conversation History。
5. 更新 Service state 和可见 transcript。
6. seal terminal。

失败路径执行 read-after-write 对账，避免模糊 IO 结果造成两个 owner 都认为自己成功。

## 7. Close

`close()` 始终执行，并且幂等：

- 取消/收口后台资源；
- 条件释放 writer lease；
- flush 审计和数据库资源；
- 不覆盖已经 sealed 的终态；
- 不把清理错误伪装成业务成功。

## 8. RuntimeOptions 与 QueryParams

`AgentRuntimeOptions` 属于应用调用层，包含 Presentation snapshot、UI 回调、workspace、模型选择等。

`AgentQueryParams` 属于 Query 层，只包含该 Query 真正需要的稳定输入和注入依赖。

从 Options 到 Params 的转换只能发生一次。Query 不应读取原始 Options，也不应自行探测 Renderer 状态。

## 9. 领域中立的边界

Runtime 可以知道“这里有一个 completion policy”，但不应硬编码：

- cover/section/layout 名称；
- PPT 六阶段推进；
- 哪个 Skill 必须先加载；
- 文件内容模板；
- 具体 UI 卡片；
- 商业视觉评分细则。

Presentation 特有策略通过 RunFactory、Tool 或 CompletionPolicy 注入。

## 10. 关键实现

- `src/main/agent/runtime/agent-runtime.ts`
- `src/main/agent/runtime/agent-run-factory.ts`
- `src/main/agent/runtime/lifecycle/agent-run-scope.ts`
- `src/main/agent/runtime/turns/prepared-agent-run.ts`
- `src/main/agent/runtime/query/query.ts`
- `src/main/agent/runtime/turns/model-turn-runner.ts`
- `src/main/agent/runtime/turns/tool-turn-runner.ts`
- `src/main/agent/runtime/agent-run-finalizer.ts`

## 11. 验收

- `AgentRuntime.run()` 只表达生命周期和生成器消费，不自行实现 model/tool 推进循环。
- `query()` 可在注入 fake runners 后独立测试。
- Prepare/observer/finalize 任一异常都释放 scope。
- Presentation 规则不进入 Query 类型。
- Runtime 无需知道 Skill stage 才能执行合法工具。

## 12. 状态变更

| 旧结构 | 当前结构 |
|---|---|
| `AgentRuntime` 同时装配资源并执行 model/tool while loop | Runtime 只负责 open/prepare/consume/finalize/close |
| 普通 `for await` 丢失 generator return | 显式 `iterator.next()` 同时消费事件和最终 outcome |
| Main Agent 无通用文件服务 | RunFactory 按 thread/workspace 复用 `WorkspaceFileService` |
| Prompt、工具和 stage 在 Loop 内相互判断 | RunFactory prepare 一次组装；Loop 只消费 QueryParams |
| observer 失败可能污染业务路径 | Query event observer 为 best-effort，不参与状态推进 |
