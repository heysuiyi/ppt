# M1：Harness 公开面收敛

[返回计划目录](README.md) · [项目整体规划](../project-plan.md)

## M1.1 目标、范围与非目标

本轮将现有 `src/agent/` 收敛为可受控消费的公开功能与扩展协议，不重新实现运行时，不新建 `Harness` 或 `Assistant` 空壳，不引入 IoC 容器。交付同时包含公开面、调用方迁移、资源能力收窄、静态依赖约束和运行证据；只有入口文件而没有约束与实际消费，不算完成。

纳入范围：

1. 明确现有具名入口及其公开符号，拆开公共协议与内部执行协议。
2. `PluginContext.scope` 改为公开的窄 `PluginScope`，安装器不再传出完整资源树对象。
3. 明确错误、无损协议快照和值比较的公共语义，迁移全部新内核相关调用方，删除失效路径。
4. 用解析到真实目标文件的静态检查维护内外依赖方向，并接入现有类型检查与构建链。
5. 迁移外部消费测试，保留有明确目的的白盒覆盖；运行公开入口消费烟测与现有恢复回归。

不纳入范围：

- 不分离工作区指令、插件选择、按工具名授权和宿主生命周期；这是第二轮装配工作。
- 不改变 `HostSessionBinding` v2、检查点 v1、数据库结构、模型重放格式、交互载荷及定义/插件版本。
- 不切生产 UI，不迁移生产历史，不删除旧 Agent/Gateway，不迁移 PPT、Skill 或子 Agent。
- 不新增 provider、重试、并行调度、压缩、动态插件依赖、热更新、服务定位器、扫描或配置语言。
- 不新增包/workspace，不承诺可独立发布；Node `exports` 和独立消费属于 M2。本轮不批量搬目录或改名。

## M1.2 实施前现状与必须保留的机制

| 代码位置 | 已核实事实 | 本轮处理 |
| --- | --- | --- |
| `application/agent-application.ts`、`application/default-agent-factory.ts` | 默认装配已在 Agent 内部；顺序安装插件、绑定模型、seal 后发布，失败回收 | 保留实现和顺序，只明确前者为受支持功能入口、后者为内部实现 |
| `extensions/plugin-contract.ts`、`extensions/plugin-manager.ts` | 插件拿到具体 `ResourceScope`，可见 `child()`、`dispose()` | 改公开能力协议与传入对象，不改资源树算法 |
| `tools/tool-contract.ts` | 工具扩展定义与 `ToolExecutor` 混在同一文件；`ToolCompletion` 被公开事件与持久数据引用 | 只拆出内部执行协议，公共类型依赖保持闭合 |
| `protocol-utils.ts` | 同时承担具名错误、安全投影、JSON 快照与值比较；宿主确实使用这些语义 | 分到具名公共协议文件，不复制、不静默替换算法 |
| `src/main/agent-host/` | 七个文件消费 `protocol-utils`；通过 Application 创建 Agent | 迁移公共操作的来源，不改变宿主行为 |
| `src/models/`、`src/tools/` | 已消费具名模型、插件和工具协议 | 合法入口保持原路径；只随协议拆分调整受影响处 |
| `biome.json`、node/web tsconfig | 有部分导入限制，但没有基于目标文件的 Agent 封装门槛 | 增加一个定向依赖检查，不将目录或 tsconfig include 冒充访问控制 |
| 现有测试 | 恢复测试仍直接用默认工厂；基础工具取消测试需观察工具完成而非 Agent 终态 | 前者改公开 Application；后者保留精确白盒例外 |

资源所有权仍按 Application → Agent → Run 管理；宿主提供的模型工厂、历史与检查点端口是借用对象。Agent 拥有模型 binding、插件资源和注册；Run 拥有本次取消及临时资源。Thread/Query/Step 的持久事实不进入资源树。

## M1.3 公开路径与协议闭包

下表是实施后的完整受支持源码入口集合，不是待新增的一组转发文件。路径均相对 `src/agent/`；已有入口保持位置。第一轮以这些精确路径维护边界，不允许按整个目录开放。

| 受支持入口 | 公开内容 | 运行时属性 |
| --- | --- | --- |
| `application/agent-application.ts` | `createAgentApplication`、`AgentApplication` | 功能入口，内部拥有默认创建/关闭装配；不转导出默认工厂 |
| `agent-contract.ts` | `Agent`、`AgentDefinition`、`AgentRunInput`、`AgentResumeInput`、`AgentRunHandle`、`AgentRunResult` | 纯类型 |
| `agent-factory.ts` | `AgentCreationOptions`、`AgentServices`、`AgentFactory` | 纯类型，保留具名端口，不引用具体内部类 |
| `protocol-values.ts` | 现有 JSON、版本载荷、身份、交互、`Disposable` 类型；移入 `snapshot`、`sameValue` | 无宿主依赖的值操作；校验函数不导出 |
| `protocol-errors.ts`（新增） | 从旧文件移动 `AgentError`、`asProtocolError` | 唯一公共错误实现，纯平台无关运行时代码 |
| `extensions/plugin-contract.ts` | `AgentPlugin`、`PluginContext`、`PluginScope`、`PromptContext`、`PromptContribution`、`PromptRegistrar` | 纯类型，不再引用资源树类 |
| `model/model-contract.ts` | 现有模型选择、内容、消息、请求/响应/流、能力、调用上下文、client/binding/factory/registrar 全部导出类型 | 纯类型，重放状态仍对内核不透明 |
| `tools/tool-contract.ts` | 上下文、授权、影响、结果、挂起、即时/可恢复工具定义、工具联合与 registrar，以及 `ToolCompletion` | 纯类型；保留 `ZodType` 的 type-only 依赖 |
| `session/session-contract.ts` | 现有历史与存储、工具调用/完成持久记录、inflight/pending 数据、`AgentCheckpoint` 全部导出类型 | 存储适配扩展协议，不是允许宿主覆盖恢复快照 |
| `session/checkpoint-contract.ts` | 现有 key/lease/acquire/save/store 全部导出类型 | 纯类型，保留 CAS、围栏和显式接管语义 |
| `session/session-events.ts` | `RuntimeFactEvent`、`RuntimeStreamEvent`、`RuntimeEvent` | 纯类型，观察事件不升级为持久事件日志 |

其中 `ToolCompletion` 必须公开：`RuntimeEvent` 和 `StoredToolCompletion` 都引用它。检查点及其嵌套记录必须可由存储适配器表达；不能为了缩小导出数量而隐藏这些协议，或将其改为 `unknown`。公开不意味着可向终端直接序列化私有重放状态。

`ToolExecutor` 与 `ToolExecutionResult` 移到新内部文件 `tools/tool-executor.ts`；该文件只含内部协议。`tool-pipeline.ts`、`DefaultAgent`、运行控制器和必要白盒测试改用新来源。旧 `tool-contract.ts` 不保留重导出、兼容别名或重复定义。

`ToolDefinitionFields`、`AgentCheckpointBase` 等未导出的组成类型无需机械改成导出。公共签名的类型依赖可以在同一受支持协议模块内表达，但不得沿声明依赖链进入资源树、Registry、管线或默认实现。

## M1.4 插件生命周期能力

在 `extensions/plugin-contract.ts` 定义：

```ts
export interface PluginScope {
  readonly signal: AbortSignal;
  own(resource: Disposable): void;
}
```

`PluginContext.scope` 使用该接口；`models/tools/prompts` 三个 registrar 保持现状。不新增服务获取、父作用域访问、子作用域创建或容器管理方法。

安装器为每次插件安装创建独立窄对象：

```ts
const pluginScope: PluginScope = {
  signal: scope.signal,
  own(resource) {
    scope.own(resource);
  },
};
```

`setup()` 接收 `scope: pluginScope`，而不是将 `ResourceScope` 仅做类型断言后原样传入。每次安装只构造一次能力对象，不在工具调用热路径上包装或分配。

保持以下契约：

- 插件可以托管其已经取得所有权的资源；不能通过注入就接管共享宿主服务。
- 插件仍可取得注册返回的 `Disposable`，仅撤销自己的注册；整个插件作用域由安装器管理。
- 同一插件对象的不同安装具有独立资源归属，不能共享可变作用域。
- setup 失败回收整次安装已取得的资源；setup 中取消、关闭重入、晚到模型绑定的处理不退化。
- scope 已关闭时 `own()` 继续拒绝；不得改成静默接受或替插件自动关闭未知借用对象。
- 关闭前先中断并排空执行，再释放依赖；不照搬上游并发 disposer 完成顺序。
- 窄对象不是恶意插件沙箱，不阻止受信任进程内代码通过其他引用执行操作。

不增加插件生命周期状态机或 `start/stop/refresh` 钩子；保留“安装贡献 → 绑定模型 → seal → 发布”和创建失败回滚。

## M1.5 错误与协议值操作的迁移

从 `protocol-utils.ts` 移动实现，不重新实现：

- `AgentError`、`asProtocolError` → `protocol-errors.ts`；所有内外调用方使用同一个类。未知原生异常仍投影为既有通用失败，不泄露 SDK 异常、路径、密钥或堆栈。
- `snapshot`、`sameValue` 及私有校验辅助函数 → `protocol-values.ts`；后者可值导入 `AgentError`，`protocol-errors.ts` 仅 type-import `ProtocolError`，不形成值循环。
- `snapshot` 保留既有无损 JSON 拒绝规则及 detached snapshot 行为；`sameValue` 保留现有比较语义，不改成直接 `JSON.stringify` 比较。使用方仍需满足协议值前提，不新增一套任意 JavaScript 对象比较规范。

迁移完全部引用后删除 `protocol-utils.ts`，不保留旧路径重导出。凭据解析、MiMo 安全错误转换、历史批次去重与绑定比较只改 import，不改变行为和错误码。

## M1.6 调用方与测试迁移

| 消费侧 | 实施动作 |
| --- | --- |
| `src/agent/**` | 错误/值操作切换来源；内部执行协议切换；插件管理器使用窄对象 |
| `src/main/agent-host/` | `configured-model-factory`、`create-agent-host`、`development-command`、`development-runner`、`development-setup`、`host-session-binding`、`sqlite-agent-stores` 迁移错误/值操作 import；保留现有 Application 入口 |
| `src/models/**`、`src/tools/**` | 已合法的协议路径不改；工具资源清理继续经 `scope.own()`，不要求新工厂或别名 |
| shared/Renderer/preload 的间接类型消费 | 保持模型及值协议无 Node/Electron/SDK 依赖；核验 web 类型检查，不把功能入口引入浏览器协议链 |
| `general-agent-runtime.test.ts` | 改用 `createAgentApplication(...).agents.create(...)`；登记并关闭 Application，保留持久恢复、未知副作用、丢失收据、步数、流完成与错误隐私断言 |
| `general-agent-lifecycle.test.ts` | Agent 生命周期行为改用 Application 创建；事件通道的实现测试仅保留对 `runtime/event-stream.ts` 的白盒访问 |
| `general-agent-infrastructure.test.ts` | 保留资源、注册、安装回滚与工具管线的实现测试，内部类型改来源；不将这些依赖提升为公共 API |
| `base-tools.test.ts` | 主要消费已有公开 Application；取消测试仍允许直测管线，以区分工具是否响应取消，不能用 Agent cancelled 终态替代真实工具结果 |
| MiMo、宿主、存储及 CLI 测试 | 迁移受影响 import，不重写无关场景，不重新钉住源码措辞 |

白盒例外按“具体测试文件 → 具体目标文件”登记：

- `general-agent-infrastructure.test.ts`：`extensions/plugin-manager.ts`、`extensions/prompt-registry.ts`、`model/model-registry.ts`、`scope/resource-scope.ts`、`tools/tool-pipeline.ts`、`tools/tool-registry.ts`，以及拆分后确需的 `tools/tool-executor.ts`。
- `general-agent-lifecycle.test.ts`：仅 `runtime/event-stream.ts`。
- `base-tools.test.ts`：取消结果观察所需的 plugin manager、prompt/model/tool registries、resource scope、tool pipeline，以及 `tools/tool-executor.ts`。

这些例外不允许向普通源码转导出内部符号。实施时若发现其他直接消费者，必须按行为职责迁移或说明具体白盒目的，不能给 `tests/**` 整体豁免，也不能借机删除有意义的边界覆盖。

## M1.7 静态封装的实现选择

新增 `scripts/check-agent-boundaries.mjs`，复用已有 TypeScript 开发依赖，作为定向依赖检查器，不建设通用架构规则框架。原因：新 `src/agent/`、旧 `src/main/agent/` 和 Renderer 的 `agent/` 目录重名；当前 Biome 字符串 glob 不能替代按 tsconfig 解析后的模块身份。避免用 `**/agent/**` 误伤旧链路或通过另一条相对路径绕过。

检查器要求：

1. 使用 TypeScript config API 读取 node/web tsconfig，按各自编译选项解析模块；合并去重源码身份。使用平台一致的绝对规范路径与大小写规则，识别实际位于本仓库 `src/agent/` 的目标，不能靠 `startsWith("src/agent")` 误匹配其他目录。
2. 分析静态 import、type-only import、re-export、import type 表达式、字面量动态 import 和字面量 require。检查器覆盖编译项目内源码及测试；同一文件在两个项目中的不同解析结果都要校验。
3. Agent 外部只能依赖 M1.3 精确入口；拒绝经相对路径、别名或转导出进入内部实现。白盒例外仅允许指定源/目标组合，不扩成前缀开放。
4. Agent 内部只允许模块内部依赖及当前已有 `zod` 依赖；拒绝宿主、业务、Electron、Node builtin、具体数据库、厂商 SDK 等反向依赖。不顺带给其他模块建立新的依赖体系。
5. 公共纯类型协议只能 type-import 其他公共协议和 `zod` 类型；`protocol-values/errors` 可以有相互之间的受控 type/value 依赖，但不得带入默认运行时。功能入口可依赖内部实现，不适用纯协议规则。
6. 对本模块及公共协议闭包的未解析导入明确失败，不静默跳过；不将无关旧模块的解析问题包装为 Agent 边界错误。非字面量模块加载不能宣称已静态证明：本轮禁止 Agent 内部使用，并要求所有指向 Agent 的依赖使用可解析字面量；这不是任意 JavaScript 加载行为的安全隔离。
7. 输出源文件、位置、解析目标和违反规则，退出非零；允许集合只有一份，不再用 Biome 复制同一套 Agent 白名单。现有配置模块、tools 的 Biome 限制保持有效。

增加 `npm run check:agent-boundaries`，将其接入 `typecheck` 的前置步骤；现有 `build` 依赖 `typecheck`，因此构建自动执行约束，不重复增加另一条检查链。不改默认测试排除策略，不把开发测试/夹具混进生产 `out/**`。

实施中用临时小消费程序验证检查器：合法公共 type import 通过；私有值/type import、re-export、动态字面量导入、别名绕过和内核反向依赖失败；现有旧 `main/agent` 导入仍通过；白盒例外不得传播到普通源码。临时程序置于隔离目录，验证后删除。不写源码字符串、导出数量或 import 次数断言。

## M1.8 实施顺序与文件落点

按依赖顺序完成，所有代码改完后集中运行验证，不在每次移动后全量跑检查：

1. **协议拆分**：新增 `protocol-errors.ts`、内部 `tools/tool-executor.ts`；迁移公共值操作；完成内核及外部引用迁移，删除旧 utils 路径与旧内部类型导出。
2. **插件边界**：在 plugin contract 定义 `PluginScope`，plugin manager 传窄对象；保持默认工厂与资源回收机制不变。
3. **消费测试**：运行时与生命周期测试改从公开 Application 创建；保留上节明确的内部覆盖，不增加生产兼容路径。
4. **静态约束**：实现定向脚本与 npm 接线；验证合法、非法及旧链路边界，不把扫描文件数量当验收结果。
5. **集中验收**：依次运行相关行为、node/web 类型与依赖检查、静态检查、全量单测、实际入口/恢复烟测；失败先定位，不用删除行为断言让检查变绿。
6. **交付记录**：仅在验收后更新本计划和整体规划的实际状态，记录命令、场景、通过/跳过/失败及证据限制；不提前标记 M1 完成。

现有 `application/agent-application.ts` 被明确支持后无需搬到根目录或增加包装工厂。`src/main/agent-host/` 在本轮仍是固定工作区运行配置；这不阻止通过公开 Application 验收无插件配置，但不能据此宣布 M2 已完成。

## M1.9 验证方案与通过条件

### 行为回归

优先复用现有 `general-agent-infrastructure`、`general-agent-lifecycle`、`general-agent-runtime`、`base-tools`、`general-agent-host`、`general-agent-host-binding`、`general-agent-development-host`、`general-agent-development-sessions`、`mimo-token-plan-cn` 等测试。只为新增的不确定边界补行为测试，不重复既有路径；安装失败回收、关闭排空和错误隐私断言不得缩成“未抛错”。

| 验收面 | 必须观察的结果 |
| --- | --- |
| 无业务插件消费 | `plugins: []` 通过公开 Application 运行普通对话；模型拿不到未安装工具，主动请求未安装工具也不能执行 |
| 资源边界 | setup 失败和 Agent/Application 关闭回收已托管资源，借用端口不被误关；同一插件多次安装互不污染；创建取消不留下可运行实例 |
| 类型边界 | 临时外部插件无需导入/实现 `ResourceScope`；`scope.child/dispose` 无法通过公共类型调用；模型、工具、存储协议可从支持路径完整消费 |
| 存储与恢复 | Query 不变、新 Run；待决回答匹配且不重复消费；步数不重置；CAS/围栏、丢失历史收据、unknown/applied 语义保持 |
| 错误与值 | 单一 `AgentError` 身份及安全投影保持；无损 JSON 拒绝和快照隔离保持；历史 batchId 同内容幂等、不同内容冲突保持 |
| 授权与文件 | 只读自动允许、写入逐次审批；批准前不写，未安装/越界访问拒绝；文件版本与 UTF-8/大小校验不弱化 |
| 静态约束 | 公开路径通过，私有导入与反向依赖失败，旧 Agent 同名路径不误伤，白盒例外不外泄 |

集中验证命令如下；本轮实际执行结果见 M1.12，不引用前序验收数字代替：

```text
npx vitest run tests/general-agent-infrastructure.test.ts tests/general-agent-lifecycle.test.ts tests/general-agent-runtime.test.ts tests/base-tools.test.ts tests/general-agent-host.test.ts tests/general-agent-host-binding.test.ts tests/general-agent-development-host.test.ts tests/general-agent-development-sessions.test.ts tests/mimo-token-plan-cn.test.ts
npm run typecheck
npx biome check <本轮修改的受支持代码文件>
npm test
npx vitest run tests/general-agent-development-cli.integration.test.ts tests/mimo-development-cli.integration.test.ts
npm run agent:dev -- --help
```

Windows 使用对应 `npm.cmd`、`npx.cmd`。Electron 集成被环境条件跳过不算通过，须明确记录并以可运行的等价实际场景补证；不能把旧 `test:integration:agent` 当成新宿主验收。

### 实际运行，不以单测或帮助代替

使用临时工作区、临时数据库与既有受控模型方式，不调用远程厂商、不触碰生产配置或数据库：

1. 临时独立消费程序仅从公开入口创建 Application，先不安装业务插件；执行一次对话并观察规范历史与关闭。随后在独立 Agent 安装 `createTools`，观察实际随机校验码文件读写和工具结果，不以模型自述代替文件核对。
2. 实际 Node 启动器 → Electron 开发宿主 → 原生 MiMo SDK → 本地 HTTP/SSE，执行 glob/grep/read 后请求写入；只读零审批，EOF 保留 waiting，批准前目标文件不存在。
3. 新进程恢复原 Query，使用新 runId 回答权威待决交互；批准后内容匹配校验码，记录规范消息与最终检查点，并确认无活动租约。拒绝和取消分别在独立临时会话覆盖。
4. 补一次关闭中断与依赖排空观察；取消不当作关闭，Ctrl+C 不当作 EOF 恢复。若既有实际入口集成已覆盖某场景，可复用该证据，不再重复远程调用。
5. 仅清理本次进程、临时脚本、会话、工作区与构建缓存。报告受控模型、本地真实 SDK/HTTP 与远程厂商三类证据，不混称真实模型验收。

M1 完成要求：上述功能/扩展入口可用且内部绕过受约束，全部相关调用方迁完，无旧路径 shim，无业务插件与文件插件两类公开消费成立，既有执行和恢复语义保持。模块可独立发布、宿主配置可组合及生产切换都不属于本轮完成声明。

## M1.10 参考来源与取舍

- [DeepSeek Harness 架构与 Session log](https://deepseek-harness.github.io/deepseek-harness/en/reference/)：区分持久事实、运行事件和能力扩展；不直接采用其 SessionEvent 格式或恢复算法。
- [固定版本 plugin 生命周期实现](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/vendor/cordis/src/fiber.ts) 与 [vendoring 说明](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/vendor/README.md)：借鉴贡献归属与初始化发布；不引入动态依赖重装、配置 HMR 或整个 fork，不将其异步回收顺序替代本项目契约。
- [Spring Framework 依赖注入](https://docs.spring.io/spring-framework/reference/core/beans/dependencies/factory-collaborators.html)、[生命周期](https://docs.spring.io/spring-framework/reference/core/beans/factory-nature.html)：借鉴显式工厂参数、完整初始化及依赖者优先停止；不建立 BeanFactory，不把 Bean scope 映射为 Query。
- [Spring Boot 自动配置](https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html)：默认实现由模块内聚，显式选择在组合边界完成；本轮不实现条件装配或扫描，第二轮再处理具体配置。
- [Fowler：配置与使用分离](https://www.martinfowler.com/articles/injection.html#SeparatingConfigurationFromUse)、[Ports & Adapters](https://alistair.cockburn.us/hexagonal-architecture)：用于约束依赖方向，不增加空壳适配层。
- [Node package exports](https://nodejs.org/docs/latest-v24.x/api/packages.html#main-entry-point-export)：未来包边界仍需配合相对路径约束；本轮不以新增 exports 冒充独立包。

## M1.11 方案设计记录（实施前）

方案设计阶段只更新实施方案及整体规划，没有将设计当作验收。已核对公开签名、宿主/模型/tools 消费、现有行为测试及静态检查能力；LSP 无可用语言服务器，调用方盘点使用定向导入检索与相关代码阅读。实施时再次查询引用仍返回无语言服务器，随后通过定向导入盘点、编译和边界检查完成迁移验证。

## M1.12 实施与验收记录（2026-11-01）

### 实际变更

- 已按 M1.3 精确路径收敛消费边界，保留现有 Application 功能入口，没有新增包装工厂、聚合入口或容器。
- 新增 `protocol-errors.ts`，唯一错误类与安全投影原样迁移；快照、JSON 校验与值比较迁入 `protocol-values.ts`。内核、七个宿主文件和相关测试已迁移，旧 `protocol-utils.ts` 已删除，无兼容重导出。
- 新增内部 `tools/tool-executor.ts`，移入 `ToolExecutor/ToolExecutionResult`；`ToolCompletion` 留在公共协议，事件及检查点载荷没有变化。
- 插件得到独立的 `PluginScope` 窄对象，仅有 `signal/own()`；资源树、注册回滚与关闭顺序保持原机制。新增行为回归验证同一插件多次安装的取消/资源归属互不污染，以及关闭后托管拒绝且不误关未接收资源。
- 运行时与 Agent 生命周期回归改由公开 Application 创建并登记回收；保留方案列出的精确白盒访问。
- 新增 `scripts/check-agent-boundaries.mjs` 与 `check:agent-boundaries`，接入 `typecheck`；`build` 经现有链包含检查。按两份 tsconfig 解析实际目标，核查公共协议闭包、反向依赖和白盒导出泄漏。类型来源按声明/符号身份去重，避免展开递归泛型导致栈溢出；不是任意 JavaScript 值流或计算加载的安全分析器。
- `tsconfig.web.json` 补入新增错误协议，保证公共值操作的浏览器编译闭包；Biome 仅显式纳入这一个新 `.mjs` 检查脚本，没有扩大到其他旧脚本或复制 Agent 白名单。中英文 README 已补充消费边界。

### 本轮执行结果

| 检查/场景 | 实际结果 |
| --- | --- |
| M1.9 所列九个相关行为回归文件 | 152 项通过，1 项按既有条件跳过 |
| `npm.cmd run typecheck` | 模块边界检查及 node/web 两个 TypeScript 项目全部通过 |
| Biome：新脚本、package/config、Agent、开发宿主与四个受影响测试文件 | 42 个受支持文件通过；迁移产生的三处格式差异已修复 |
| `npm.cmd test` | 191 个文件、1609 项通过，2 项按既有条件跳过；没有运行远程厂商集成 |
| 两个独立 Electron CLI 集成文件 | 2 项通过、无跳过；覆盖凭据重开、原生 SDK/本地 HTTP/SSE、EOF waiting、新进程恢复、拒绝、取消、配置变更拒绝与租约释放 |
| `npm.cmd run agent:dev -- --help` | 实际 Node 启动器构建并启动 Electron 帮助成功；没有启动生产 UI |
| 独立公开消费程序 | 无插件普通对话完成；模型看不到未安装工具，主动调用缺失工具被拒绝；借用 SQLite 端口在 Application 关闭后仍可读取 |
| 公开消费类型检查 | 外部结构对象可实现 `PluginScope`，无需内部类；`child/dispose` 的负向类型断言成立 |
| 独立公开文件消费与关闭烟测 | 实际 glob→grep→read→write；批准前无文件；重新打开存储后批准，随机校验码匹配、原 Query/新 Run、完成检查点和释放租约均核验；关闭返回 interrupted，先排空模型再关闭 binding 与插件资源 |
| 独立 Electron → SDK → 本地 SSE 烟测 | 一次模型发现、三次模型请求；实际 glob/grep/read 零只读审批，写入 EOF waiting；新进程批准后文件内容匹配随机校验码，Query 不变、Run 更新、完成检查点无活动租约 |
| 隔离依赖反例矩阵 | 25 个场景通过，包括合法公开消费/旧同名目录、私有值/类型/重导出/import type/动态字面量/require/别名、未解析 Agent 依赖、内核反向依赖与非字面量加载、协议闭包、精确白盒及别名/实例/包装导出泄漏、node/web 不同解析 |

测试条件跳过不视为已验收对应平台行为。本轮两项既有跳过均保留原条件；实际 Electron 集成及独立烟测没有跳过。静态反例和公开消费使用临时程序，不新增锁定源码措辞、导出数量或文件布局的永久测试。

没有读取或修改生产会话数据、没有复制或打印真实 Key、没有调用远程厂商；本地真实 SDK/SSE 结果不能作为远程模型新验收。生产打包与跨包发布未在本轮执行。临时程序使用独立数据库、工作区与构建目录，仅清理本次创建的资源。

原始交付结论（修复前）：M1 当时报告完成，M2-A 尚待实施。随后审核发现导出类型图及三斜线引用两项门禁漏检；不以本节原有通过数字证明它们已覆盖，修复和补充验收见 M1.13。当前第二轮交付见 M2-A.12，旧生产 Agent、PPT、Gateway 继续独立运行。

## M1.13 审核问题修复与门禁补充验收（2026-11-01）

已修复审核的两项 P2：

1. **白盒导出类型图遗漏**：补查导出类/接口基类型，以及未实例化泛型条件类型的判断、约束和分支；对相关 mapped/indexed 类型与泛型默认值同样沿类型来源分析。按类型、符号、声明和本地类型语法节点去重，不展开外部 Zod 声明造成无界递归。白盒导出派生内部类或条件类型别名不再通过。
2. **三斜线依赖遗漏**：提取 SourceFile 的 types/path/lib 引用指令，按 TypeScript 实际目标解析后复用依赖规则；缺失目标在受管模块明确失败。允许合法公共路径与标准 Web/ES lib，拒绝 Node types、main 声明或私有 Agent 路径；不是一律禁用三斜线。

同一检查器增加 M2-A 的精确 `src/agent-host/` 模块边界及 `session-host.ts` 入口。没有新增重复检查链、包导出白名单或扩大白盒例外。

本轮临时隔离矩阵实际通过 **47 个场景**：包括两项原始漏检、合法引用、未解析引用、白盒泛型/继承/包装导出、原私有导入及反向依赖、旧同名目录，以及 host 的公共消费、私有路径、main/tools/models/logs/Node/Electron/非字面量加载正反例。矩阵调用真实边界检查器，不通过源码措辞或导入数量断言；临时脚本及其隔离目录已删除。最终 `npm.cmd run typecheck` 再次通过边界及 node/web 编译检查。

本补充只证明所述静态约束，不声称能阻止任意计算值流或隔离恶意进程内插件。运行时、实际消费和恢复验证共用 M2-A.12 所列本轮证据。

