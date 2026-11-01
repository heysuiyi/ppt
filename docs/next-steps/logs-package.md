# 独立能力切片：日志包抽取

[返回计划目录](README.md) · [项目整体规划](../project-plan.md)

## 独立能力切片：日志包抽取

### 设计依据与范围

借鉴 [DeepSeek Harness 架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)与 [Cordis 的服务依赖和可逆资源效果](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md)：区分能力协议、默认提供者和消费者，明确依赖与资源归属，不照搬其容器、上下文查找、动态装卸或“Everything is a Plugin”。

DeepSeek 的 Session log 是权威会话事实，不等同于本项目诊断日志；其[固定历史提交的遥测设计](https://github.com/deepseek-ai/deepseek-harness/blob/ca5e67490e0ae650823abc6e2994d651eb6b63c4/docs/subsystems/telemetry.zh.md)说明观测导出与执行主干、权威记录分离，不能据此声称当前 master 仍有同一实现。本轮不引入遥测或 OTel，也不改变会话历史和恢复。参考 [Spring Boot 日志初始化](https://docs.spring.io/spring-boot/3.5/reference/features/logging.html)，日志基础设施由宿主初始化，不依赖 Agent/插件系统就绪。

### 实际结构与公开面

| 位置/入口 | 职责 |
| --- | --- |
| `packages/logs/src/` | 原日志实现整体迁入，只调整内部 ESM 相对导入，不改变运行、安全与文件格式 |
| `@agent-ppt/logs/log-contract` | 具名 Logger、记录、输出与管理协议；Node 选项仍为无平台类型依赖的结构类型 |
| `@agent-ppt/logs/logs` | `createLogs()` 通用默认装配；声明和运行闭包不依赖 Node |
| `@agent-ppt/logs/node-logs` | `createNodeLogs()` 的 stderr、实例目录 JSONL、近期记录、配置及清理管理 |
| `packages/logs/package.json`、`tsconfig.json`、`build.mjs` | 私有 `0.1.0`、Node >=24、ESM-only、无运行依赖；独立 JS/声明构建，tarball 只包含 dist 和必要清单 |

没有根导出、通配导出或旧源码兼容层；`internal/` 不开放，只有 `tests/log-safety.test.ts` 精确白盒消费同一 dist 的安全函数。宿主、models、tools 与测试已迁移；Harness 与日志包互不依赖。原日志源码路径已删除，没有两套实现。

Logger 仍为借用的窄能力，不可关闭系统或管理文件；宿主提供目录/配置、管理设置持久化，并在消费者排空后关闭日志实例。记录先进行现有安全快照和遮蔽，输出失败独立记录；保留同步受理和当前 Node 同步文件操作，不声称新增异步队列、无阻塞、跨实例治理或任意文本安全保证。规范历史、检查点、审批和工具副作用语义不变。

### 构建与依赖约束

- `npm run build:packages` 构建两个 workspace；应用构建、类型检查、测试及开发 CLI 在消费前构建。原专用构建助手收敛为 `scripts/workspace-build.mjs`，dev 等待两个首次成功 emit，Main 观察两个包的 JS 产物。
- `scripts/check-logs-boundaries.mjs` 基于 TypeScript 实际解析及 manifest 检查日志包、node/web 消费图；递归检查通用入口的源码、JS 和声明闭包，拒绝 Node 污染、包外依赖和相对路径/源码/私有产物绕过。包内非字面量动态加载被拒绝，无法推断任意消费者计算出的动态目标，不宣称恶意代码沙箱。
- `scripts/verify-logs-package.mjs` 验证真实 tarball 的仓库外离线安装、零运行依赖、无仓库链接、原生 Node 行为及声明消费。只有 Node 消费者显式借用编译工具侧的 Node 类型，通用 NodeNext/Bundler 消费者使用 `types: []` 与 `skipLibCheck: false`。
- Electron 使用显式发行文件集，将包清单与 dist JS/声明放入标准 node_modules 位置；排除 workspace 默认实体中的源码和构建文件，无 afterPack 补拷贝或源码回退。

### 实际验收与限制

| 检查/场景 | 本轮观察结果 |
| --- | --- |
| workspace 安装与独立编译 | 离线安装成功，两个包分别生成 JS 与声明；日志包无运行依赖 |
| 原日志及消费回归 | 5 个相关文件：114 项通过、1 项既有跳过；其中 logs、安全、Node 日志共 31 项通过 |
| 日志边界隔离矩阵 | 18 个场景通过：公共入口/类型查询、标准 lib 与包内 path 引用允许；源码、私有/相对 dist、别名绕过、包外依赖、Node/ambient 污染、越权白盒与运行依赖拒绝 |
| 实际仓库依赖门禁 | Harness 门禁和日志包/node/web 图均通过，保留原约束；日志门禁未跳过 external 声明 |
| tarball 独立消费 | 仓库外真实离线安装，关闭安装脚本，无链接/运行依赖；公共入口可解析，根及私有路径按 exports 拒绝 |
| 声明消费 | NodeNext Node 消费，以及 NodeNext/Bundler DOM 通用消费均通过；通用项目 `types: []`，全部 `skipLibCheck: false` |
| 原生 Node 行为 | 上下文/数据快照、凭据遮蔽、输出故障隔离、借用 Logger 无管理权限、输出仅关闭一次、文件/近期记录一致、设置/清理及关闭后边界通过 |
| 双包监听 | 两个首次 emit 后才就绪；实际新增临时日志模块，增量 emit 后原生 import 取得正确标记 |
| `npm.cmd run build` | 包构建、两套门禁、node/web 类型检查及 Main/Preload/Renderer 生产构建通过 |
| `npm.cmd test` | 192 文件、1632 项通过，2 项既有跳过；未新增锁定源码或简单转发的测试 |
| `npm.cmd run test:integration:harness` | 2 个真实 Electron CLI 集成通过、无跳过；本地 SDK/HTTP/SSE、配置重开、waiting/恢复、拒绝/取消链路保持 |
| `npm.cmd run agent:dev -- --help` | 实际双包构建、Node 启动器和 Electron 帮助成功，未启动生产 UI |
| Biome | 32 个相关代码/配置文件通过；门禁最终引用规则补充后两个脚本再次通过 |
| Windows unpacked/ASAR | electron-builder 生成真实产物，三个入口的 JS/声明及清单均为归档实体，没有日志源码、构建脚本或链接 |
| 实际解包运行 | Electron 43.1.0/Node 24.18.0、仓库外 cwd，以 ASAR Main URL 为父路径原生解析 bare ESM 并执行；通用输出、真实文件与近期记录一致、遮蔽、关闭后行为及私有导入拒绝通过 |

新增验收程序首轮错把 `clearFiles()` 当成删除当日文件，已改为实际创建旧日托管文件并验证只删除旧日、当前文件原文保持；未改变生产清理行为。临时 ASAR 程序的对象比较改为完整 JSON 内容，避免将安全记录的无原型对象与解析后的普通对象原型混为契约。新门禁在实际应用类型查询中暴露缺少 AST parent 的问题，已通过 compiler host 保留父节点修复；补验公共类型查询与引用指令正反例，不通过跳过类型节点解决。

ASAR 验收使用原生 `--experimental-import-meta-resolve` 指定父 URL，没有自定义 loader、源码回退或生产 UI 启动。打包复用已安装 Electron，未验证安装器、签名或重新构建原生依赖。没有调用远程模型、公开发布 npm、迁移旧日志、扩大日志采集或修改生产会话。

本轮临时监听/边界/ASAR 程序、探针、解包目录、独立安装目录与场景数据均已清理，子进程已退出。保留正常包/应用构建产物及可重复执行的日志门禁、tarball 验收入口。日志包抽取完成，不据此宣布 Harness 内核诊断接入、M3 通用组合验收或 M4 生产切换完成。



## 桌面旧日志替换方案与实施记录

本节的桌面日志切换已实施，并完成相关行为回归、类型/边界检查、真实桌面和日志包 ASAR 消费烟测；全量回归存在下述未修改范围的三项失败，不能宣称全仓全绿。当前包名为 `@agent-harness/logs`。本切片不切换 Agent/Gateway 执行协议，不迁移生产会话库，不改变模型调用、审批或 PPT 提交规则。上文仍是历史包抽取记录，不覆盖本次新增的宿主接入。

### 1. 目标与职责

- logs 包成为结构化诊断日志唯一运行时，负责安全快照、过滤、输出、近期缓存和实例关闭。
- Electron Main 拥有日志实例；业务只借用 `Logger`，不取得管理权限。
- 桌面宿主负责目录、环境默认、设置持久化、上下文传播、历史查询、展示投影和应用退出。
- Gateway 模型 I/O JSON 档案仍由 Gateway 拥有，不纳入通用诊断记录；宿主继续汇总其占用、保留和清理结果。
- 删除旧日志写入器、重复安全序列化与全局 recent 实现，不保留旧路径重导出或双写。

### 2. 已确认的差异

|行为|桌面旧实现|logs 包当前实现|
|---|---|---|
|记录结构|module、数据和上下文扁平合并|name、context、data 分层，带 instanceId/sequence|
|日期/目录|本地日，根下 agent-YYYY-MM-DD.log|UTC 日，实例目录下 diagnostic-YYYY-MM-DD.jsonl|
|终端|console 分级方法，带前缀|各级别统一输出 stderr JSONL|
|最低级别|一个全局门槛|terminal/file/recent 独立门槛|
|设置|读取环境与 settings.json，更新时持久化|显式传参，不读取环境、不持久化|
|上下文|AsyncLocalStorage，写入时读取|child() 绑定时快照|
|recent|启动回读历史，最多 300 条|仅本实例内存，不回读历史|
|状态和保留|旧根日志与 Gateway 汇总|仅当前实例目录|
|手动清理|包含当天、Gateway 和 recent|仅本实例早于 UTC 今天的文件，不清 recent|
|错误与预览|可输出 Error.message/stack；另有二进制字符串省略|Error 仅安全标量；不等价于旧预览的二进制省略策略|

不能直接用 getFileStatus()/clearFiles()/getRecentEntries() 替换原 IPC 并声称行为相同。新实例不会回收旧 UUID 目录，必须解决跨启动保留，不能让“保留 7 天”只作用于本次进程。

### 3. 宿主组织与上下文

在 `app/main/` 新增职责明确的桌面日志模块，不放回 `agent/`；使用具名入口，不新增 index.ts。内部区分宿主装配、设置存储、历史文件管理和展示投影，不建立通用容器。

先装配日志，再构造 SessionStore、AgentGateway、AgentRuntime、AgentEventPorts、窗口与导出服务。移除静态模块顶层获取已初始化日志实例的做法，通过构造参数或现有选项借用 Logger。`model-call-recovery` 从所属执行依赖取得 Logger，不另查全局服务。

本轮保留宿主 AsyncLocalStorage 的嵌套合并策略：Main operation、Runtime query、事件回调和 Gateway 档案共享同一上下文来源。宿主创建的上下文感知 Logger 在写入时通过底层 child(context) 绑定当前身份；不在每条调用处手工复制 ID，不将 ALS 加入通用 logs 包。固定 child 上下文与环境上下文的合并优先级必须具名定义，调用数据不能覆盖身份字段。

`console:false` 未发现生产调用方，不为这个旧字段扩展通用路由 API；删除无用字段。requestSummary 的正文采集策略仍属于宿主，AGENT_LOG_DETAIL 不转成 logs 包的环境依赖。

诊断预览不能先把原始对象 JSON.stringify 成字符串再交给脱敏器。为现有结构预览消费者提供窄的、基于包内同一安全投影的公开辅助能力，复用预算、凭据遮蔽与安全对象访问；补齐二进制字符串省略，禁止复制旧安全实现到宿主。Error.message/stack 不恢复为通用默认输出；调用方需要展示的错误使用已有公开安全错误码或受控消息。

### 4. 设置与桌面展示

保留桌面日志 IPC 通道和必要展示 DTO，不将 NodeLogs 管理对象暴露到 renderer。AppLogEntry 是展示投影，不作为规范磁盘格式。

- level 映射三个输出的 minimumLevel；fileEnabled 只控制诊断 file 输出；recent 固定开启、容量 300。
- 继续使用已有日志根与 settings.json。合法持久字段优先于环境默认，再使用内置默认；宿主规范化历史配置后传给严格的包接口。
- settings 更新串行化，补丁受理时快照；校验后更新运行配置，再以原子文件替换保存。持久化失败明确报告“运行已生效、保存失败”，返回/刷新权威有效设置，不伪称事务回滚或自动重试。
- name 映射 module；context 身份优先于 data；timestamp、level、event、scope 为保留字段，最后显式写入，禁止任意 spread 覆盖。
- 日志面板摘要适配新安全错误结构，必要时显示错误码；不得为了保留旧摘要而重新暴露 SDK 异常正文。
- 更新“每日一个文件”为“按实例、UTC 日期归档”；UI 仍按用户本地时间显示事件时间。
- 将 fileEnabled 文案与健康状态分开；关闭诊断文件不表示关闭 Gateway 档案。

### 5. 历史与清理：保持功能，不伪装等价

宿主提供只读历史查询：有界尾读旧日文件与新实例 JSONL，解析后安全投影，与当前 recent 合并。新记录按 (instanceId, sequence) 去重；旧记录使用文件位置身份，不能按事件文本去重。先形成最新 300 条候选，再按最低级别和 limit 查询，保持现有面板的容量语义。损坏尾行不阻断其余记录；不读取 Gateway 正文作为近期问题。

旧文件只作读取/管理，不转换重写、不再追加。文件枚举仅允许已确认归属的目录和格式，拒绝链接与未知文件，不沿用旧实现“任意 .log 都可删”的宽泛规则。

完整清理已通过 logs 包的实例级 reset 管理能力实现：在既有管理队列中同步删除本实例托管文件（包含当天）并清空 recent，后续日志仍可正常写入。已有 child Logger 保持有效；clearFiles() 的原语义不变。reset 只管理自身实例，不扫描外部目录；失败不伪报成功。

桌面诊断文件位于 `<root>/desktop/<ownerId>/<instanceId>/`，独占容器和 owner.json 标记确定归属。proper-lockfile 的所有权锁保持至 close，配置 stale=Number.MAX_SAFE_INTEGER、update=1000、retries=0，不按 mtime 自动接管。历史删除必须先取得对应所有权锁；活动实例、无法确认身份及异常退出遗留锁保守跳过。自动保留和手动清理的 skipped 均进入状态/UI，不提示“全部清理成功”。设置文件及原子写入产生的 settings.json.bak 不作为待回收日志。

宿主枚举当前诊断、历史诊断、旧日志及 Gateway 后汇总状态，未新增独立分组 UI；不把实例级 getFileStatus() 当作全应用占用。保留天数作用于可安全管理的范围，未知或持锁范围明确跳过；新 JSONL 按 UTC 文件日期、旧日文件按原本地日规则处理，不改文件名重新解释日期。

清理与查询、保留、设置更新共用宿主管理顺序。Gateway 保留进程内 root 队列，跨进程使用每个归档文件的独占锁；写入和删除同一文件遵守同一锁。弃锁只保护对应旧文件，不阻断新 requestId，正常不同 ID 不竞争固定根锁。不删除空日目录，避免与其他进程创建归档竞态；未知文件、链接和活动档案报告跳过。“打开目录”继续定位总根目录。

### 6. 启动、失败与退出

- 在 Electron 异步启动函数中创建日志，不顶层 await app.whenReady()。创建成功后才发布业务服务。
- 初始化文件输出失败不得静默降级后仍显示“文件运行中”；通过独立 stderr 报告安全的启动错误，清理本次已创建资源并使启动失败。
- 正常退出采用可等待、可重入的 before-quit 阶段：停止受理业务和管理 IPC，中止并排空活动执行，关闭仍可能产生日志的业务资源与数据库，写最后收尾记录，await logs.close()，最后继续退出。
- 不能仅把 will-quit 回调改为 async；Electron 不会因此等待。异常初始化退出也须能走幂等清理；日志 close 后的错误只走独立的安全 stderr 出口。
- 只补充保证日志所有权所必需的退出协调，不在本切片重做 Agent 的执行/恢复协议。

### 7. 实施顺序与交付门槛

1. 定稿实例 reset、共享安全预览及宿主历史所有权协议；运行公开符号引用分析，明确所有消费者与边界门禁。
2. 实现桌面日志组合根、设置存储与上下文；迁移全部旧 logger 消费者，移除旧写入实现。
3. 接通历史查询、全范围统计、保留与清理；接入 Gateway 档案管理，完成 IPC/面板投影与文案。
4. 接通初始化失败和可等待退出；更新受影响回归与现有计划状态，同轮完成切换，不把未实现的管理能力留作后续占位。

|验收范围|必须观察的结果|
|---|---|
|真实桌面入口|启动后能查看诊断日志；renderer 上报、模块名、事件与本地时间显示正确|
|上下文|并行/嵌套异步操作身份不串线；Runtime 与 Gateway 档案关联一致|
|安全|Key、URL 凭据不泄漏；循环/访问器/大对象受控；图片字符串不进入预览|
|设置|旧设置加载、三个门槛映射、文件开关、保存失败有效状态、重启后持久值正确|
|历史|两次启动均可查历史；重叠 recent 不重复；损坏尾行不阻断查询|
|文件管理|清理当天与 recent 后仍可写；旧实例保留生效；Gateway 占用计入；其他活动实例/未知文件/外部哨兵不误删|
|故障与退出|输出失败不改变业务结果；退出重入安全；活动收尾日志先于 close；初始化失败不遗留自有资源|
|包与发行|日志行为回归、包边界、类型检查、真实 tarball 和 Electron ASAR 消费通过|

实施时运行相关行为回归、npm run typecheck、受影响静态检查与全量回归，并实际启动桌面验证日志页面。不重新钉住旧 console 前缀、本地日文件名、凭据首尾展示或源码字符串等实现断言；保留跨启动、权限、上下文、清理和生命周期等消费者可见回归。所有破坏性验收只使用自建临时目录。

### 8. 设计阶段的历史验证

使用现有构建产物，通过原生 Node 公开入口在临时目录创建、写入、清理、关闭并重建两次 NodeLogs。观察到首实例 fileCount=1，clearFiles() 删除数=0，清理后 recent=1，重建后 recent=0；记录保留 runId，apiKey 完整替换为 [REDACTED]。确认实例目录和当天 JSONL 实际存在；结束后删除本次临时目录。

以上仅为设计阶段的实例行为验证，不代表当时已完成桌面切换；本次实施与新增验证见下一节。未调用远程模型，未修改生产日志或生产数据库。

### 9. 桌面切换实施与验证证据

实现位置：

- `app/main/logging/desktop-logs.ts`：日志实例所有权、管理队列、设置生效、日切治理、关闭。
- `app/main/logging/log-history.ts`、`log-settings.ts`：实例归属、锁保护、有界尾读、安全投影、跨启动查询及原子文本设置保存。
- `app/main/logging/log-context.ts`、`request-summary.ts`：宿主 ALS 与显式 child 身份快照、正文摘要策略；通用包不读取宿主环境。
- `app/main/index.ts`：日志先装配、业务借用注入、IPC 准入和 Promise 排空、可等待且可重入的 before-quit。
- 日志面板保留桌面展示协议，支持安全错误摘要、实际清理计数/跳过原因、运行已生效但保存失败的状态。
- `app/main/agent/logger.ts` 和旧 `tests/agent-logger.test.ts` 已删除，无旧实现兼容层或双写。

|检查/场景|实际观察|
|---|---|
|日志包与宿主/Gateway 相关行为回归|11 文件、156 项通过；之后设置备份排除修正再次运行宿主 18 项，全部通过|
|修复前/后证据|损坏设置无法保存、首次治理失败遗留资源共 2 项先失败后通过；归档活跃文件误删和固定弃锁阻断写入共 2 项先失败后通过|
|类型与边界|npm run typecheck 通过；最后宿主修正后 Node/Web/CLI 三个 tsc 项目再次通过|
|静态检查|本轮支持文件经 Biome 修正/检查；未用源码字符串测试替代封装|
|日志包 tarball|仓库外离线安装、零运行依赖、NodeNext/DOM 声明消费、私有入口拒绝、安全快照、reset 后原 child 真实文件续写通过|
|桌面生产构建|Main/Preload/Renderer 的 electron-vite build 通过|
|真实 Electron 桌面|独立临时 HOME/USERPROFILE、日志根及应用数据根；通过真实 preload/IPC 上报 warn，在日志页面看到模块/事件/摘要，apiKey 为 [REDACTED]|
|真实清理与重启|清理 IPC 删除当天文件并清 recent，之后仍能写入；重启回读该 warn 且非默认保留 11 天生效；最终 settings.json.bak 不再产生伪“未回收”告警|
|真实退出|三次空闲桌面及一次活动模型流退出均为 0，无关闭失败报告。活动场景使用真实生产桌面/Gateway/SDK→受控本地 HTTP/SSE；观察到 /v1/responses 请求、流被中止、agent.query.interrupted 和 session.operation.completed 先于 application.stopping，failedResources=0；关闭后 SQLite runs 行持久化为 interrupted 且 completed_at 已写入|
|真实 Electron ASAR 日志消费|Electron 43.8.6 从真实 ASAR 的 node_modules 加载包，完整遮蔽、安全预览、reset、既有 child 后续 JSONL 写入/回读通过|
|隔离与清理|未调用远程模型；临时桌面进程均退出，专属数据/日志、ASAR 宿主脚本、归档和输出目录已删除|

全量 `npm test` 实际执行一次，观察到 202 个文件中 199 通过、3 失败，1816 项通过、3 项失败、3 项跳过；之后新增的复核回归单独验证。失败均在本次未修改的模型/CLI 实现范围，不据此修改其他并行工作：

- `tests/development-setup.test.ts`：Anthropic 配置预期 openaiApiMode=responses，实际 undefined。
- `tests/models-anthropic.test.ts`：畸形 JSON SSE 的 SDK 向 console.error 输出了测试载荷。
- `tests/models-configured-host.test.ts`：Anthropic 路径预期 /v1/messages，实际 /v1/v1/messages。

限制：未验证安装器、签名、远程厂商模型或真实远程执行的退出排空；活动退出仅证明受控本地 HTTP/SSE 场景，不泛化为全部模型或协作任务兼容。日志包 ASAR 烟测不等同于整个桌面安装包验收。异常强退遗留且无法证明非活动的锁仍需显式人工确认，不自动强制回收；该限制已通过真实子进程回归及 UI 跳过状态表达。
