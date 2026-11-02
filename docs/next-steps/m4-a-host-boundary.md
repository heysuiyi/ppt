# M4-A 执行计划：中立宿主契约与双端展示边界

状态：A0～A5 已实施并完成本地验收，证据见第 9 节。共享宿主与终端配置适配已分离；Core 协议、binding 与持久格式未改，B～E 不因本切片自动完成。所属阶段见 [M4 总计划](m4-host-consumption.md#5-执行切片)，持续约束见 [AGENTS.md](../../AGENTS.md)。

## 1. 交付目标与明确决策

M4-A 解决的是现有双宿主共享机制被终端契约和 CLI 配置流程包裹的问题，不重做首次接入，也不另造 SessionHost。

本轮采用以下确定方案：

1. **保留 `cli/host/` 物理落点**：中立 Node 机制仍在现有目录内，以精确入口及解析依赖图约束职责，不新建 host workspace，不搬迁整个 SQLite/模型子树。目录位置不是长期模块归属的结论。
2. **拆分 NodeHost 与 TerminalHost**：前者只包含会话、模型目录、执行、交互解释与关闭；后者是 CLI 消费端口，额外拥有连接设置及启动配置交互。桌面只消费前者。
3. **CLI 适配层拥有终端向导与凭据保护选择**：共享 NodeHost 必须接收配置实例，不在桌面路径创建 DPAPI 或备用配置。桌面继续借用 safeStorage 配置；CLI 仍使用独立 DPAPI 配置。
4. **共享安全事实，分离端侧呈现**：模型/历史/交互具名中立类型由 host 拥有；JSONL、ANSI、终端布局、退出码由 CLI 拥有；HarnessDesktopApi/React 状态由桌面拥有。不引入跨端万能事件或展示协议。
5. **保持可观察兼容性**：CLI JSONL version、字段、错误码和现有文本控制字符转义行为、桌面 IPC 结构、binding 指纹与持久格式均不在本轮主动修改。类型归属调整不等于数据版本升级。

不做 M4-B 的完整窗口竞争治理、M4-C 的完整兼容认证、M4-D 的旧 Agent 退出、M4-E 的全部打包验收；A 只承担自身改动所需的双端烟测与旧 waiting 兼容验证，不能把风险留给下一切片。

## 2. 实施前已核对的现状

| 落点 | 本次静态观察 | 设计影响 |
| --- | --- | --- |
| `cli/host/host-contract.ts` | TerminalHost 同时定义 run/resume、会话、模型、配置向导与 TerminalSetupIO；依赖 terminal-contract | 需要拆端口，不是把所有 Terminal 前缀改成 Host |
| `cli/host/node-host.ts` | 返回 TerminalHost；创建配置/默认 Node 凭据保护；`open()` 可调用配置向导；内部已有 exclusive/active/transition/close 控制 | 保留执行准入和关闭机制，移出 CLI 设置职责 |
| `model-catalog.ts` | ConfiguredModelItem 继承 TerminalModelItem；本地就绪不代表远程连接成功 | 中立化模型类型，保持现有就绪判断与连接指纹 |
| `session-history-projection.ts`、`session-persistence-contract.ts` | 输出 TerminalHistoryEntry，持久摘要依赖 TerminalToolsMode | 换类型归属，保留已确认历史前缀、规范位置和工具结果含义 |
| `model-setup.ts` | 固定 CLI 提示/选择、secret 输入及配置写入，使用 TerminalSetupIO | 属于 CLI 适配依赖图，不作为双宿主共享功能 |
| `app/main/agent-host/desktop-host.ts` | 导入 TerminalHost、terminalError、terminalInteractionDisplay、sanitizeTerminalText | 桌面改用中立宿主和纯安全投影，不经过终端事件/布局模块 |
| `cli/terminal/terminal-text.ts` | 控制字符转义与 string-width、字素分割、折行混在同文件 | 只抽取无环境依赖的安全文本策略，不把宽度/折行搬到共享层 |
| `scripts/check-cli-boundaries.mjs` | 已阻止 CLI 依赖 app/src、terminal 运行时直连 host 实现；未约束共享 host 对 terminal 的反向依赖 | 扩展现有门禁，不能通过放宽全部 terminal→host 运行时依赖接通安全函数 |
| `cli/tsconfig.json`、`cli/build.mjs` | CLI rootDir 为当前目录，tsc 产物入口为 `cli/dist/main.js` | 留在现有编译树避免无必要的构建/启动协议改造 |

本次查询 LSP references 返回“无语言服务器”；随后通过目标搜索核对现有引用分布。该结果不等于已完成所有导出符号的语义级引用核查；实施前若 LSP 可用应重新查询，否则以解析导入图、类型检查及构建消费交叉确认。

## 3. 目标契约

以下是拟实施的仓库内部模块契约，不增加 Core 或 npm 包公开 API。名称在本计划内固定；实施中发现事实冲突应先更新本节，不静默改成第二套抽象。

### 3.1 NodeHost 中立端口

`cli/host/host-contract.ts` 改为定义：

| 类型 | 内容与边界 |
| --- | --- |
| `HostToolsMode` | 现有 none/read-only/read-write 三态；不增加权限开关 |
| `HostModel` | 现有 id、label、vendor、modelName、availability；不携带连接密钥/完整配置/SDK |
| `HostHistoryEntry` | 现有用户/助手/公开推理文本，及工具 callId/name/result；不是规范历史或恢复快照 |
| `HostSession` | id、label、modelId、toolsMode、history、unfinished；维持当前列表含义和排序 |
| `HostContext` | dataRoot、workspaceRoot、threadId、model、toolsMode；仅主进程/Node 宿主内部使用 |
| `HostInteractionDisplay`、`HostInteractionChoice` | support、summary、confirmation、choices；只来自认可的交互描述，不含 payload.data |
| `HostOpenOptions` | modelId、threadId、toolsMode、signal；不含 setup/select/secret/notify |
| `NodeHost` | context、open、models、sessions、newSession、selectSession、run、resume、describeInteraction、answerInteraction、close |

`run()`/`resume()` 继续返回 Core 公开 `AgentRunHandle`；不包装第二层事件流或缓存完成状态。交互解释继续使用当前工作区、权限及 owner/type/version 校验，业务授权策略不迁进展示层。

中立 `createNodeHost()` 的选项包含 dataRoot、workspaceRoot、**必传 configuration**、既有 requireReadApproval 和真实消费者测试使用的 provider 注入。移除在该函数内默认创建配置/DPAPI 的路径。测试注入口不得通过环境变量暴露给生产用户。

新会话必须给出可用模型，或使用同一配置实例中既有默认模型规则；没有模型时返回现有安全错误，不唤起终端向导、不自动换模型。CLI 自己完成配置后，再将确定模型交给 NodeHost。恢复已有 thread 时先验证原绑定，不能因为模型失效先启动向导或重写默认模型来“修复”恢复。

### 3.2 CLI 消费端口与配置流程

新增 `cli/host/terminal-host-contract.ts` 拥有 TerminalHost、TerminalSetupIO、TerminalConnectionTarget/Item 及 CLI 启动选项。TerminalHost 组合 NodeHost 所需能力，并保留配置交互方法；共享 NodeHost 不反向依赖它。

新增 `cli/host/terminal-host.ts` 的 `createTerminalHost()` 是 CLI 实际组合入口，承担真实差异，不是纯转发别名：

- 创建或借用 configuration，选择 CLI DPAPI 保护，拥有 CLI 初始化与配置中止信号。
- 使用现有 `model-setup.ts` 实现 connections/configureModel 和无可用默认模型时的启动向导；不复制配置存储、发现或加解密实现。
- 已打开会话配置连接后，只改变已保存配置/默认模型，不自动切换当前绑定。显式选择模型/新建会话仍走 NodeHost。
- TerminalSetupIO 只借用控制器的唯一输入 owner；不创建新的 stdin reader/raw mode。
- 关闭先禁止新 CLI 操作、中止向导并排空配置操作，再完成 NodeHost 关闭；不等待一个不可取消的输入 Promise 永久挂住，也不将关闭转成用户取消。

**准入要求**：NodeHost 保留当前执行准入；CLI 适配层只协调配置交互与其调用，不能新增执行队列或绕过 busy。配置中禁止 run/resume/切换，活动执行/切换中禁止 configureModel，重复配置拒绝；两种方向都必须回归。适配层可以跟踪通过自身启动的活动 handle 和配置 Promise，但不能重建 Query 状态或替代持久租约。向导失败、close 与初次 open 交错必须释放本地标志；不把原本 exclusive 的 configureModel 简单移到门外。

configuration 当前公开实例只有 management/runtime，没有 close/dispose；不得虚构配置关闭方法。借用桌面配置不随窗口关闭；CLI 自建保护的取消信号归 CLI 适配层，持久存储锁仍由 configuration 自身管理。

### 3.3 事实类型与端侧 DTO

- 模型目录、历史投影、持久摘要及 NodeHost 改用中立类型；历史算法、SQL、序列化载荷不改。
- TerminalRecord、TerminalTurnSettlement、工具预览、退出裁决等仍由终端拥有，不提升为 Host 类型。
- terminal-contract 中若某类型仅是 Host 类型的无差异副本，迁移所有类型引用后删除旧定义，不保留同名 re-export/type alias 兼容层。CLI 真正独有的展示类型继续存在。
- `app/shared/harness-ipc.ts` 保留桌面纯 DTO，不导入 NodeHost、SQLite 或 CLI 契约；Main 在边界逐字段构造对外对象，不因结构兼容就序列化完整宿主对象。
- 不把 HostContext、连接指纹、ModelSelection 或 checkpoint 塞进 renderer；现有 `readHostCheckpoint()` 仍限 Main/宿主内部，统一查询端口不是 A 的新增范围。

### 3.4 安全投影与文本处理

新增 `cli/host/safe-display-text.ts`，只拥有纯文本控制字符转义函数 `escapeDisplayControls()`：复用现有规则，保留换行/tab 和当前 CR/ESC/Bidi 等转义结果，不做宽度、字素、截断、HTML 或 ANSI 渲染。

- terminal-text 保留字素/宽度/折行实现并调用纯函数；原 sanitizeTerminalText 的所有调用迁移到新归属，不留 re-export 或同实现双份副本。
- 桌面输出边界使用同一纯策略，保持当前展示行为；React 仍按文本渲染，不把该函数宣称为 HTML 净化器或完整凭据脱敏器。
- 身份、选择 ID 和文件路径在内部校验/绑定时保持原值，只在既有展示字段边界应用转义，不把转义后文本回传作为权威交互标识。

新增 `cli/host/host-projection.ts`，提供 `projectHostError()` 与 `projectHostInteractionDisplay()`：

- caught error 只信任 Core 的 AgentError，未知异常输出固定安全错误；不用 `error.message`、对象展开或 JSON.stringify 暴露 SDK/server 对象。
- 本轮保持当前未知错误的 code/message（包括既有 `TERMINAL_OPERATION_FAILED`），该历史兼容值不再决定函数所属模块；不借重构另做错误码升级。
- 交互投影逐字段重建支持/不支持分支；未知交互只显示不支持，不能猜测选项或转成允许。
- 终端仍拥有 TerminalRecord/JSONL 级再次白名单投影，桌面仍拥有 HarnessReply/IPC 白名单，不能因共享函数删掉端侧输出边界。
- 删除旧 terminalError/terminalInteractionDisplay 导出并迁移全部消费者，`desktopError()` 可保留为桌面 IPC 的具名边界函数，不再导入 terminal 模块。

## 4. 文件落点与依赖规则

| 文件/区域 | 改动 | 不变量 |
| --- | --- | --- |
| `cli/host/host-contract.ts` | 中立端口和共享事实类型 | 无 Terminal/React/Electron/凭据实现依赖 |
| `cli/host/node-host.ts` | 只接收配置并执行会话操作 | 保留执行准入、切换发布顺序、绑定和关闭语义 |
| `cli/host/terminal-host-contract.ts`、`terminal-host.ts` | CLI 消费端口、向导/保护装配与配置准入 | 不是新 Loop/队列/配置服务 |
| `cli/host/model-setup.ts` | 依赖 CLI 端口，仍只供 CLI 适配使用 | 保留四协议、Key 安全输入与配置保存行为 |
| `model-catalog.ts`、`session-history-projection.ts`、`session-persistence-contract.ts` | 使用 Host 事实类型 | 不改变目录判定、历史确认前缀或落盘格式 |
| `cli/host/safe-display-text.ts`、`host-projection.ts` | 纯文本策略与安全投影 | 不依赖 terminal、node I/O 或完整配置 |
| `cli/main.ts`、`cli/terminal/`、`cli/commands/` | 创建 TerminalHost，消费新类型/投影 | 帮助仍延迟加载宿主；JSONL v1、退出码、输入 owner 不变 |
| `app/main/agent-host/desktop-host.ts` | 只依赖中立 NodeHost/安全投影，保持桌面 DTO | scope/revision/身份发布顺序不动 |
| `tests/fixtures/node-cli-entry.mjs` 及宿主测试 | 按消费角色使用 TerminalHost 或 NodeHost | fixture 不继续把 CLI 流程注入共享入口 |
| `scripts/check-cli-boundaries.mjs` 及现有相关门禁 | 增加解析边与传递路径检查 | 不用源码文字、路径数量或导出数量断言 |

门禁在现有 TypeScript 解析规则上增加以下约束，支持 type-only、re-export、import type、静态动态加载与真实路径，不仅检查直接 import 文本：

1. NodeHost 中立入口的可达依赖图不得进入 cli/terminal、cli/commands、terminal-host、model-setup 或任何 app 模块；中立类型图也受约束。
2. app/main/agent-host 不得直接或间接经过 CLI 适配/终端机制。允许既有 Core/configuration 等受控入口，不扩大到 Core 内部路径。
3. 终端运行时只能消费明确的纯安全投影/文本入口，不能由这一例外访问 node-host、SQLite 或 CLI 配置装配；原 terminal→host implementation 禁止规则保持。
4. renderer/preload 不得引用任何 host Node 实现；app/shared 继续纯桌面契约。CLI→app/src 禁止与包 exports 规则保持。
5. 共享机制仍位于 CLI 编译树，不声称具有独立包封装。未来若抽包，应另做声明闭包、安装消费和产物验收，不计入 A。

## 5. 执行步骤与交付门槛

### A0：冻结行为基线与引用清单

- 核对本计划涉及的导出符号、创建点、测试注入点与产物 fixture；LSP 可用时先做 references。
- 在隔离目录用改造前实现生成 waiting 样本，保存原配置、工作区、pending、binding 与 Query/Run，保留供改造后进程恢复；不复制用户数据/密钥。
- 实际运行双端最小无插件对话、文件审批与 CLI 冷配置流程，记录端侧 DTO/JSONL、默认模型缺失与安全错误行为。基线失败先如实记录并区分既有问题，不改断言掩盖。

交付：调用关系清单、改造前样本和可重复的最小烟测步骤；本步骤不新增锁定 wording/源码的永久测试。

### A1：共享事实类型与纯安全投影

- 定义 Host 类型，迁移模型目录/历史/持久摘要的类型依赖；不重写算法。
- 抽取纯控制字符规则与安全错误/交互投影，同轮迁移所有调用并删除旧无差异导出/定义。
- 更新门禁允许的纯入口，禁止把终端整层加入白名单。

交付：中立类型及纯函数可被双端使用；未知 SDK 异常、控制字符、未知交互及工具私有数据的安全边界不退化。

### A2：拆分执行机制与 CLI 配置装配

- 实施 NodeHost 必传 configuration 的新契约；移出配置/保护创建、setupInput/configureModel 与向导分支。
- 实施 TerminalHost 组合，复用原 model-setup；保留 CLI 启动缺省配置行为和配置/执行互斥。
- 同轮迁移 main、控制器、命令类型、全部测试构造点及真实 Node fixture，删除旧 createNodeHost 终端返回重载。不要留临时兼容 overload。
- CLI 帮助/纯输入路径继续不触发凭据、配置数据库或模型创建；close 可以中止冷启动向导。

交付：同一 Node 执行机制供双端使用，配置只属于 CLI 适配；所有调用可类型检查，配置取消/失败不改变当前绑定。

### A3：桌面切换中立消费面并固化边界

- 桌面改用 NodeHost、共享安全投影与纯文本入口，不导入 TerminalHost/terminal-projection/terminal-text。
- 显式提供原桌面 configuration、requireReadApproval，保持原 createHost 测试注入口和窗口所有权含义。
- 检查 snapshot、models、sessions、审批与事件逐字段输出；不泄漏新增宿主字段，不重排首段事件前的身份发布。
- 增加现有门禁的正/反隔离场景：直接绕过、重导出绕过、类型路径绕过、纯入口合法消费。测试实际拒绝依赖图，不锁源码。

交付：桌面中立入口可达图不经过终端/向导，CLI 不反向依赖 app；不以“没有直接 import”替代传递依赖证明。

### A4：行为回归与实际双端烟测

- 按第 6 节执行改动路径，先受影响回归，再一次完整类型/边界、全量回归和构建；不得多个并行任务重建同一包产物。
- 实际 CLI 生产/开发入口及 Electron 构建入口各完成最小对话/审批路径；CLI 冷配置、EOF、恢复和关闭实际运行。
- 用 A0 样本在改造后新进程恢复，核验原 Query/新 Run、随机文件结果消费、规范历史与租约释放。改造前源码夹具不冒充旧发布二进制。

交付：可观察行为与数据格式未改变的证据；没有远程厂商用量时明确只认证本地 SDK/HTTP 或受控 provider。

### A5：完成收口

- 删除 A 的临时脚本/隔离数据，仅清理本次创建资源；永久回归覆盖真实风险，不保存实现接线测试。
- 回写本文件、M4 总计划与导航：新增/删除入口、消费清单、实际命令、兼容结果与限制。
- A0～A4 所有门槛通过后才将 A 标完成；不能据此勾选 B～E。

执行顺序为 A0 → A1 → A2 → A3 → A4 → A5。A1 的契约先稳定，A2 的共享实现由同一集成者拥有；契约冻结后，CLI 和桌面消费迁移才可独立分片，不能并行各造一份宿主或文本清洗器。

## 6. 验收矩阵

| 场景 | 观察与断言 | 验证层 |
| --- | --- | --- |
| 本地模型目录 | 无 Key 解析、无模型调用；ready 只表示本地就绪；缺失模型不静默替换 | 既有宿主回归与实际冷启动 |
| 无插件对话 | 双端有真实输入/响应，未暴露文件工具；Core handle/身份与原链一致 | CLI/Electron 实际表面 + SQLite |
| 文件读取 waiting→批准 | 批准前无随机文件内容，批准后模型实际消费结果，Query 不变/Run 更新 | 双端实际操作 + checkpoint/history/lease |
| 拒绝与写入确认 | 拒绝不执行；write/edit 的 interaction-id 校验不丢失；不支持交互保持 waiting | 真实宿主行为回归与临时工作区 |
| 配置互斥 | 活动执行/切换中配置拒绝，配置中执行/切换拒绝；重复配置不排队 | CLI 适配消费者行为回归 |
| CLI 配置取消/失败 | 保存成果不丢、旧绑定不切；冷启动取消与 close 不挂住，不生成伪成功会话 | 现有控制器/宿主回归 + 真实终端 |
| 观察与结算 | 首段预览可见；临时内容不进入取消后的规范历史；输出状态不因类型迁移改变 | 桌面实际操作/CLI 实际输出 |
| 安全边界 | 异常私有 Key、request、payload/replay 不外泄；控制字符行为保持 | 现有投影/宿主回归，双端输出检查 |
| JSONL/IPC 兼容 | 原结构/version/身份/状态含义不变；只序列化许可字段，新增内部字段不穿透 | 行为断言与实际输出，不做全量文案快照 |
| 改造前 waiting | 原环境新 PID 恢复同 Query/新 Run，未重派已知未知副作用，终态与租约可核验 | A0 夹具 + 改造后 CLI/Electron 消费 |
| 依赖封装 | 中立图不能经过终端/CLI 向导；纯安全入口合法；CLI/app/Core 方向不退化 | TypeScript 解析门禁正反例与完整构建 |

复用现有测试文件：`tests/general-agent-development-host.test.ts`、`desktop-harness-host.test.ts`、`cli-terminal-controller.test.ts`、`cli-terminal-rendering.test.ts`、`general-agent-host-binding.test.ts`。A2 如需独立测试，仅为配置/执行准入与关闭竞争等尚未覆盖风险增加消费者行为回归；不为函数搬家、类型别名或转发本身新建测试。

建议实施检查命令：

```text
npx.cmd vitest run tests/general-agent-development-host.test.ts tests/desktop-harness-host.test.ts tests/cli-terminal-controller.test.ts tests/cli-terminal-rendering.test.ts tests/general-agent-host-binding.test.ts
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:integration:harness
npx.cmd biome check <本次修改的受支持文件>
npm.cmd run build
npm.cmd run agent -- --help
npm.cmd run agent:dev -- --help
```

帮助不是执行烟测；Electron 必须从实际构建入口操作，`ui:dev` 不算证据。A 不要求重复 M4-E 的完整 ASAR 矩阵；若本轮改变打包依赖解析，则必须补受影响产物烟测，不能用“不在 A 范围”跳过。

## 7. 风险与不允许的简化

- **只改名字**：把 TerminalHost 改成 Host 但继续带 setup、TerminalRecord/ANSI，是未完成。
- **移出向导但丢互斥**：原 configureModel 在 exclusive 内；新适配不能让配置与执行并发或在 close 后重新安装。
- **共享配置所有权错位**：桌面必须始终使用原 safeStorage 实例；不得因 NodeHost 默认值创建另一份 DPAPI 配置。
- **控制字符双重转义**：纯函数维持当前幂等处理，端侧已转义内容不得出现重复反斜线转换；内部身份绝不以展示值替换。
- **历史算法顺带改写**：类型迁移不得改 checkpoint 确认前缀、hidden ranges、工具缺失结果或消息位置。
- **过宽依赖白名单**：允许两个纯文件不等于允许整个 host 运行时；防止经重导出绕过。
- **向 Core 倒灌宿主概念**：配置向导、目录、DPAPI、SQLite 和 CLI 错误兼容值不进入 Core。
- **以类型通过冒充消费通过**：必须运行真实入口与旧 waiting；不借用此前 M3/UI 数字。

## 8. 完成清单与本次记录

- [x] A0：基线、调用清单与改造前 waiting 样本已取得。
- [x] A1：共享类型/安全投影完成，旧重复导出及全部调用已迁移。
- [x] A2：NodeHost/TerminalHost 分离，配置准入、取消与关闭行为通过。
- [x] A3：桌面中立消费与传递依赖门禁通过。
- [x] A4：双端真实烟测、旧 waiting 与完整相关检查通过。
- [x] A5：临时资源已清理，实施证据/入口导航已同步，未提前标记其他切片完成。

2026-11-02：核对中立宿主、CLI 向导、模型目录、历史投影、桌面 Main、纯 IPC、边界脚本和 CLI 编译规则，制定本计划。LSP 查询不可用，未进行代码修改或声称完成语义引用验证；未运行模型、CLI、桌面或代码测试。本次文档核验结果在完成后另记。

本次 Node 文档核验通过：4 份变更文档 UTF-8 有效、代码围栏配对，83 处本地链接目标存在、44 处链接锚点可解析；A0～A5 章节完整，6 项完成清单全部待实施。未验证外部站点，未运行代码或实际入口；这些文档检查不计入 A 的行为验收。

## 9. 实施与本地验收记录

2026-11-02：按 A0～A5 完成实施，保留 `cli/host/` 现有编译布局，没有新增 workspace、Core API、执行队列或持久格式。LSP 仍返回无语言服务器；实际引用迁移通过目标搜索、解析依赖图、全仓类型和双端构建消费核验，不声称已做 LSP 语义验证。

### 9.1 实施范围与迁移结果

- `host-contract.ts` 拥有中立 Host 事实与 NodeHost 端口；模型目录、历史投影、持久摘要、工作区权限和 binding 类型均已迁移，不再依赖终端类型。
- `createNodeHost()` 必须借用 configuration，保留原执行准入/绑定/关闭逻辑；移除创建 DPAPI、备用配置、connections/configureModel 与启动向导的旧职责。
- `terminal-host-contract.ts`、`terminal-host.ts` 提供真实 CLI 配置适配；保留默认模型/冷配置、provider 注入、配置与运行/恢复/切换互斥、配置中止和关闭排空。`cli/main.ts` 延迟加载 `createTerminalHost()`，CLI 进程 fixture 同步迁移。
- `safe-display-text.ts`、`host-projection.ts` 内聚原控制字符规则和白名单投影；TerminalModelItem/HistoryEntry/InteractionDisplay/Choice、TerminalToolsMode、sanitizeTerminalText、terminalError/terminalInteractionDisplay 的旧定义/导出及调用已迁出，无兼容别名或旧重载。
- 桌面改用中立 NodeHost/投影，模型、会话和身份逐字段形成桌面 DTO；未改 renderer IPC 结构、JSONL v1 或终端退出码，不将宿主对象直接扩展进对外载荷。
- CLI 门禁沿真实解析图保护中立入口、桌面传递依赖和共享 DTO，终端运行时只允许两个纯安全入口；新增 `tests/cli-boundaries.test.ts` 覆盖直接、类型、重导出、静态动态加载及别名/真实路径绕过。原 CLI→app/src 和包 exports 约束保持。
- `general-agent-development-host.test.ts` 新增/扩展配置与活动执行/切换互斥、配置中恢复/选择拒绝及两类宿主准备期间关闭的行为回归；原配置失败、旧绑定保持和初始向导关闭场景迁到 CLI 适配，不为转发或类型搬家新增测试。

### 9.2 实际检查结果

| 检查 | 本轮结果 |
| --- | --- |
| 六文件定向行为回归 | 首轮 281 项通过、1 项 CLI 子进程 seed 失败；当时 fixture 已切新入口、CLI 产物尚未生成。随后先构建，再由完整回归覆盖，不修改断言或产品逻辑掩盖 |
| `node cli/build.mjs` | 通过，生成新 NodeHost/TerminalHost 及 CLI 实际产物 |
| `node scripts/check-cli-boundaries.mjs` | 通过，中立/桌面/CLI/configuration 解析依赖约束有效 |
| `npm.cmd run build` | 通过，五包、Core/logs/models/tools/CLI/UI 边界、node/web/CLI 类型及 CLI/Electron main/preload/renderer 构建 |
| `npx.cmd vitest run --exclude "tests/*.integration.test.ts"` | 219 文件通过；2286 项通过、3 项既有跳过，覆盖首轮失败的 CLI 异步输出回归 |
| 三个 Harness 集成文件的 `npx.cmd vitest run` | 3 文件、62 项通过：general-agent-development-cli、mimo-development-cli、general-agent-reliability |
| 本轮 38 个支持文件的 Biome | 格式收敛后再次检查，38 文件通过、无修改、无诊断 |
| `npm.cmd run agent -- --help`、`npm.cmd run agent:dev -- --help` | 两个实际入口均通过，不以帮助代替下节执行证据 |

本轮完整回归直接调用 Vitest，使用前面已成功构建的五包和 CLI 产物；未将其写成执行过 `npm test`。首次临时恢复驱动误加 `--print`，按既有协议保持 waiting/退出 3；移除该非交互选项后才进行显式审批恢复，未改变产品行为。

### 9.3 真实入口与旧 waiting 兼容

CLI 使用改造前保存的实际编译产物、临时工作区、随机 UUID 文件、真实 Windows DPAPI、OpenAI Responses SDK→本地 HTTP/SSE；没有调用远程厂商。基线无插件对话完成，文件读取审批前 committed 不含随机内容且 waiting 租约释放；改造后新进程显式批准，服务端核验实际工具结果含随机值，最终规范历史含模型消费结果。

| 消费端 | 原 PID → 新 PID | Query | 原 Run → 新 Run | 最终持久事实 |
| --- | --- | --- | --- | --- |
| Node CLI | 46416 → 46532 | `887f68cd-5781-4b61-a0b0-81a01ca682ed` | `b481908d-85cb-49e0-9107-65c2269399f2` → `c8d06507-4f7a-4ef8-b72a-6c5e3a3f9367` | completed，lease released，真实文件内容进入 committed |
| Electron Main | 20296 → 27672 | `8b24c413-3a84-4d27-b36a-0865de275168` | `05a5d79e-09ac-4177-916d-9bc83244c53c` → `49f9f5ac-fe06-4818-9ce7-92c6f1ce4a8e` | completed，lease released，historyRevision 1 → 3 |

桌面从实际 `out/main/index.js` 启动，使用独立临时 HOME/USERPROFILE 与 safeStorage。真实页面完成创建连接、发现/添加模型、无工具对话、只读文件审批；waiting 时正常关闭，新构建 PID 从同一库恢复审批，点击批准后本地服务从真实工具输出提取并核验文件校验码，页面显示消费结果。改造后再次完成无插件对话，工具未暴露；页面异常列表为空。两次桌面进程均正常退出 0，未用强杀代替 waiting 退出。

改造前/后的真实终端冷配置均显示四协议连接选择，取消/退出后进程为 0；未要求输入远程 Key。配置准入、准备期关闭和无响应输入端口的中止由消费者行为回归进一步覆盖。交互审批进程驱动另用受控 stdin/raw 标记，不将它单独称为真实 ConPTY 认证。

### 9.4 范围、兼容与资源清理

- Core 消息/执行协议、宿主 v2 binding、SQLite 表/JSON、默认模型存储位置和已签发计划语义未改；验证的是本轮改造前源码构建产物，不是旧发布二进制的全版本兼容认证。
- 最近工作区通过现有 `createRecentWorkspaces().remember()` 为隔离目录签发；本轮未补原生目录选择器完整键鼠确认，仍归 M4-B。双窗口/导航/全关闭竞争矩阵与完整数据兼容矩阵分别归 B/C。
- 未新增 ASAR/安装器认证、远程厂商请求、业务插件或旧 Agent/Gateway 删除；历史 ASAR/远程证据不计入本轮。
- 本次临时脚本、改造前 CLI 副本、配置密文、数据库、工作区及两张临时截图已删除；两个桌面、本地模型服务、两个冷启动终端均已退出，浏览器托管句柄已释放。没有清理用户生产数据或其他进程。

交付文档核验：4 份文档 UTF-8 与代码围栏通过，85 处本地链接目标存在、49 处锚点可解析；A0～A5 完成，B～E 仍待实施，隔离临时目录已不存在。未检查外部站点。
