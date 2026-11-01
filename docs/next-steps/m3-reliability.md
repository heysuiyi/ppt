# M3：扩展与可靠性通用验收

[返回计划目录](README.md) · [项目整体规划](../project-plan.md)

## M3 执行计划

状态：已完成 Netty/Tomcat 官方契约调研及当前代码、测试断言核对；以下为待执行方案，不表示 M3 已实施或验收通过。M1、M2 和日志包切片的记录见[计划目录](README.md)，历史路径和验收数字不作为 M3 的新增证据。

### M3.1 目标、范围与非目标

本轮重点是**竞争条件下的隔离、生命周期与持久恢复安全**，同时完成原规划的能力组合、安装失败回滚和版本兼容门槛。先验证既有执行模型并修复被复现的缺陷，不先开放并发再补安全，不把“可靠性”缩成正常路径测试。

并发边界保持：

- 同一 Agent 实例最多一个激活，`run/resume` 竞争明确拒绝，不隐式排队。
- 不同 Agent 可异步交错执行；可共享宿主端口，但模型 binding、插件注册、取消信号和读取观察必须隔离。Node 单线程不等于异步无竞争，也不代表阻塞操作不会阻塞其他执行。
- 同一 Query 的跨进程写入由租约、generation 围栏和 revision CAS 保护；这与单实例活动槽是两层机制。
- Thread 承载多次 Query；不能把 Query 键租约宣称为 Thread 级跨进程原子准入。先核验下文 C2 的竞争窗口。
- `waiting` 结束 Run 并释放槽位及租约；恢复保留 Query、使用新 Run，不保留跨等待调用栈。
- 工具批次仍串行；`concurrency: "parallel"` 当前只是能力声明，不是已经存在的并行调度。

不纳入：生产 UI/IPC/PPT 迁移、删除旧 Agent/Gateway、新 provider、线程池/Worker/全局任务队列、同 Run 并行工具、动态插件装卸、子 Agent、上下文压缩、遥测或内核日志接入。也不新增容器、服务定位器或通用验收框架。

默认保持 HostSessionBinding v2、检查点 v1、续传载荷及数据库格式；不能为了测试便利修改格式。若复现的安全缺陷确需改变公开存储契约或持久格式，先写明最小修复设计、迁移与兼容影响，再实施，不把协议变化藏进测试补充。

### M3.2 Netty 与 Tomcat 调研及取舍

参考范围为 Netty 4.1 API、Tomcat 11 配置及 Servlet 6.1 API；只采用下表所列工程原则，不引入 Java 运行时依赖，也没有对这两个服务器进行性能或安全实测。

| 官方依据 | 可借鉴的原则 | 本项目采用与不采用 |
| --- | --- | --- |
| [Netty EventLoop](https://netty.io/4.1/api/io/netty/channel/EventLoop.html)、[ChannelPipeline](https://netty.io/4.1/api/io/netty/channel/ChannelPipeline.html) | 一个 EventLoop 可服务多个 Channel；有序 executor 可按 handler context 保序，耗时处理可另行委派 | 核验执行所有权和异步交错，不机械映射 Agent=Channel、Run=EventLoop；不新增调度线程或动态 Pipeline |
| [Netty ChannelHandler 的状态管理与 Sharable](https://netty.io/4.1/api/io/netty/channel/ChannelHandler.html) | 有状态 handler 默认逐连接实例化；共享代码不等于共享连接状态安全 | 验证同一插件对象多次安装时，状态位于每次安装闭包；共享服务借用，binding 与 signal 分离。不增加 Sharable 注解或恶意插件沙箱 |
| [Netty shutdownGracefully](https://netty.io/4.1/api/io/netty/util/concurrent/EventExecutorGroup.html) | 关闭有独立完成信号；quiet period 内提交任务会被接受并重新计时 | 借鉴等待关闭完成；**不照搬继续受理规则**。当前 Application/Agent/SessionHost 一旦关闭即拒绝新执行，随后中断并排空 |
| [Netty WriteBufferWaterMark](https://netty.io/4.1/api/io/netty/channel/WriteBufferWaterMark.html) | 高低水位改变 isWritable，背压需要生产者配合，不是自动拒绝所有 write 的硬容量 | 区分观察缓冲、执行准入与权威存储；不把观察消费者变成执行驱动者，不默认丢事件或暂停模型 |
| [Tomcat Executor](https://tomcat.apache.org/tomcat-11.0-doc/config/executor.html)、[HTTP Connector](https://tomcat.apache.org/tomcat-11.0-doc/config/http.html) | Executor 可共享；线程数、连接数、操作系统 backlog 与任务队列是不同限制；maxQueueSize 默认 Integer.MAX_VALUE | 分别说明实例槽位、持久写入租约和事件缓冲的边界；不能因“有线程池”就声称容量有界。本轮不照搬线程池、全局配额或队列默认值 |
| [Tomcat Lifecycle](https://tomcat.apache.org/tomcat-11.0-doc/api/org/apache/catalina/Lifecycle.html)、[Servlet init/service/destroy](https://tomcat.apache.org/tomcat-11.0-doc/servletapi/jakarta/servlet/Servlet.html) | 初始化成功后才服务请求，共享实例状态需保护，停止服务和释放资源分开 | 核验安装→绑定→seal→发布、失败回滚及关闭排空；**不复制 Servlet 超时后仍可 destroy 的规则**，不提前关闭活动工具依赖 |
| [Tomcat Context](https://tomcat.apache.org/tomcat-11.0-doc/config/context.html) | 应用有独立资源边界；强制停止应用线程有不稳定风险 | 验证安装作用域与共享依赖所有权；不引入 classloader 隔离、Thread.stop、热部署或新生命周期状态机 |

Netty 的事件传递不是本项目 `RuntimeEvent` 的定义：后者是观察输出，规范历史和检查点才是恢复依据。Tomcat 请求或 Servlet async 也不等于可跨进程恢复的 Query。两者都不能替代本项目的副作用派发记录、历史对账与持久写入围栏。

### M3.3 当前代码与已有覆盖

以下为静态核对；是否本次运行通过，另见 M3.9 的证据记录。优先复用已有测试，不把每行都复制成一套新测试。

| 边界及代码落点 | 已有测试事实 | 本轮补充重点 |
| --- | --- | --- |
| `application/agent-application.ts`、`application/default-agent-factory.ts`、`extensions/plugin-manager.ts` | `general-agent-lifecycle` 已断言创建 ID 占位、失败后复用、关闭等待迟到 binding、setup 重入关闭；`general-agent-infrastructure` 已断言重复插件和逆序回滚 | 经公开入口补多插件成功组合、跨插件注册冲突，以及创建取消与回滚失败同时发生 |
| `runtime/default-agent.ts`、`agent-host/session-host.ts` | lifecycle 已覆盖句柄返回前 run/run、run/resume 竞争；session-host 已覆盖 binding 等待/取消、固定 Thread 与关闭排空 | 两 Agent 同时在途且共享端口，关闭其中一个，另一实例仍完成；逐次创建独立 binding，不能复用同一 fixture binding 冒充隔离 |
| `extensions/prompt-registry.ts`、`tools/tool-pipeline.ts` | infrastructure 有注册冲突、提示词顺序、恢复重新授权、输出/投影失败保留 applied 的白盒断言 | 将组合与副作用边界提升为公开消费行为，不扩大白盒豁免 |
| `runtime/run-controller.ts`、`runtime/query/checkpoint-session.ts` | runtime 已覆盖累计预算、模型流中断、历史追加已提交但丢确认、派发/续传后结果丢失；部分场景使用真实磁盘文件 | 补版本拒绝、回答消费后尚未进入续传的窗口、工具/最终响应批次对账，以及 unknown+applied 的持久结果 |
| `src/main/agent-host/sqlite-agent-stores.ts`、`host-session-binding.ts` | host/host-binding 已覆盖跨连接租约、旧围栏拒绝、revision CAS、重开幂等收据、逐项绑定拒绝 | 独立进程 barrier 驱动的真实竞争；同进程 DatabaseSync 的 Promise.all 不算跨进程竞争证据 |
| `runtime/event-stream.ts` | 单消费者；执行不等消费；退订不取消；close 后仍可读取积压 | 经 handle 验证有限积压、慢观察、各 Run 身份隔离；不宣称容量有界 |
| 两个现有 CLI integration 与 `scripts/verify-harness-package.mjs` | 已有真实 Electron/SQLite/文件及本地 HTTP/SSE 恢复场景；tarball 脚本有原生 Node 消费，但其存储夹具在内存中 | 复用真实入口与独立安装消费；分别标记受控模型、本地 SDK/HTTP、跨进程持久性，不升级成真实厂商或崩溃恢复证据 |

### M3.4 执行任务与验收矩阵

按 A→B→C→D→E 推进；进入修改前先运行相应现有回归，缺陷先复现再修复。不同组可在共同契约固定后并行实现，最终集中验收。

| 编号 | 任务与最小场景 | 必须观察的结果 |
| --- | --- | --- |
| A1 | 无插件、文件能力、两个独立贡献插件的公开组合；插件 A 贡献模型路由与提示词，B 贡献工具与提示词 | 无插件可对话且不暴露工具；组合模型消费真实工具结果；基础指令与贡献顺序正确；未安装能力不能执行；更换组合不改变授权语义 |
| A2 | 参数化制造跨插件 providerId/tool name/prompt id 冲突；后续 setup 失败；创建取消与 disposer 失败 | 整次创建拒绝、不发布半成品；所有已取得资源各回收一次；清理错误不吞；原 ID 可再创建；另一 Agent 不受影响；共享服务未误关 |
| B1 | 同 Agent 的 run/run、run/resume、resume/resume；等待后新 Run；不同 Agent A/B 使用不同 Thread，同时阻塞于独立模型门闩 | 同实例竞争明确 agent-busy，无隐式队列；A/B 不串输入、工具、事件、signal 或历史；关闭 A 仅中断 A，B 可继续提交且共享存储仍可使用 |
| B2 | 创建/迟到绑定/关闭竞争；活动工具中关闭；用户 cancel 与 close 的两个确定先后顺序 | 停止受理是同步边界；关闭等待在途工作与租约释放后才释放 binding/plugin；重复 close 幂等。取消为 cancelled、关闭中断为 interrupted，已提交 waiting 保持 waiting；重叠时按当前终态提交边界核验，不预设“第一个信号必胜” |
| C1 | 两个独立进程打开同一临时 SQLite：争 Query 租约、同 revision 保存、竞争新 Thread binding、历史追加/重复 batch | 不预定赢家；租约一 acquired 一 busy；同 CAS 一 saved 一 conflict；不同绑定一成功一拒绝；重复批次无重复消息；第三进程重开读到持久赢家；过期 save/release/replace 不破坏新 writer |
| C2 | 两个 Application/进程使用相同 agentId/threadId、不同 queryId；门闩固定在 findUnfinished 与 acquire 之间，再让第一 Query 进入模型 | 核验线程待决检查是否可被过期读取越过；若可越过，先形成失败回归及最小 Thread 原子准入修复设计。不能用 Query 租约、历史 CAS 或单实例 agent-busy 代替 Thread 准入证明，也不能把失败场景标记为支持的安全并发 |
| C3 | 原实现保存 waiting；重建实例后分别改变 definition、插件版本/增删/顺序、model selection、工具版本和宿主绑定；原配置作成功对照 | 不兼容在进一步模型/工具调用及回答消费前拒绝，原 waiting 和规范历史不被失败内存快照覆盖，原配置仍可恢复。插件当前按有序列表精确比较，不擅自改 semver 或集合兼容 |
| D1 | 明确故障窗口：dispatched 保存后执行前；真实副作用后结果保存前；回答消费 CAS 后续传前；续传副作用后结果保存前 | 恢复不重复 execute/resume，不重复消费旧回答；公开 tool.completed、检查点与历史呈现 TOOL_OUTCOME_UNKNOWN；有既存 applied 时保持 status=unknown/effects=applied；副作用零次或一次按实际窗口核对，unknown 不表示回滚 |
| D2 | 历史 input、工具调用/结果、最终 assistant 批次提交后丢确认；追加完成后 checkpoint 确认失败；终态保存后丢确认 | 恢复通过原 batchId 对账，消息顺序及 callId/结果配对不重复；陈旧 revision 不覆盖权威状态；已持久 completed 不再次续跑或调用模型；租约最终释放 |
| D3 | 等待期间宿主权限撤销、拒绝审批、错误交互/旧回答重交、恢复预算不增加 | 未批准不进入能力；恢复重新授权；拒绝或取消不抹掉先前 applied；Query 不变、Run 更新，累计预算不重置；终态不可恢复 |
| E1 | 有限且确定的流式增量/事实序列：不消费、门闩式慢消费、提前 return、完成后 drain；两个 handle 交错观察 | completed 不等待消费；退订不取消；身份/有序事实不串 Run；completed 等待实际清理及租约释放；观察输出不是恢复历史 |
| E2 | 原生 Node 包消费者及现有 Electron CLI：普通对话、随机码读取、写审批、EOF 重启批准/拒绝/取消、绑定变更拒绝 | 消费构建产物，不回退源码；工作区 read/glob/grep 按当前策略自动允许，write/edit 未批准不写；真实临时文件结果匹配；最终 checkpoint/status 与 lease 同时核验；不把退出码 0 当 completed |

C2 是代码检查发现的**候选竞争窗口，尚未复现**：`run-controller.ts` 先 `findUnfinished(agentId, threadId)`，再单独 `acquire({agentId, threadId, queryId})`；SQLite 仅后者在事务内。M3 必须先查清并处理这个边界，不能仅补成功测试就宣布并发安全。若证明现有宿主存在更外层原子保护，需给出实际调用证据；否则最小修复应由通用存储/准入契约与适配器共同落实，不能增加一个仅单进程有效的锁或捕获异常后静默继续。

### M3.5 夹具、持久性与证据设计

- **公开入口优先**：组合和生命周期只用 createAgentApplication/createSessionHost 及公开端口；保持现有内部实现白盒测试，不新增私有路径导入或白名单。
- **能力组合不是新增生产业务**：A1 的两个插件为隔离验收夹具，分别贡献模型/提示词和可恢复能力。副作用能力在临时目录真实追加执行凭据，模型读取实际结果；不是仅返回预设成功的 mock，也不把它描述为已交付的新业务插件。真实文件能力仍使用 createTools，不另造文件安全实现。
- **精确交错**：Promise.withResolvers、IPC ready/barrier/ack 固定窗口；不使用 sleep 猜竞态、不用随机压力或耗时阈值代替不变量。超时仅作夹具失败退出保护，不算优雅关闭证明。
- **真实进程竞争**：C1 各子进程独立打开同一磁盘库；同线程同步 SQLite 的 Promise.all 不能代替。进程夹具可借用当前 Vite/Electron 构建方式，不为测试新增生产导出。
- **崩溃与等待分开**：正常恢复用 EOF 保留 waiting；崩溃场景在公开存储包装器委托真实提交后发送 ack 并阻塞，再由父进程终止本次创建的子进程，等待确认 exit。确认旧 writer 停止后，才由受信任夹具提交完整旧租约显式接管；SessionHost/CLI 不开放前端 takeover。
- **不修改生产行为来造故障**：包装公开端口注入“提交前失败/提交后丢确认”；不新增内核测试钩子，不手工伪造恢复快照替代真实执行。损坏 checkpoint schema 属于额外存储损坏场景，不以此扩大白盒面。
- **副作用计数**：使用独立磁盘追加凭据，区分 execute/resume 与调用身份。只检查同内容覆写的最终文件会漏掉重复执行，不能作为唯一证据；不打印完整工具结果、重放状态、凭据或原生 SDK 异常。
- **分层记录**：受控模型只证明协议；真实 SDK 到本地 HTTP/SSE 证明适配与入口；跨进程 SQLite 证明持久边界；真实厂商另需说明 API 用量。本次 M3 默认不新增远程调用，不能沿用历史厂商成功作新增证据。

### M3.6 文件落点与实施顺序

| 顺序 | 文件落点 | 动作 |
| --- | --- | --- |
| 1 | 现有 general-agent 系列测试、`scripts/verify-harness-package.mjs` | 运行基线，按 A–E 编号登记现有断言与缺口；已有有效测试不重写，源码措辞/简单转发测试不重新钉住 |
| 2 | `tests/general-agent-lifecycle.test.ts`、`general-agent-session-host.test.ts` | 补 A1/A2/B1/B2/E1 的缺失公开行为；逐 binding 所有权、门闩和真实结果断言，不复制安装器或资源树 |
| 3 | `tests/general-agent-host.test.ts`、`general-agent-host-binding.test.ts`；需要时新增 `tests/fixtures/general-agent-reliability-entry.ts` 和 `tests/general-agent-reliability.integration.test.ts` | 优先执行 C2；实现 C1 的真实子进程竞争及 D 的崩溃恢复。新增 fixture 仅用于已有 Electron/公开 SQLite 适配，不依赖真实凭据，不进入 out/** |
| 4 | `tests/general-agent-runtime.test.ts`、`general-agent-development-host.test.ts` | 补 C3/D1/D2/D3 的持久与公开事件断言；复用现有真实 SQLite 和受控模型，不扩基础设施抽象 |
| 5 | `packages/harness/src/agent/` 对应 application/runtime/tools/session 文件及 SQLite 适配 | 仅修已复现缺陷，先失败后通过；公开符号变更前检查引用，同步所有适配器、消费者和声明闭包；不借机重写 Loop |
| 6 | 原有两项 CLI integration、包消费脚本、根 package.json（仅若新增集成文件） | 复用 E2；若新增 reliability integration，将其接入现有 test:integration:harness。npm test 默认排除 integration 的规则保持，不能只手动跑而漏进常规集成入口 |
| 7 | 本文及 project-plan.md | 集中验收后记录实际修复、覆盖、限制和命令结果，再决定 M3 完成状态；不以新测试数量作为门槛 |

所有者划分不变：Application 管理创建和 Agent，Agent 拥有模型 binding/插件作用域，Run 拥有激活资源；宿主拥有 SQLite、provider 与日志。模型和工具不响应取消时，当前关闭可能一直等待；本轮不许用强制提前 dispose 伪装为成功关闭，也不承诺固定关闭时限。

### M3.7 容量与安全声明的边界

当前 `RuntimeEventStream` 使用无容量上限的数组，慢消费者落后时已读前缀也可能保留到追平；close 保留未读队列，return 才显式清空。单 Agent 单激活也不限制 Application 的 Agent 总数或模型适配器的全局调用量。

M3 的 E1 只证明**有限场景下观察独立与身份正确**，不是内存有界、吞吐、背压或抗拒绝服务验收。不静默丢事实事件，不通过等消费者来暂停权威执行，也不宣称受信任进程内插件已经获得沙箱隔离。若要交付容量治理，应另定生产速率/字节上限、满载行为、丢弃可见性和消费者契约；不把这些有取舍的行为偷偷带入本轮。

### M3.8 集中验收与完成门槛

实施后使用 Windows 的 npm.cmd/npx.cmd；其他平台使用对应 npm/npx。以下为待执行命令，不是已经通过的记录：

```text
npm.cmd run build:packages
npx.cmd vitest run tests/general-agent-lifecycle.test.ts tests/general-agent-infrastructure.test.ts tests/general-agent-session-host.test.ts tests/general-agent-runtime.test.ts tests/general-agent-host.test.ts tests/general-agent-host-binding.test.ts tests/general-agent-development-host.test.ts tests/base-tools.test.ts
npm.cmd run test:integration:harness
npm.cmd run verify:harness-package
npm.cmd run typecheck
npx.cmd biome check <本次修改的受支持代码和配置文件>
npm.cmd test
npm.cmd run build
npm.cmd run agent:dev -- --help
```

新增 reliability integration 必须由上面的 test:integration:harness 实际运行。若没有改包公开面或封装机制，不重复整套 ASAR/安装器验收；若改包声明/产物边界，重跑相应既有真实消费验收。开发入口 help 仅证明可启动，不能代替 E2 的审批/恢复烟测。

完成门槛：

1. A–E 的每个编号都有现有或新增的行为证据，C2 已查清，若存在安全缺陷则已修复；不以“其余用例通过”掩盖失败，也不把未执行项标完成。
2. 明确区分实例隔离、Query 围栏、Thread 准入、历史 CAS 与外部影响；有冲突时模型/工具不得越过已定义权限及提交边界。
3. 安装失败、竞争关闭、版本不兼容、持久结果不确定均不导致资源误关、越权、重复派发或覆盖新状态；unknown/applied 的不确定性如实呈现。
4. 实际包消费者、真实进程/SQLite/文件和现有 CLI 路径成立；覆盖范围与受控模型/本地 HTTP/远程厂商证据分别列出。
5. 所有本轮产生的进程、隔离库、工作区和临时脚本清理；共享生产库、历史日志和用户文件不动。持久保留的集成夹具可重复运行且默认不访问远程模型。
6. 生产 UI/PPT 和旧链路状态不变；不额外声称容量有界、恶意插件隔离、自动故障接管或外部副作用恰好一次。

### M3.9 本次计划制定证据

本次只制定计划、核对代码和执行基线检查，不实施 A–E 的新增功能或测试。官方来源见 M3.2；新增验收、C2 竞争复现及运行时修复均为待执行，不引用后文 M1/M2 的历史数字冒充本次结果。

计划制定阶段实际运行结果：

| 命令/场景 | 本次观察 |
| --- | --- |
| `npm.cmd run build:packages` | Harness 与 logs 构建成功 |
| M3.8 所列八个相关测试文件的定向 Vitest | 8 文件通过，111 项通过、1 项按现有 Windows 条件跳过；跳过项为 base-tools 的 final file symlink 场景，不表示该平台场景已验收 |
| `npm.cmd run verify:harness-package` | 真实 tarball 仓库外离线安装、NodeNext/Bundler 声明消费、原生 Node 无插件对话、审批等待/恢复、拒绝及安全错误投影通过；临时目录已由脚本清理。此处存储为内存夹具，输出明确 crossProcessDurability=false |
| `npm.cmd run test:integration:harness` | 两个真实 Electron CLI 集成文件、2 项测试通过，无跳过；含独立进程 EOF 等待/恢复、拒绝与取消。模型侧为本地 HTTP/SSE，不访问远程厂商 |

本次未运行全量单测、全仓类型/静态检查、生产构建、ASAR 或安装器验收；没有运行 Netty/Tomcat 服务器，没有新增永久测试、修改运行时或生产会话。现有基线通过不证明 A–E 的新增缺口已被覆盖，尤其不证明 C2 候选竞争已复现或排除。

