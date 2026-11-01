# M2-A：通用会话宿主装配

[返回计划目录](README.md) · [项目整体规划](../project-plan.md)

## M2-A.1 第二轮目标、前置条件与非目标

第二轮交付“平台无关的会话宿主装配”：固定一个 Thread 的执行入口，先确认宿主持久绑定，再通过公开 Application 创建 Agent；具体指令、插件与授权由调用方显式提供。它是 M2 的通用装配切片，不等于 M2 的独立包、构建与发布门槛已经完成。

前置条件：M1 的公共协议闭包、窄 PluginScope、调用方迁移和定向依赖检查已落地并完成相应验收。第二轮设计可以先行，但实施必须先重读第一轮实际结果；如路径或契约发生变化，先修订本方案，不新增旧入口 shim，也不覆盖第一轮正在进行的改动。M1 不包含本节工作，M1 完成也不能自动标记 M2-A 完成。

纳入范围：

1. 新增 `src/agent-host/session-host.ts`，内聚线程固定、发布前绑定确认、Application 创建与关闭；只消费 M1 公开入口。
2. 将现有工作区定义、文件插件选择、工具授权和审批载荷解释集中到当前宿主的具体配置文件；不进入通用模块。
3. 工作区组合根继续创建并拥有模型、SQLite、日志，通过必需的窄绑定端口连接通用宿主。
4. 保持工作区 v2 绑定及原会话可恢复，证明不安装文件能力也可以使用同一个通用宿主。
5. 迁移受影响调用方、补齐依赖约束，提供实际 Node 无 Electron 消费及原开发入口恢复证据。

不纳入范围：

- 不新增 Harness/Assistant 类、BeanFactory、全局 Context、依赖 token、拓扑解析器、扫描、配置语言、动态插件或 HMR。
- 不新建包/workspace，不新增 package exports；不宣称脱离仓库安装消费、独立发布或完整 M2 验收。
- 不泛化 SQLite 绑定格式、历史查询或配置注册体系；不新增 v3，不改表结构，不迁移历史行。
- 不改变检查点 v1、模型重放、连接指纹算法、工作区定义/插件版本、审批 v1、工具安全或执行状态机。
- 不改变 CLI 默认配置、命令和选择流程，不增加 profile/插件选择菜单；不接入额外 provider。
- 不切换生产 UI、不迁生产历史、不迁 PPT/Skill/子 Agent，不删除旧 Agent/Gateway。

## M2-A.2 当前职责与切分决策

本节依据当前调用链；M1 实施中的错误/值操作 import 迁移不再列为第二轮待修问题。

| 位置 | 当前职责 | 第二轮归属 |
| --- | --- | --- |
| `main/agent-host/create-agent-host.ts` | 指令、tools、按工具名授权、模型/存储/日志、绑定及执行包装 | 保留具体资源组合根，通用执行包装迁到新模块，工作区配置另行内聚 |
| `agent/application/agent-application.ts` | Agent 创建占位、取消、关闭与排空 | 完整复用，不复制其实例表、资源树或生命周期算法 |
| `main/agent-host/host-session-binding.ts` | 严格工作区 v2 格式与快照 | 原位保留，是宿主适配协议，不成为通用宿主 schema |
| `main/agent-host/sqlite-agent-stores.ts` | 历史/检查点/绑定的真实 SQLite 实现与工作区列表投影 | 原位保留，由组合根借出端口；不因使用 Node API 就声称已完成独立适配模块 |
| `main/agent-host/configured-model-factory.ts` | 已签发计划、凭据解析、原生模型准备与连接指纹 | 原位保留，依赖当前应用配置的代码不进入通用模块 |
| `main/agent-host/development-runner.ts` | Electron、输入队列、命令、观察投影、审批、会话选择 | 继续调用工作区组合根；不变成通用运行容器 |
| `main/agent-host/development-sessions.ts` | 当前工作区的只读会话枚举 | 保持工作区特定用途，不新增全局通用会话目录 |

不另建“运行配置对象系统”。具体配置首先就是有明确返回类型的 TypeScript 工厂；依赖由参数/闭包提供。无插件消费直接显式传 `plugins: []`、定义和授权策略，不必注册一种新的助手类别。

## M2-A.3 通用会话宿主的公开协议

新增具名入口 `src/agent-host/session-host.ts`，定义以下受支持契约并内聚默认创建逻辑；不新增 `index.ts` 或单纯转发工厂。类型引用均来自 M1 公开协议。

```ts
export interface SessionBindingPort {
  ensure(): Promise<void>;
}

export interface SessionHostOptions {
  readonly services: AgentServices;
  readonly agent: AgentCreationOptions;
  readonly threadId: string;
  readonly binding: SessionBindingPort;
}

export type SessionRunInput = Omit<AgentRunInput, "threadId">;
export type SessionResumeInput = Omit<AgentResumeInput, "threadId" | "takeover">;

export interface SessionHost extends Disposable {
  run(input: SessionRunInput): Promise<AgentRunHandle>;
  resume(input: SessionResumeInput): Promise<AgentRunHandle>;
  close(): Promise<void>;
}

export function createSessionHost(options: SessionHostOptions): Promise<SessionHost>;
```

上述签名已实施；这里的函数声明仅描述公共 API，实际入口包含完整创建与回收实现。

契约要求：

- `AgentServices`、`AgentCreationOptions` 继续由 Agent 模块拥有，不复制一套 model/history/checkpoint/plugin 类型，不把具体函数的 ReturnType 作为公共协议。
- `services.authorizeTool` 必须显式提供，即使 `plugins: []` 也不默认允许；插件不可移除或替换宿主策略。原型外的意外缺项应在创建阶段拒绝，不能静默补默认实现。
- `binding` 必须提供，不默认空 ensure，不增加可选关闭回调或服务定位方法。其实现确认这一份固定装配与权威恢复边界一致；不符合则拒绝创建。
- 通用模块不接收 `AgentConfiguration`、密钥、SDK、路径、ToolsMode、数据库连接、NodeLogs 或整个宿主对象；不读取进程环境。
- 不向通用 SessionHost 暴露绑定内容或具体资源；工作区外壳可以继续提供自己的 `binding` getter。
- 一个 SessionHost 创建一个 Application 和一个 Agent，保持当前资源隔离粒度；不在本轮引入共享 Application、多 Agent 调度或隐式排队。
- `SessionRunInput/SessionResumeInput` 的省略仅描述调用协议；实现仍显式构造转发字段，不能靠 TypeScript 类型阻止运行时夹带 threadId/takeover。

## M2-A.4 创建、执行与关闭顺序

通用实现只负责以下实际机制，不复制 Loop、恢复协调或 Application 的资源管理：

1. 在首个 await 前校验 threadId，并固定 services 中的端口引用、agentId/maxSteps/signal、definition/model 的 detached 协议快照和插件数组副本。创建参数不得在等待绑定后重新从可变 options 读取；插件是受信任对象，不深拷贝其函数或承诺隔离恶意改写。
2. 检查创建信号，等待 `binding.ensure()`，完成后再次检查取消。失败不得安装插件、创建模型 binding 或发布可运行宿主。外层已经创建的 provider、SQLite、日志不属于这里的“尚未创建资源”。
3. 通过 `createAgentApplication(services)` 和 `application.agents.create(fixedAgentOptions)` 创建实例；完整保留 M1 入口。应用创建成功才进入本宿主所有权。
4. 创建后再次检查信号；已取消则回收 Application，不发布半初始化实例。创建失败回收已取得的 Application；执行错误和清理错误必须保留并安全投影，不用清理成功掩盖原失败。
5. `run()` 固定创建时的 threadId，显式转发 queryId/runId/input/signal；`resume()` 固定 threadId，仅转发 queryId/runId/response/signal。不接受 takeover，不把前端重建快照传给内核。Query/Run 身份及待决回答的合法性继续由内核检查。
6. `close()/dispose()` 共享幂等关闭 Promise；开始关闭时同步停止受理，再调用 Application 关闭并等待执行静止。不维护第二张 Agent/Run 表，也不额外实现取消状态机。
7. 关闭只释放本宿主创建的 Application/Agent；不 dispose 借用的 models/history/checkpoints/authorizeTool/binding，也不直接关闭 provider、日志或数据库。

新通用实现沿用现有 `HOST_OPTIONS_INVALID`、`HOST_CLOSED` 等可公开宿主错误语义；工作区组合根继续负责既有 `HOST_CLOSE_FAILED`、`HOST_START_AND_CLOSE_FAILED` 的安全报告。不可将原始 AggregateError、SDK 异常或内部堆栈直接输出到终端。新增错误如确有必要，在实施中具名定义并补相应调用方行为，不通过字符串别名维持两套实现。

Query 等待仍结束当前 Run；关闭已持久 waiting 不应改成 cancelled/interrupted。活动执行关闭是 interrupted，用户取消是 cancelled。新的包装不能改变这些内核语义。

## M2-A.5 工作区配置与 Electron 组合根

新增 `src/main/agent-host/workspace-configuration.ts`，集中当前工作区配置：

```ts
export interface WorkspaceConfigurationOptions {
  readonly workspaceRoot: string;
  readonly toolMode?: ToolsMode;
  readonly logger?: Logger;
}

export interface WorkspaceConfiguration {
  readonly definition: AgentDefinition;
  readonly plugin: ToolsPlugin;
  readonly authorizeTool: ToolAuthorizationPolicy;
}

export function createWorkspaceConfiguration(
  options: WorkspaceConfigurationOptions,
): Promise<WorkspaceConfiguration>;
```

`createTools()` 保持工具模块的公开创建入口，返回的实际 canonical workspaceRoot、effective mode 和工具清单是绑定与授权的来源。该配置工厂不创建模型、SQLite 或日志，不启动执行。未安装文件能力的配置不调用此工厂，无需伪造工作区。

从原组合根移动而非复制以下逻辑：

- `workspaceDefinition()` 及原 instructions，保持 `general-workspace-assistant` 的 ID、version 和内容不变；本轮不借拆分改变模型提示词。
- tools 创建、read-only 默认值、已安装工具集合、workspaceId 的 SHA-256 计算。
- 原按工具名解释 path/pattern/glob 的授权规则、只读允许和写入逐次审批。
- 原 `host-permissions`、`workspace-tool:<queryId>:<callId>`、`host.workspace-tool` v1 及 `{ tool, path, workspaceId }`，保持可解释旧只读待决交互。

在同一具体配置模块导出具名 `WorkspaceApproval` 和 `parseWorkspaceApproval(interaction: InteractionRequest): WorkspaceApproval`，移动 runner 原 owner/type/version 与严格 payload 检查，不新建交互处理器 Registry。未知交互仍以 `CLI_INTERACTION_UNSUPPORTED` 失败并保持 waiting；既有已识别载荷的无效内容继续安全拒绝。runner 只负责显示、yes/no/cancel 输入和调用 resume，不再定义第二份工具名/载荷 schema。

`create-agent-host.ts` 继续作为当前开发入口的具体组合根，公开名称不因这一轮统一命名而更换：

1. 创建 NodeLogs、工作区配置、PreparedConfiguredModel、SqliteAgentStores。
2. 用同一份固定配置生成工作区 v2 绑定和 ensure 闭包，调用通用 `createSessionHost()`。
3. 向通用模块提供实际 definition、`[plugin]`、model/maxSteps 和独立 authorizeTool；不让通用模块解释工具名。
4. 返回现有工作区 AgentHost，保留 detached `binding` getter。其类型以 `extends SessionHost` 表达执行能力，不再重复声明 HostRunInput/HostResumeInput；旧无调用方类型删除，不保留兼容 re-export。
5. 关闭顺序是 SessionHost/Application 排空 → prepared model → SQLite stores → logs。某个关闭失败仍尝试后续资源，报告不能确认清理；configuration runtime 仍为借用对象。

资源归属：组合根拥有上述具体资源；通用宿主只拥有其 Application；Agent 拥有模型 binding、插件注册与其自有资源；Run 拥有本次执行资源。插件不能因为获得 Logger 或窄端口就承担整个共享服务的关闭责任。

## M2-A.6 恢复绑定：保留 v2，不做格式泛化

决策：通用机制不解释持久绑定，所以解除工作区耦合不要求 v3。`HostSessionBinding`、严格字段白名单、SQLite 表/SQL、只读列表投影、旧版本拒绝和现有 snapshot 校验保持原样；不新增泛型 JSON metadata 袋、绑定 codec 注册器或读时规范化。

工作区组合根在第一个相关异步边界前固定其选项；准备资源后，从同一组固定值构造 detached v2 候选和 Agent 创建参数：

- threadId/agentId；definition ID/version；插件 ID/version 及顺序。
- 实际 tools 的 canonical workspaceRoot/effective toolMode。
- 同一个 prepared model 的 selection、connectionFingerprint 和 maxSteps。
- 原 resume 标志，不在 ensure 中重新读取当前 UI/配置。

绑定端口闭包只执行当前语义：

```ts
async ensure() {
  if (resume && !(await stores.bindings.read(binding.threadId))) {
    throw new AgentError("HOST_SESSION_NOT_FOUND", "找不到已绑定的开发会话，不能恢复。");
  }
  await stores.bindings.ensure(binding);
}
```

这是具名端口的实现约定，不是新增存储 API。闭包捕获的 binding 与传给通用宿主的实际配置必须来自同一份快照；零参数接口本身无法证明绑定 A 与运行 B 一致，组合根对此负责。等待 ensure 期间不得发生重新拼装、模型选择漂移或修改创建选项。

必须保持：

| 情形 | 结果 |
| --- | --- |
| resume 且绑定不存在 | `HOST_SESSION_NOT_FOUND`，不补建绑定 |
| 首次创建、无绑定且无任何 thread 持久状态 | 事务写入原 v2 |
| 无绑定但已有 history head（含空批次）或任何 checkpoint 行（含已释放占位） | `HOST_BINDING_MISSING`，不认领旧状态 |
| 已有绑定，任一字段、插件顺序或可选 effort 表达不同 | `HOST_BINDING_CHANGED`，不覆盖原行 |
| 未知 schemaVersion | 沿用 unsupported 错误，不猜测兼容 |
| 原 Query 已有活动写租约 | 内核报告 busy，不自动接管 |

恢复仍由 CLI 选择原 summary.toolMode，并用原 connectionFingerprint 匹配当前签发计划；再次打开必须完整 read/ensure，列表不是授权快照。Key 轮换不改变连接身份；model/endpoint/effort/output budget/步骤预算变化的现有拒绝行为保持。不对已存 root 重新 canonicalize、不补历史默认值、不重新计算历史 fingerprint。

无插件或其他配置的消费者须提供自己的权威绑定实现，确认其权限环境与执行版本；通用模块不提供无校验默认。临时内存实现可用于确定性消费烟测，但必须真正记录并比较绑定候选；它只证明进程内装配，不构成跨进程持久恢复证据。未来如要统一不同配置的列表/持久格式，再单独设计版本化协议，不以本轮预建框架。

## M2-A.7 文件落点、调用方与依赖约束

| 文件/消费侧 | 实施动作 |
| --- | --- |
| `src/agent-host/session-host.ts`（新增） | 公开协议及完整通用装配实现；只依赖 M1 公共入口与标准语言/Web 类型 |
| `src/main/agent-host/workspace-configuration.ts`（新增） | 内聚工作区定义、tools、授权和审批载荷解释；不成为 Agent 内核默认配置 |
| `src/main/agent-host/create-agent-host.ts` | 实际调用新模块，移走重复 Application/执行包装和工作区策略；保留具体资源组合、v2 绑定、getter 与外层关闭 |
| `src/main/agent-host/development-runner.ts` | 继续调用原工作区组合根，审批解析改用具体配置模块；不直接绕过组合根 |
| `host-session-binding.ts`、`sqlite-agent-stores.ts`、`development-sessions.ts` | 保留格式、存储、列表语义，不为本轮修改 SQL/表结构或迁移历史 |
| `configured-model-factory.ts`、`development-setup.ts`、`development-command.ts`、`scripts/run-agent.mjs` | 不改变行为；仅在确有类型/帮助说明受影响时修改，不新增参数或支持范围 |
| `tests/general-agent-development-host.test.ts`、`tests/mimo-token-plan-cn.test.ts` | 仍消费工作区组合根，验证它实际转入通用机制；保留 SDK/本地 HTTP、文件、审批与恢复行为 |
| `tests/general-agent-host.test.ts`、`general-agent-host-binding.test.ts` | 现有主要是 SQLite/绑定回归，不因名称含 host 就整体改为新 SessionHost 测试 |
| `tests/general-agent-development-sessions.test.ts`、两项 CLI integration | 保留只读列表和真实 Electron 跨进程覆盖，不改成纯模型 mock 替代 |
| `tests/general-agent-session-host.test.ts`（新增） | 只消费公开入口，覆盖新边界的配置隔离、绑定拒绝/等待、固定 thread、所有权及创建取消 |
| `tsconfig.node.json` | 明确包含 `src/agent-host/**/*.ts`；不把功能模块加入 web include，不新增项目/workspace |
| M1 `scripts/check-agent-boundaries.mjs` | 扩展同一个定向检查器的模块规则与临时验证，不另建重复检查链 |

边界约束实施要求：

1. `src/agent-host/` 是 `src/agent/` 外部消费者，只能访问 M1 精确公共入口，不给其默认工厂、资源树等内部例外。
2. 为新模块限定精确入口 `session-host.ts`；如以后拆内部文件，其他消费者不得直接进入。该入口可以实现功能，不要求再套转发层。
3. 新模块禁止导入 main/shared/renderer/preload/ppt/tools/models/logs、Electron、Node builtin、厂商 SDK、具体数据库和任意其他运行依赖；其平台独立性由真实依赖图和实际 Node 消费证明，不由文件名或 node tsconfig 中全局 Electron 类型证明。
4. Agent 内核不得反向依赖 agent-host。使用 M1 已有的 tsconfig 模块解析、规范路径和目录包含判断，不能以字符串 `startsWith("src/agent")` 把 `src/agent-host` 误认为内核。
5. 补临时正负消费：host → 公共 Application 通过；host → 默认工厂失败；Agent → host 失败；host → main/tools/Node builtin 失败；旧 main/agent 同名目录仍不误伤。沿用 M1 对 type/re-export/dynamic literal/require 等的覆盖，不以源码字符串测试代替解析。

公开符号有变化前按可用语言服务查 references；当前环境仅配置 Biome，不能宣称它提供 TypeScript 引用分析。实施若无相应服务，使用定向导入检索并阅读全部相关调用方，不能仅凭当前表格遗漏新增消费者。

## M2-A.8 实施顺序

1. **承接 M1**：核对其实际公开入口、资源契约、错误迁移及检查器；记录基线，不重做或绕过第一轮约束。
2. **新增通用实现**：落实 SessionHost 的固定快照、绑定确认、公开 Application 创建、显式转发和幂等关闭；先完成行为，不建空包装。
3. **提取具体配置**：移动工作区指令、tools 装配、授权与批准解析；同一次切换修改 runner 的解释来源，保持原载荷。
4. **组合根切换**：用同一固定装配生成 v2 binding/ensure 与 SessionHost 参数；删除旧重复执行包装，保留当前外部工作区入口和资源所有权。
5. **约束与消费覆盖**：接入新源码 include、已有检查器规则及必要行为测试；保留存储/审批/恢复测试，不扩大白盒例外。
6. **集中验收**：相关行为 → 类型/边界 → 静态检查 → 全量单测 → 实际 Node 消费与 Electron 本地协议/恢复。禁止用放宽 schema、跳过边界、删除有效断言来使检查通过。
7. **证据交付**：验收后才更新状态与命令/场景结果；标记 M2-A 完成时仍将独立包构建、exports、安装消费等 M2 剩余门槛列为未完成。

## M2-A.9 行为验收矩阵

优先复用已有覆盖，只为新风险补确定性测试；不得新增转发 mock 回声、import 数量、源码措辞或文件布局锁定断言。

| 验收面 | 必须观察的结果 |
| --- | --- |
| 显式装配 | 自定义 definition/model/maxSteps、`plugins: []` 可完成对话；模型不可见文件工具，主动请求未安装工具也不能执行 |
| 能力与策略独立 | 同一通用入口安装显式测试能力，宿主策略拒绝时没有副作用；批准场景 waiting/resume 后消费真实结果 |
| 绑定发布顺序 | ensure 挂起期间不能取得可执行宿主，插件 setup/模型 binding 尚未发生；拒绝后无半初始化实例，借用端口仍可使用 |
| 配置快照 | ensure 等待期间修改原 options/definition/model/插件数组不能使实际执行配置漂移；与权威绑定的固定值一致 |
| Thread/恢复边界 | 额外 runtime threadId 不能覆盖固定线程；夹带 takeover 不能接管忙租约；同 Query、新 Run，回答只消费匹配待决交互 |
| 资源所有权 | 创建失败/取消回收已取得插件和 binding；关闭先排空执行；借用 provider/history/checkpoints/绑定端口不被关闭；重复关闭不重复释放 |
| v2 会话兼容 | 使用本轮前的原始 v2 payload/待决记录重开并批准成功，不重写绑定；root/mode/model/预算/版本变化仍拒绝 |
| 持久与列表 | 空历史/占位 checkpoint 仍禁止无绑定认领；只读枚举不创建 DB、不改绑定/检查点、不拿租约；历史幂等/CAS/围栏覆盖保留 |
| 工作区行为 | 两种模式下读取零审批；write/edit 批准前不写，拒绝/取消不写；未安装、越界、文件版本、UTF-8/大小校验不弱化 |
| 平台与隐私 | 新模块实际依赖图无 Electron/main/工具等；SDK 安全错误、终端投影、密钥/reasoning/工具正文隐私保持 |

以下为实施验收命令清单，实际执行组合、结果和证据限制见 M2-A.12，不引用历史数字代替本轮结果：

```text
npx vitest run tests/general-agent-session-host.test.ts tests/general-agent-host.test.ts tests/general-agent-host-binding.test.ts tests/general-agent-development-host.test.ts tests/general-agent-development-sessions.test.ts tests/mimo-token-plan-cn.test.ts
npm run check:agent-boundaries
npm run typecheck
npx biome check <本轮修改的受支持代码文件>
npm test
npx vitest run tests/general-agent-development-cli.integration.test.ts tests/mimo-development-cli.integration.test.ts
npm run agent:dev -- --help
```

Windows 使用 npm.cmd/npx.cmd；命令以 M1 实际接线为前提。Electron 集成按环境跳过必须单列，不能将 skip 计为通过。若首项已有某场景的完整行为覆盖，不额外复制相同测试。

## M2-A.10 实际消费烟测与证据分级

单测或帮助不能证明通用装配已被真正消费。实施需完成两类实际路径：

**A. 普通 Node、无 Electron 的源码公开消费**

- 使用临时入口、临时 Vite SSR 构建目录，`spawn(process.execPath, [builtEntry])` 运行真实 Node 子进程，不用 Electron 或 Vitest 进程内 import 冒充。
- 入口消费 `src/agent-host/session-host.ts` 和 M1 公开协议，显式注入确定性模型、内存历史/检查点及有真实比较逻辑的绑定端口。先 `plugins: []` 完成预期文本，再通过独立会话安装一个非文件临时能力，观察宿主审批、waiting、新 Run resume、预期结果与关闭后借用历史仍可读。
- 构建依赖图不得包含 main/Electron，不能配置 Electron alias/mock 或只把它 external 后宣称无依赖。使用已有定向检查器的解析目标约束并观察 Node 成功执行；不写源码文本断言。
- 此证据证明源码公开消费、机制无固定文件业务依赖和 Node 可运行；不证明跨进程内存恢复、远程模型、独立包或脱离仓库安装。临时能力仅作验收夹具，不新增生产插件。

**B. 原 Node 启动器 → Electron → 原生 SDK/本地 HTTP/SSE**

- 复用现有测试传输适配，仅将固定厂商 URL 转发本地服务；运行真实 Electron/safeStorage、配置模块、工作区组合根、新 SessionHost、SQLite 与 tools。不复制 runner，不扩大远程调用。
- 自建临时工作区与随机校验码，实际 glob→grep→read 后请求 write/edit；批准前文件不存在/不变，EOF 退出时检查 status=waiting 且租约释放。
- 新进程选择原会话，保持原 Query 并使用新 runId，批准后核对真实文件和模型消费结果；独立覆盖拒绝、取消、关闭中断与恢复配置变更拒绝。
- 至少一条恢复路径使用保留的旧 v2 payload 及原 `host.workspace-tool` v1 待决交互，核对恢复前后绑定行未被“升级”；普通 Key 轮换允许，身份/effort/预算/权限环境变化仍拒绝。
- 核对最终检查点、规范历史、租约与错误隐私，不只看退出码或模型自述；EOF、Ctrl+C 和应用关闭不是等价动作。

CLI 无参数/--prompt/--help、/model /new /resume /tools、默认只读、工作区来源、session.ready/逐行 JSON、退出码及 Windows 父子 IPC 握手保持原样；不在 ESM 顶层等待 app.whenReady。help 仍不解析凭据或建宿主。仅清理本轮临时脚本、构建、进程、数据库和工作区，不删除共享记录，不写入生产 out/**。

M2-A 完成要求：通用入口被当前组合根实际消费，无业务插件和显式能力配置均成立；具体配置不进入通用模块；原持久恢复与工作区行为保持，借用资源所有权正确，依赖约束和两类实际证据齐备。独立包、生产 UI/PPT 与动态装配继续列为未实施。

## M2-A.11 参考取舍与方案设计记录（实施前）

- [DeepSeek Harness 架构](https://deepseek-harness.github.io/deepseek-harness/en/reference/) 与 [固定版本生命周期实现](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/vendor/cordis/src/fiber.ts)：借鉴注册归属、初始化完成后发布、持久事实与运行对象分离；不引入 Cordis Context、动态依赖重装、热更新或并发 disposer 完成语义。
- [Spring Framework DI](https://docs.spring.io/spring-framework/reference/core/beans/dependencies/factory-collaborators.html)、[生命周期](https://docs.spring.io/spring-framework/reference/core/beans/factory-nature.html)、[Bean scope](https://docs.spring.io/spring-framework/reference/core/beans/factory-scopes.html)：使用显式工厂参数与闭包，区分借用和所有权，依赖者先停止；不将 Bean scope 映射为 Thread/Query/Run。
- [Spring Boot 自动配置](https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html)：模块提供完整默认实现，宿主显式选择；本轮直接程序化组合，不建条件注解、扫描/发现，也不允许注册冲突静默覆盖。
- [Fowler 配置与使用分离](https://www.martinfowler.com/articles/injection.html#SeparatingConfigurationFromUse)、[Ports & Adapters](https://alistair.cockburn.us/hexagonal-architecture)：支撑宿主配置与机制拆分，不增加空壳服务定位层。
- [Node package exports](https://nodejs.org/docs/latest-v24.x/api/packages.html#main-entry-point-export)：独立包边界留待后续；本轮目录、静态约束和 Node 烟测不能冒充发布验收。

方案设计阶段只更新计划文档，尚未实施 SessionHost 或运行验收；当时已核对组合根、runner、v2 绑定事务/列表、模型指纹、相关测试和 tsconfig。实施阶段承接 M1 的实际公开入口，语言服务引用查询返回无可用服务，随后通过定向调用方盘点、node/web 编译、依赖检查与行为验收完成迁移；实际交付见下一节。

不选择 v3 的理由是当前范围只要求宿主机制可组合，不要求统一管理任意配置的历史目录或序列化格式；保留具体适配边界比引入版本迁移更小、更可核验。若实施发现必须变更格式/权限语义/CLI 支持范围，先修订方案并明确范围，不将其作为接口提取的隐含副作用。

## M2-A.12 实施与验收记录（2026-11-01）

### 实际变更

- 新增 `src/agent-host/session-host.ts`：复用公开 Application，await 前固定配置及端口引用，先确认必需绑定再创建 Agent；固定 Thread、显式转发 run/resume 且不接收 takeover；幂等关闭同步停止受理，只回收自建 Application，不关闭借用服务。
- 新增 `src/main/agent-host/workspace-configuration.ts`：移动原工作区 instructions、tools、workspaceId、授权和 v1 审批解释。未改变定义 ID/version、提示词内容、插件版本或权限行为；runner 复用唯一载荷解释器。
- 当前 `create-agent-host.ts` 已实际消费通用宿主，创建前固定选项，用同一装配产生 v2 binding 与 ensure 闭包；保留原工作区公开入口、binding 快照、模型/SQLite/日志所有权和排空后关闭顺序。原重复执行包装和无消费者 HostRunInput/HostResumeInput 删除，没有旧路径 shim。
- 保留 `host-session-binding.ts`、SQLite 表/SQL、连接指纹、检查点 v1 与私有重放协议，无 v3、无历史迁移。CLI 命令、默认工具模式、工作区来源及生产链路不变。
- 新增 `general-agent-session-host.test.ts`，覆盖新边界的 23 项行为；node tsconfig 明确包含新模块。边界规则同时维护平台独立性；中英文 README 补充实际公开消费与所有权说明。

### 实际执行结果

| 检查/场景 | 本轮观察结果 |
| --- | --- |
| 边界隔离矩阵 | 47 个独立场景通过；修复两项 P2 并验证 M2-A 正反向依赖 |
| 新 SessionHost 行为回归 | 修正后 23 项全部通过；覆盖无插件/缺失工具、必需授权/绑定、ensure 等待与配置快照、审批/拒绝/取消、固定 Thread/禁止接管、创建回滚、晚到 binding 和活动关闭排空 |
| 原相关行为回归 | 首轮 10 文件运行中原 9 文件全部通过；新增文件有两处断言错误，修正后单独及全量通过，未修改原行为以适配断言 |
| `npm.cmd run typecheck` | 最终边界检查及 node/web 两个 TypeScript 项目通过 |
| Biome | 本轮 7 个代码/配置文件检查通过，命令同时修复 4 个文件的格式 |
| `npm.cmd test` | 192 个文件、1632 项通过，2 项按既有条件跳过 |
| 两个真实 Electron CLI 集成文件 | 2 项通过、无跳过；配置/真实 safeStorage 重开、本地原生 SDK/HTTP/SSE、EOF waiting、新进程恢复、拒绝/取消、配置变更拒绝与租约释放 |
| `npm.cmd run agent:dev -- --help` | 真实 Node 启动器构建并启动 Electron 帮助成功，未启动生产 UI |
| 实际普通 Node 公开消费 | Vite 构建依赖图无 main/Electron；spawn(process.execPath) 完成无插件对话和非文件 ledger 能力 waiting→resume→completed，真实余额为 11；宿主关闭后借用历史仍可读取 |
| 旧 M1 产物跨进程恢复 | 从提交 `2519fc9` 加载原 runner/组合根留下真实 v2 waiting，再由当前实现新进程批准；一次发现、三次模型请求，实际 glob/grep/read 零读取审批、写入一次审批；批准前无文件，批准后随机校验码匹配 |
| 原 v2 权威记录不变 | 上一场景直接检查 SQLite：原 `host.workspace-tool` v1 待决交互被消费，绑定 payload 原文字节不变、Query 不变而 Run 更新，最终检查点 completed 且无活动租约 |

新增测试首轮的两处错误断言没有驱动生产行为变更：工具结果应核对规范历史，不能误认为 assistant 输出投影包含工具消息；创建取消不锁定内部异常码，改为验证不发布实例、已取得资源释放且借用端口仍可用。不重新钉住工具错误措辞或内部取消表示。

Node 烟测使用确定性模型与有比较/回执/CAS/围栏语义的进程内夹具，只证明通用源码装配；不声称内存端口具有跨进程持久性。持久恢复证据来自真实 Electron/原生 SDK 到本地 HTTP/SSE 及真实 SQLite，包括旧提交留下的权威记录。上述本地证据均不代表远程模型新验收。

临时边界矩阵、Node 入口/构建、旧版消费脚本、子进程、临时工作区与数据库均已清理；没有访问或迁移生产会话，没有打印真实凭据、没有调用远程厂商，未将夹具写入生产 out/**。

结论：两项 M1 审核缺陷已修复，M2-A 源码级通用装配切片完成。M2 的独立包构建、受控 exports、脱离仓库安装消费仍未实施；M3 扩展通用验收与 M4 生产/PPT 消费迁移不由本轮宣布完成。宿主绑定端口是受信任组合根的校验责任，不是恶意插件沙箱。

