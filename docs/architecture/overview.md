# Agent PPT 架构总览

> 文档类型：现行架构
> 最后核对：2026-07-30

## 1. 核心定位

Agent PPT 是一个由模型驱动、由代码约束安全边界的本地 Agent Runtime。

模型负责理解目标、选择能力、观察结果并调整下一步；Runtime 负责保证消息协议、状态提交、工具权限、持久化和 Presentation 写入正确。系统不应依赖一套硬编码阶段机替模型决定“下一步只能做什么”。

```text
Renderer / IPC
    ↓
AgentService
    ↓
PresentationAgentRunFactory ── 组装一次 query 所需依赖
    ↓
AgentRuntime ── open / prepare / consume query events / finalize / close
    ↓
query() AsyncGenerator
    ├─ ModelTurnRunner
    ├─ ToolTurnRunner
    ├─ AgentQueryState
    └─ AgentIterationWorkspace
         ↓
Tool Registry / Permission / Hooks / Gateway / Persistence
         ↓
Presentation Command Proposal → CommitGate → CommandBus
```

## 2. 设计原则

1. **Query 是独立异步状态机**：核心循环是可单独调用、测试和观察的 `AsyncGenerator`，不是 UI、Service 或 Runtime 大类中的隐藏循环。
2. **输入、状态和单圈工作区分离**：`QueryParams` 只组装一次；`State` 只保存跨圈事实；未完成的模型/工具批次只存在于 `Workspace`。
3. **模型结束不等于 Query 结束**：模型返回工具调用、恢复要求、Hook 阻塞或后台通知时，循环继续；只有显式 Terminal transition 才结束。
4. **工具是能力，不是工作流步骤**：Runtime 动态解析当前可用工具；模型根据描述和反馈选择工具，不靠阶段规则代替判断。
5. **权限是代码策略**：Prompt 可以解释边界，但不能作为真正的权限系统。
6. **文件修改有并发契约**：Read 建立读集；Write/Edit 在写入前验证基线，并通过原子替换提交。
7. **System Prompt 是分区后的 section 集合**：稳定前缀和动态上下文分开，Section 有稳定顺序和明确失效条件。
8. **观察与事实分离**：流式文本、进度、审计和 UI 事件都是事实的投影，观察者失败不能改变 Query 结果。

## 3. 五层职责

| 层 | 主要对象 | 责任 | 不负责 |
|---|---|---|---|
| 应用层 | Renderer、IPC、`AgentService` | 收集用户输入、展示事件、装配应用用例 | 推进模型/工具循环 |
| 调用生命周期层 | `PresentationAgentRunFactory`、`AgentRunScope`、Finalizer | lease、资源、恢复、终态提交 | 决定每一圈如何继续 |
| Query 层 | `query()`、`QueryParams`、`State`、`Workspace` | model → tools → next state | UI 文案、业务文件实现 |
| 能力层 | Tool Registry、Skills、Hooks、Permission、CommitGate | 暴露和执行受控能力 | 代替模型编排任务 |
| 基础设施/领域层 | Gateway、History、Checkpoint、Project、Presentation | Provider 适配、持久化、文档模型与导出 | 保存未提交的临时别名状态 |

## 4. 一次用户请求的数据流

```text
用户输入
  → AgentRuntimeOptions
  → RunFactory.open()
      获取 thread/run/query identity、writer lease、History、checkpoint
  → RunFactory.prepare()
      组装 System Context、User Context、工具解析器、QueryParams
  → query()
      State snapshot
      → IterationWorkspace
      → 模型流
      → tool_use batch
      → validate / non-removable permission / hooks / execute
      → 配对 tool_result
      → 原子 reduce 成 next State
  → 显式 Terminal
  → Finalizer
      terminal checkpoint → canonical History → Service/UI 结果
```

Provider 原生内容块是消息协议唯一事实源。UI transcript、活动事件和本地富工具结果不能反向拼成另一套 Provider History。

Renderer 将一次运行投影为有序的可见 block 流：`response` 通过偏移引用消息正文，
`reasoning / tool / step / task` 保留在各自发生的位置。当前 activity indicator
只是消息列表尾部的瞬态反馈，正文开始流式显示时让位，不写入会话，也不会重新激活
旧 block。这样 `正文 → 工具 → 正文` 在实时展示和会话重载后保持同一顺序。

## 5. 三类状态必须分开

### 5.1 Query 状态

描述同一用户请求内部的多圈推进：

- `AgentQueryParams`：不可变输入与依赖。
- `AgentQueryState`：已提交消息、计数器和上一次 transition。
- `AgentIterationWorkspace`：当前圈尚未提交的 assistant/tool 增量。

### 5.2 Run 持久化状态

描述进程恢复和副作用边界：

- status：`running / waiting_user / completed / interrupted / failed`
- durable phase：`before_model / model_committed / tool_running / tool_committed / finished`
- inflight phase：`model_streaming / model_received / tool_running / waiting_user`

这些状态与 Query transition 相关，但不是同一个枚举。`command_proposal`
只作为 Query 的结构化结果类型；是否正在等待审批由独立的 Presentation Job
状态表达，不再写成 Run 终态。

### 5.3 Presentation 业务状态

描述 design-spec、page-plan、SVG 页、candidate、proposal、committed deck 和 export
（以及遗留 storyboard/layout-plan）。它跨多个 Query 存活，不能塞进 `AgentQueryState`。
现行实现以 `PresentationId` 唯一关联长期 `PptJob`，用 immutable ArtifactRevision
记录 stage 证据，并通过 `PptJobProjection` 向 Renderer 提供只读状态。产品新建为
SVG-native Agent；Proposal、PresentationRevision 与 ExportArtifact 分别提交。

## 6. 自主性与确定性边界

应由模型决定：

- 是否需要读取文件、搜索、加载 Skill 或调用演示工具；
- 使用哪些工具完成目标；
- 根据工具失败或新证据如何调整计划；
- 简单任务直接完成还是建立持久化任务。

必须由代码保证：

- 沙箱、权限、审批、Secret 和危险命令限制；
- `tool_use` / `tool_result` 一一配对；
- Query State 只提交完整批次；
- 文件写入的读后写、冲突检测和原子替换；
- Presentation proposal、校验、风险和 CommitGate；
- checkpoint lease、CAS、恢复和终态 fence；
- 步数、上下文和输出预算上限。

Skill stage、Prompt stage 和工作流建议只能提高相关性，不能成为拒绝合法能力的硬状态机。

## 7. 关键代码索引

- `src/main/agent/service.ts`：应用用例入口。
- `src/main/agent/runtime/agent-runtime.ts`：一次 Run 的生命周期 facade。
- `src/main/agent/runtime/query/query.ts`：独立 Query `AsyncGenerator`。
- `src/main/agent/runtime/query/query-types.ts`：Params、State、Workspace、事件与 reducer。
- `src/main/agent/runtime/presentation-agent-run-factory.ts`：Presentation 场景装配。
- `src/main/agent/runtime/lifecycle/agent-run-scope.ts`：lease、checkpoint、History 与资源所有权。
- `src/main/agent/tools/`：工具定义、注册、解析和领域工具。
- `src/main/agent/runtime/tools/`：preflight、权限、执行和结果归一化。
- `src/main/agent/runtime/prompts/`：Prompt context 与 section 组装。
- `src/main/agent/persistence/`：History、Run 和 Service 持久化。
- `src/main/agent/gate/`：Presentation 提案校验、风险和提交边界。

## 8. 架构验收

目标架构成立时，应能独立证明：

- 不启动 Renderer 也能驱动并测试 `query()`。
- Query 事件观察器抛错不会改变执行结果。
- 新工具注册后可由当前上下文动态解析，无需修改 Query Loop。
- Main Agent 和 teammate 共享相同的文件安全与 ContentBlock 不变量。
- Prompt stage 改变推荐顺序，但不会让本来安全可用的工具消失。
- 任意中断点恢复后，不会重复执行已经进入副作用边界的写操作。

## 9. Renderer 页面状态分层

页面导航与 Agent Query 状态分别管理。`App` 无条件调用 `useAppModel`，只负责启动状态和区域展示。`useAppModel` 持续挂载会话、草稿、运行、配置和演示文稿控制器，组装它们的依赖及跨区域操作，并适配顶栏和当前内容区域的参数；切换可见区域不会销毁这些业务状态。模型返回的内容区域使用判别联合类型，保证区域与组件参数匹配。对话阶段、菜单展开和设置表单草稿仍由所属区域管理。

- `app/appViewState.ts` 定义应用启动状态和 `AppLocation`。顶层区域为 `workspace` / `settings`；工作区页面为 `chat` / `files`，设置区域记录分类和返回的工作区页面。
- `app/useAppNavigation.ts` 拥有唯一的页面位置，提供导航操作并集中检查文件未保存状态。切换会话、删除当前会话也使用同一离开检查。拒绝放弃文件修改时，页面和业务操作均不继续。
- `AppShell` 只负责顶栏、通知和主体的区域布局。`AppTopbar` 独立接收页面位置、侧栏折叠状态、会话和模板数据及操作回调，根据位置展示功能；模板菜单的展开状态仍由菜单组件局部管理。
- `useWorkbenchLayout` 只管理尺寸、折叠和布局投影，不定义业务页面类型。应用首次加载完成后，后续目录加载由区域可用性表达。
- `WorkspaceView` 统一组装菜单及对话／文件内容。切换工作区页面时保留菜单实例，内容页卸载；文件草稿在用户确认离开后丢弃。对话输入草稿属于持续挂载的会话控制器，局部滚动、焦点和弹出菜单仍随视图卸载重置。
- `ChatWorkspace` 从会话和运行数据推导对话区域状态，再传给消息区和完整输入框。输入框根据区域状态决定位置、目录展示及可用性。
- `SettingsView` 统一设置菜单、标题和分类面板，只向各面板提供所需配置和操作。共享配置控制器仍在应用层；联网搜索凭据草稿在设置区内切换分类时保留，离开设置区时清除。

状态和数据通过 props 向下传递，用户操作通过回调交给状态所有者。菜单选中项、对话阶段和标题栏可见性均从上层状态推导，不另存同步副本。返回设置前的页面只恢复位置，不恢复已确认放弃的文件草稿。
