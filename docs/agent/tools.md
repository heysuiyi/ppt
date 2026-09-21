# Tool 系统

> 文档类型：现行架构
> 最后核对：2026-07-30

## 1. 设计目标

工具是模型可调用的能力集合。Query Loop 只处理通用的 `tool_use → tool_result` 协议，不知道具体工具名称和 PPT 工作流顺序。

设计目标：

- 单一 Tool 契约；
- 每个 Query 按当前 Context 解析工具池，执行前再次检查可用性；
- 内置工具、文件工具、Skill、未来 MCP 使用同一解析入口；
- schema、业务校验、Hook、权限和执行只有一条管线；
- 工具失败作为结构化结果返回模型，使模型可以调整策略。

## 2. ToolDefinition

当前基础契约包括：

- `name`
- `description`
- `category`
- `loadPolicy`
- `inputSchema`
- 可选 `outputSchema`
- 可选 `mapResultToModelContent`
- 可选 `isEnabled(context)`
- 可选 `behavior`
- `risk`
- 可选 `permission`
- `execute`

`behavior` 是 Runtime 编排语义，不再通过工具名猜测：

```ts
interface ToolRuntimeBehavior<Input> {
  capabilities?: Array<
    "command_proposal" | "user_interaction" | "skill_load" | "tool_discovery"
  >;
  completion?: {
    terminalResult: "command_proposal" | "ask_user";
    expectation: "always" | "when_matching";
    exclusiveBatch: true;
  };
  background?: {
    isRequested(input: Input): boolean;
    describe(input: Input): string;
  };
  concurrency?: {
    mode: "parallel";
    resourceKeys?(input: Input, context: ToolContext): string[];
    conflictScope?: "workspace_path";
  };
  delegation?: {
    resolve(input: Input, context: ToolContext): ToolDelegationTarget;
    allowedCategories: ToolCategory[];
    allowedLoadPolicies: ToolLoadPolicy[];
  };
}
```

终止、独占批次、后台执行和 Deferred delegation 都读取上述元数据。
`execute()` 是唯一产生工具业务副作用的方法；校验、权限和观察逻辑不能通过
再次调用它来“预览”。

## 3. 动态工具解析

静态注册表只回答“系统认识哪些工具”；当前 Query 的解析器回答“现在向模型暴露哪些工具”。

```text
registered built-ins
  + file tools
  + enabled application tools
  + discovered/deferred tools
  + future MCP tools
  → deny/filter
  → isEnabled(context)
  → 去重
  → 稳定排序
  → AgentToolSchema[]
```

当前入口：

```ts
ToolRegistry.getCoreTools(context): ToolDefinition[]
ToolRegistry.getDeferredTools(context): ToolDefinition[]
```

当前解析考虑 category/loadPolicy、工具自身 `isEnabled(context)`、workspace 等
Context 能力以及本 Query 的 Deferred discovery session。权限与审批在执行
Preflight 判定，不靠“是否出现在目录”代替。

当前在 Query prepare 时解析模型可见 Core pool，并在每次 Preflight 再检查
`isEnabled(context)`；Deferred search 也按调用时 Context 过滤。工具结果稳定排序。
若未来引入会在同一 Query 中热插拔的 MCP/权限模式，Provider schema 应升级为每个
model turn 重新解析，而不是把变化藏进 Prompt。

## 4. Core、Deferred 与 Runtime-only

| 类型 | 暴露方式 | 适用场景 |
|---|---|---|
| Core | 当前模型请求直接可见 | 通用、常用、低目录成本能力 |
| Deferred | 通过搜索/解析加入当前工具池 | 专业或低频能力 |
| Runtime-only | 永不暴露给模型 | 内部提交、恢复、投影 |

这三类是加载策略，不是安全级别。Core 也必须过权限；Deferred 被发现后也不能绕过策略。

协作面（Task\*、`spawn_teammate`、`list_teammates`、`send_teammate_message`、`shutdown_teammate`）当前注册为 **Core**。

产品默认 Deferred 发现面为空，因此**不**在默认注册表暴露 `SearchExtraTools` /
`ExecuteExtraTool`。空 Deferred 平台（ToolLoader / Registry 搜索 API、Preflight
delegation、`ToolDiscoverySession`、以及可手动挂载的两枚壳工具）是**有意保留的工程能力**，
不是待删死业务：管线测试依赖它验证发现→委托→权限共用路径。仅当产品确认永不恢复可发现
Deferred 工具时，才另开「删壳 + 重写管线测试」专项。若测试或未来重新注册 deferred target，
`ExecuteExtraTool` 经 Preflight 解析后与直接调用共用权限、Hook、校验与结果映射；
Dispatcher 自身不执行目标。

## 5. 单一执行管线

```text
tool_use
  → 查找本 Query 已解析工具
  → JSON/schema parse
  → delegation resolve（若有）
  → target JSON/schema parse
  → 不可卸载的 permission authorize
  → PreToolUse hooks
  → checkpoint side-effect boundary
  → tool.execute exactly once
  → outputSchema
  → PostToolUse hooks
  → bounded model result
  → tool_result
```

任一步失败都产生与原 `tool_use.id` 配对的 `isError` 结果。只有 Runtime
cancellation 等控制流异常可以向外抛出。即使 delegation 后执行的是另一个定义，
Provider 结果仍与原 dispatcher `tool_use.id` 配对。

## 6. 本地富结果与模型结果

工具结果有两个消费者：

- 本地系统需要 diff、完整对象、缩略图、诊断和审计元数据；
- 模型只需要有界、可行动的观察结果。

因此：

1. `execute()` 返回完整结构。
2. `outputSchema` 在中央边界验证。
3. `mapResultToModelContent()` 生成紧凑模型内容。
4. 超预算结果保存到 workspace 的 `.task_outputs/tool-results/`，模型收到受沙箱
   `ReadFile` 可分页读取的路径、大小和预览；读取方必须沿 `nextOffset` 使用同一
   `expected_version` 直到 `hasMore=false`。application runtimeRoot 不作为模型文件区。

不能为了 UI 展示扩大 Provider ContentBlock，也不能把截断后的模型文本当作完整本地事实。

## 7. 并发

模型应把参数互不依赖的调用放在同一个 assistant batch，减少不必要的模型往返；
参数依赖兄弟结果的调用仍须等待下一轮。Runtime 只并发执行显式声明
`behavior.concurrency.mode="parallel"` 的工具，未声明者保持串行，不能根据名称、risk
或 permission effects 推断。连续可并发调用按最多四个一组形成 wave；资源键相交时
分到不同 wave，结果仍按 Provider 调用顺序提交。

Workspace `ReadFile` / `WriteFile` / `EditFile` 使用规范化路径作为资源键，所以同一路径
读写有序，不同路径可以并行。生命周期 artifact observation 使用独立串行队列，不会
把不同文件的实际 IO 重新全局串行化。声明 terminal completion 的工具必须
`exclusiveBatch: true`；若它出现在 mixed batch，整批在执行前拒绝，并为每个
`tool_use` 生成配对错误结果。

## 8. 权限层

权限裁决是代码路径，不是 Prompt 建议：

```text
hard deny
  → definition-owned permission / risk fallback
  → managed approval
  → mutable PreToolUse extensions
  → allow / ask / deny
```

权限入口由 executor 直接调用，`clearHooks()` 不能卸载。没有 profile 时，low risk
可以继续，medium/high risk 必须审批；既无 profile 也无 risk 的定义 fail closed。
高层 Hook 的 allow 不能越过更高优先级 deny。权限拒绝应告诉模型原因和可选替代
方案，但不能泄露 Secret。

Presentation 写入仍有独立的 `CommitGate`。允许调用 `SubmitSvgDeck` 不等于允许自动
应用所有命令。产品作者路径仅为 `PreviewSvgPage` → `SubmitSvgDeck`。

Grammar / 命令轨作者工具（`ExecuteLayoutPlan`、`PreviewCommands`、`SubmitCommands`、
`InsertSlideImage`、beautify/layout 等）已从仓库与默认注册表**移除**；产品作者路径仅为
SVG-native，不得再发现或调用这些工具。空 Deferred 壳（`SearchExtraTools` /
`ExecuteExtraTool`）有意保留供管线测试，默认不注册，不是 Grammar 作者能力。

## 9. Skill 与工具

Skill 提供知识和工作建议，不拥有工具权限。SKILL.md frontmatter 只保留
`name` / `description` / `when_to_use` / `stages`；不存在 `allowed-tools` 等 ACL 字段。
`LoadSkill`：

- 可以按 stage 提高排序或展示推荐；
- 不应仅因 stage 不匹配而拒绝加载一个安全 Skill；
- 加载结果作为上下文增量返回；
- 不把 Skill 内容编译成隐藏控制流。

模型可以跳过不需要的 Skill，也可以在发现问题后加载之前未推荐的 Skill。

可选上游 Skill（`ppt-brief` / `ppt-outline` / `ppt-storyboard` / `ppt-research`）
只提供写作规范：产物经通用 `ReadFile` / `WriteFile`（research 另可用 `WebSearch`）
写入，**没有**专用工具，也**不是**与 `design-spec` / `page-plan` 同级的 lifecycle 硬锁。

## 10. 关键实现

- `src/main/agent/tools/tool-definition.ts`
- `src/main/agent/tools/tool-registry.ts`
- `src/main/agent/tools/tool-loader.ts`
- `src/main/agent/runtime/tools/tool-preflight.ts`
- `src/main/agent/runtime/tools/tool-execution-engine.ts`
- `src/main/agent/runtime/tools/tool-access-policy.ts`
- `src/main/agent/runtime/tools/tool-result-data.ts`
- `src/main/agent/runtime/hooks/`
- `src/main/plugins/ppt/tools/preview-svg-page.ts`
- `src/main/plugins/ppt/tools/submit-svg-deck.ts`

## 11. 验收

- 注册新工具不修改 Query Loop。
- 同一工具在 Context 改变后可动态出现/消失。
- Main Agent 能直接解析并使用 Glob/ReadFile/WriteFile/EditFile。
- Deferred target 与 wrapper 使用同一权限和输出校验。
- 未知工具、无效输入和拒绝均形成配对错误结果。
- 工具解析顺序稳定，observer 和 UI 不影响解析结果。

## 12. 状态变更

| 旧行为 | 当前行为 |
|---|---|
| Completion/后台逻辑按工具名分支 | `ToolDefinition.behavior` 声明能力、终止、独占和后台语义 |
| Dispatcher 直接 `target.execute()` | Preflight 解析真实 target，统一走权限、Hook、校验与结果映射 |
| 权限依赖可清空的默认 Hook | Executor 内不可卸载的 `authorizeToolUse` |
| 无 profile 默认放行 | risk fallback；medium/high 要审批，缺少全部声明时拒绝 |
| mixed terminal batch 可能只执行一半 | 整批预拒绝，并保持全部 tool ID 配对 |
| Prompt 通过固定名称推断能力 | Prompt 从当前定义的 capability、permission 和 delegation 元数据生成指导 |
