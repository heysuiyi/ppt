# 持久化职责收敛与后端替换契约

状态：2026-11-01 **P1 SQLite 职责收敛与 P2 Thread 原子准入已实施并完成本地行为验收**；后续 M3-C 已补齐竞争与兼容验收，见第 14 节。P3 第二后端、P4 数据迁移/包边界仍待执行。第 10 节保留修复前调查证据，第 13 节记录 P1/P2 实现与实际检查；未新增数据库驱动或迁移用户数据。

调研期间并行 CLI 工作将宿主实现从 `app/main/agent-host/` 迁到 `cli/host/`。本文以最后读取的 Node 宿主文件为设计落点；临时场景也已切换到该实现运行。路径存在不代表新 CLI 已整体验收，CLI 状态仍以[其实施记录](cli-terminal.md)为准。

## 1. 决策

本次应收敛的是**执行持久化的职责、操作保证和可替换后端契约**，不是减少 SQL 行数，也不是建设 MyBatis-Plus、通用 Repository 或全项目数据库包。

1. **Core 拥有执行事实及协议；宿主拥有恢复环境、授权策略和会话展示；适配器拥有物理表、事务、连接和迁移。** SQL 属于实现相应端口的基础设施，不要求所有 SQL 永远留在应用入口，也不要求全部进入 Harness。
2. **先在实际 Node 宿主内收敛，不立即新建 `sql`/`storage` workspace。** History、Checkpoint、binding 和列表存在真实的跨表操作保证。把前两项单独搬走，再公开原始连接或让宿主直查包的私有表，不是完整解耦。
3. **后端替换以完整宿主持久化能力为单位。** 除 History/Checkpoint，还包含不可变 binding、只读目录查询、schema 管理与运维迁移；只实现 Core 两个接口不等于 CLI 已可切换数据库。
4. **Thread 准入是独立的可靠性前置。** Query 围栏和历史 CAS 本身不能阻止新 Query 越过待决交互；本轮已补齐原子准入，并验证所列 SQLite 窗口，不据此泛化到未认证后端或完整故障矩阵。
5. **先认证一个真实第二后端，再稳定抽包。** 建议 PostgreSQL 作为首个服务端验证对象；MySQL 使用同一组行为契约、独立适配与验收，不提前加入空适配器，不承诺换连接串即可兼容。

这与 models/logs 的抽取不同：持久化适配器本来就依赖它所实现的领域协议，其独立性是“不依赖 Loop、具体 UI/SDK、私有表访问和宿主服务定位”，不是“不依赖 Core 的公开类型”。

## 2. 现状与数据权威

### 2.1 代码证据

| 位置 | 已观察到的职责与边界 |
| --- | --- |
| [`session-contract.ts`](../../packages/harness/src/agent/session/session-contract.ts) | 规范消息、有序批次、历史 revision、稳定 batchId；checkpoint 内的追加意图、待决交互、回答消费续传、dispatched 与工具结果 |
| [`checkpoint-contract.ts`](../../packages/harness/src/agent/session/checkpoint-contract.ts) | Query key、owner/generation 围栏、revision CAS、显式接管、非重入 acquire；I/O 拒绝不等于未提交 |
| [`run-controller.ts`](../../packages/harness/src/agent/runtime/run-controller.ts) | run/resume 统一根据原子 acquire 裁决准入；不再以独立 unfinished 查询判定；恢复身份/版本/预算校验保留 |
| [`checkpoint-session.ts`](../../packages/harness/src/agent/runtime/query/checkpoint-session.ts) | 先保存历史追加意图，再用原 batchId 提交历史，最后确认 checkpoint；不假设两个 store 共享事务 |
| [`cli/host/sqlite-agent-stores.ts`](../../cli/host/sqlite-agent-stores.ts) | 只装配 history/checkpoints/bindings 与统一关闭；共享连接、事务和 DDL 位于私有 internal/sqlite，目录独立只读打开 |
| [`host-session-binding.ts`](../../cli/host/host-session-binding.ts) | 当前 v2 恢复环境，包含 workspace、工具配置、模型选择/连接指纹、定义/插件版本和预算；禁止携带连接凭据和地址 |
| [`session-directory.ts`](../../cli/host/session-directory.ts) | 只查询已有数据库，不因列目录创建存储或租约；目前仍指定 SQLite 文件 |
| [`sqlite-session-queries.ts`](../../cli/host/sqlite-session-queries.ts)、[`session-persistence-contract.ts`](../../cli/host/session-persistence-contract.ts) | 只读 SQLite 投影与宿主展示 DTO 分离；保留未完成 Query 正文排除，不对外导出原始存储或 replay |
| [`create-agent-host.ts`](../../cli/host/create-agent-host.ts) | 宿主装配并拥有资源；执行先排空，随后释放模型等依赖、存储、日志 |

`bindings.ensure()` 不是单表 upsert：现有实现同事务检查既有 binding；同值成功、异值拒绝；没有 binding 但已经存在 history head 或任意 Agent 的 checkpoint 时拒绝收养，最后才插入绑定。即便历史是空批次、checkpoint 没有 payload 或已经释放 writer，也属于已有状态。拆成三个独立查询再插入会降低现有保证。

该保护不等于数据库禁止一切无 binding 写入：Core 的直接 History/Checkpoint 端口目前没有“必须先绑定”的约束。

### 2.2 谁定义内容，谁管理数据

| 数据 | 语义与版本所有者 | 物理管理者 | 能否从展示/日志重建 |
| --- | --- | --- | --- |
| 规范消息、工具调用/结果、批次收据 | Core 执行协议；私有 replay 由模型适配器解释 | 执行存储适配器 | 不能；只保留可见文本会丢恢复依据 |
| checkpoint、追加意图、待决交互、已消费回答状态、累计步数 | Core；continuation/extensions 的内容由其生产者解释 | 执行存储适配器 | 不能；不可从 UI 快照或进度事件重建 |
| workspace、连接身份、配置/能力版本绑定 | 宿主配置与 binding 协议 | 宿主持久化适配器 | 不能跟随当前 UI 选择重新绑定 |
| PPT 等业务对象、提交、业务版本和业务审批 | 各业务领域 | 对应领域 repository/适配器 | 不归 Harness，也不纳入本轮 SQL 收敛 |
| 模型连接配置、受保护凭据 | configuration/宿主 | 对应配置与 OS 保护适配 | 不复制到执行数据库、迁移清单或公开诊断 |
| 会话目录、文本摘要、终端结算范围 | 宿主查询/展示协议 | 同库只读查询或之后明确允许陈旧的投影 | 可重算；不是授权、接管或恢复的权威 |
| 诊断日志 | logs 与宿主 | 日志输出端 | 不是审批账本，也不是执行恢复存储 |

“只依赖协议”不表示无人管理数据。正常消费者通过端口操作；适配器交付 schema、索引、迁移和故障语义；宿主/运营方负责数据库账号、备份、恢复与切换。受控运维可以使用数据库工具，但不能绕过执行协议直接改 JSON 来批准工具或重做副作用。

### 2.3 Thread 命名空间必须说明

当前 history 按 `threadId`；checkpoint 按 `agentId/threadId/queryId`；unfinished 按 `agentId/threadId`；宿主 binding 则按全局 `threadId` 固定一个 agentId。

- 默认宿主继续采用一个 Thread 固定一个 Agent 的现有绑定约束，threadId 在所用历史存储命名空间内不可碰撞。
- Core 没有统一强制 Thread→Agent 所属，也没有跨 Agent 共用 Thread 的已验收协议。不能把宿主约束默认为 Core 已保证的事实。
- 本轮不修改 History key，不新增多 Agent 共享同一 Thread 的能力。后端认证按上述默认宿主配置执行；若需要共享 Thread，另行设计其历史串行化、归属和授权。
- 第 5 节的最小准入修复先覆盖既有 `agentId/threadId` 规则，不顺手改变所有身份作用域。

## 3. 优秀方案：采用什么，不照搬什么

| 参考方案 | 官方设计提供的启发 | 本项目采用与限制 |
| --- | --- | --- |
| [DeepSeek Harness Session Persistence](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/persistence) | 一致的逻辑事件格式；持久化 provider；含读写所有权的 SessionHandle；create/open/stat/list；元数据与事件体分离 | 借鉴完整后端能力、只读观察、所有权和版本拒绝。它的 append 成功只保证实例内可见，flush 才承诺 crash durability；**不能照搬其 write-behind/flush 语义，降低本项目 append/save 成功即持久提交的契约** |
| [Spring Framework DI](https://docs.spring.io/spring-framework/reference/core/beans/dependencies/factory-collaborators.html) | 消费者通过构造/工厂参数取得依赖，不自行查找实现；必要依赖初始化后发布 | 宿主显式选择完整适配，业务只拿所需端口；不建 IoC 容器、扫描、Service Locator 或数据库全局单例 |
| [Spring Batch 5.2 JobRepository](https://docs.spring.io/spring-batch/reference/5.2/job/configuring-repository.html)、[metadata schema](https://docs.spring.io/spring-batch/reference/5.2/schema-appendix.html) | 框架拥有执行元数据模型；repository 事务、创建竞争隔离、version 乐观锁、按数据库的 DDL/迁移 | 比通用 CRUD 更接近本问题。借鉴执行状态 repository 与后端专用事务；不复制 Job/Step 状态机，也不机械统一为 SERIALIZABLE。此处固定参考 5.2，不表示它是最新版本 |
| [LangGraph checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)、[interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) | Thread/checkpointer 持久化、待决执行、super-step/task 级 pending writes；interrupt 可跨进程恢复 | 借鉴状态边界与人工交互的持久性。它恢复时会从节点起点重跑，官方要求副作用幂等；本项目已有显式 continuation 与 unknown 语义，**不改成节点重放** |
| [Temporal Event History](https://docs.temporal.io/workflow-execution/event)、[Visibility](https://docs.temporal.io/visibility)、[Activity idempotency](https://docs.temporal.io/activity-definition) | 权威执行历史和最终一致查询分离；已完成 Activity 的观测记录不等于外部操作只执行一次 | 目录只用于发现，恢复/批准重新读取权威状态；不引入 Temporal 服务、全量 event sourcing、Activity 自动重试或补偿引擎 |
| [Dapr state management](https://docs.dapr.io/developing-applications/building-blocks/state-management/state-management-overview) | 可替换 store 仍需明确 ETag、事务、并发与一致性能力；不同后端能力不同 | 借鉴“按能力契约认证”。Dapr 默认的最终一致/last-write-wins 不适用于这里的控制状态；不引入 Dapr、任意 KV 或缺少能力时的弱保证回退 |

DeepSeek 官方站和 master 文档为本次读取时的滚动资料，不能用它们证明本项目采用了同一实现。尤其“持久化协议可替换”不等于上游已为本项目验证 SQLite、PostgreSQL 和 MySQL 的等价语义。

## 4. 优先处理的问题

| 优先级 | 问题 | 后果与处理边界 |
| --- | --- | --- |
| 已修复并验证 | 新 Query 准入与 Query 租约分离，曾复现越过 waiting | 第 5 节已由 Core/SQLite 与全部端口实现共同落实；跨进程三窗口与第三进程重开通过，完整故障矩阵不据此完成 |
| 必须保持 | binding 的不收养已有状态保证依赖跨表事务 | 私有同后端协调器统一处理；不能拆成无协作 store，也不能普通 upsert 覆盖环境 |
| 必须补齐 | 目录和宿主工厂指定 SQLite 文件 | 第二后端必须同时提供 binding 与查询；保留只读、不初始化的发现路径 |
| 必须补齐 | 目前启动主要依赖 CREATE TABLE IF NOT EXISTS | 增加明确的 schema 版本、升级与拒绝规则；该语句不能证明旧库兼容 |
| 必须认证 | SQLite 的全局写事务掩盖了读后写之间的竞争 | PG/MySQL 逐操作明确锁、唯一约束、隔离与失败分类；不能只改 SQL 方言 |
| 必须定义 | 提交确认丢失、迁移中断、旧 writer 未停止 | 对账、明确未知、停止并隔离旧写入方；不能透明重跑整个请求或工具 |
| 按需求独立设计 | 完整审批审计、长期保留和防篡改 | 当前待决/回答消费不是完整审计账本；本轮不默认新增审计服务或 outbox |

## 5. 操作契约与最小准入修复设计

以下为实施要求；除明确列出的当前行为外，不表示已经实现。

### 5.1 保留现有端口语义

| 操作 | 必须保持的行为 |
| --- | --- |
| `history.read` | revision 与有序 messages 来自同一一致视图；读不存在的 Thread 不创建 head；不能读出新 head 配旧 batches |
| `history.append` | 整批原子、有序；先查 batch receipt。同 ID/同内容返回原 revision，即便 expectedRevision 已旧；同 ID/异内容明确错误；没有 receipt 才判 revision conflict |
| `checkpoint.acquire` | 所有写入方之间互斥；相同 ownerId 也不重入；replace 必须匹配完整旧 lease；generation 不重用，无 TTL/自动接管 |
| `checkpoint.save` | 先判完整 owner/generation 围栏，后判 revision；stale 优先于 conflict；成功时 payload/revision/status 一起提交 |
| `checkpoint.release` | 只释放精确 lease，重复幂等，不删除代际记录，不影响新 writer |
| `binding.ensure` | 原子地确认同值或创建；异值拒绝；没有 binding 却已有任意执行状态时拒绝收养；不从当前 UI 重建 |
| 目录查询 | 只读；缺库不创建；返回同一读视图下的投影；私有 replay、工具原始参数/结果、reasoning、Key 不进入展示 DTO |

不因当前同库而废除“追加意图 → batch receipt → checkpoint 确认”的跨 store 恢复协议。SQL 事务只包住短存储操作，不覆盖模型、工具、网络或等待人工回答。

### 5.2 原子 Thread 准入：复用 M3-C2 的最小修订

与已制定的 [M3-C2 方案](m3-c-persistence.md#31-最小修复决策加强现有-acquire不增加第二把-thread-锁)统一：**加强现有 CheckpointStore.acquire，不另增 start 方法、公开 ThreadLease、Registry 或第二套释放协议。** 已有 Query 行可以承担初始化保留，关键是原子检查必须识别活动 owner，而不只检查非终态 payload。

`CheckpointAcquireResult` 已增加 `{ status: "thread-pending"; queryId: string }`，运行时映射到既有 `THREAD_PENDING`；以下为本轮已落实的原子准入规则：

| 顺序/窗口 | 原子操作要求 |
| --- | --- |
| 目标 replace | 先比较完整旧 lease；stale 不取得任何所有权 |
| 目标已持有 owner | 保留同 key 的非重入 busy，ownerId 相同也不绕过 |
| 其他 Query | 同 `agentId/threadId` 下，只要其他行仍有 owner，或 status 为 running/waiting/interrupted，就返回 thread-pending；目标行、generation、revision 不变化 |
| 允许取得写权 | 同一事务中插入/更新目标行、推进 generation、返回权威 checkpoint；冲突检查到取得租约之间不能留下窗口 |
| 首次 acquire 后、首次 save 前 | 无 payload 但有 owner 的行已经阻止其他 Query，不能等待初始 checkpoint 才算准入 |
| 终态 save 后、release 前 | 仍有 owner 的行继续阻止新 Query；release 以后才开放 |
| legacy 空行 | 已释放且没有 payload 的行不阻塞其他 Query，但保留 generation；不能删行重用围栏 |
| 提交确认未知（D2 待验收） | 契约要求拒绝并报告不确定；按原 Query 权威状态和显式接管规则恢复，不生成新 Query 绕开，也不盲目再 acquire。P2 正常竞争窗口通过不等于此故障窗口通过 |

`run()`/`resume()` 统一按 acquire 结果裁决；删除运行时分离的 unfinished 前置准入检查。`findUnfinished` 继续用于发现，不再作为并发安全判断。初始历史读取与后续 append 仍受 History CAS 保护，不因此要求 History/Checkpoint 共享事务。

SQLite 继续使用现有写事务与 checkpoint 行，不增加第二套 Thread 锁表。PG/MySQL 为实现相同契约，可以选择内部稳定同步行/约束及一致锁顺序；这不是对外增加一把 ThreadLease。binding.ensure 及首次执行状态创建也要参与保护其跨表存在性检查的同步点，不能靠单进程 Map/mutex。

本轮已同步 SQLite、完整内存 store、结果消费者、声明与包消费夹具，不留旧语义实现。checkpoint v1、Host binding v2 和 SQLite 表格式保持；异常库中多个 unfinished 不自动挑赢家、删除或终结。所有并发 writer 必须一并升级：旧 writer 不执行新检查，新版不能单方面保证新旧代码混用安全。

## 6. 后端差异不能藏在统一 CRUD 后面

| 事项 | SQLite 当前基础 | PostgreSQL 实施要求 | MySQL 实施要求 |
| --- | --- | --- | --- |
| 写入同步 | BEGIN IMMEDIATE 提前取得唯一写事务；WAL 仍是单 writer | 普通 SELECT 不锁；现有行 FOR UPDATE，首次创建用唯一约束/稳定 guard。不存在的行不能靠 FOR UPDATE 锁住 | InnoDB 默认 RR；区分快照读与 locking read，明确 gap/next-key 行为；统一锁顺序处理死锁 |
| history 整批追加 | 同事务内 receipt、revision、batch、head | 锁 Thread/head 后先查 receipt，再 CAS；并发 ON CONFLICT DO NOTHING 后必要时用下一条语句读取赢家 | 同样由唯一约束和锁内逻辑裁决；不依赖通用 upsert affectedRows，不用 INSERT IGNORE 吞掉其他错误 |
| 一致读 | 目录与 history.read 均使用一致只读事务，不为读取取得写锁 | RC 的多条 SELECT 不是一个固定快照；选择单 SQL 或明确只读一致快照事务 | 不能随意混合 RR 一致性读与最新 locking read，再宣称同一快照 |
| CAS 结果 | 写事务内先围栏再 revision | 条件 UPDATE/RETURNING 或锁内分类；0 rows 后无锁补查不能严格解释最初失败原因 | affectedRows 随 CLIENT_FOUND_ROWS/实际变更而不同；成功应真实推进 revision，并锁内分类 stale/conflict |
| 排序 | MAX(updated_order)+1 受当前单 writer 保护 | sequence 可有缺口且不是提交顺序；按查询需求定义更新顺序与稳定 tie-breaker | AUTO_INCREMENT 也不能自动证明提交顺序；不得照搬全表 MAX+1 作为并发分配 |
| durability | 当前 WAL + synchronous=FULL；不代表网络文件系统/多机支持 | 认证 fsync/synchronous_commit 与实际部署配置；异步确认不能冒充相同 crash 保证 | 认证 InnoDB flush 配置，启用 binlog 时同时说明 sync_binlog；半同步不等于副本已执行 |

实现约束：

- **失败分类**：数据库 lock timeout/busy/deadlock 不是领域 `busy`；SQL 异常不是 revision `conflict`；连接错误不证明 COMMIT 没发生。只对已知回滚且不含外部效果的短事务讨论有界重试，本轮不默认增加重试。
- **权威读取**：租约、CAS、审批消费、恢复和提交未知对账走权威写入侧。副本只能承担明确允许陈旧的展示，不能从空列表推导可启动或可接管。
- **数值**：generation/revision 保持 JS safe integer 契约；驱动返回 BIGINT/string 需显式校验，禁止静默 Number 转换丢精度。
- **ID 相等**：定义大小写、Unicode、尾空格的准确语义与长度上限。MySQL 默认不区分大小写的 collation 不能直接用于关键 ID 的唯一性；使用经过实际验证的二进制/精确比较方案。
- **内容保真**：保留有序调用、结果、replayState、continuation、extensions；内容相等遵循现有协议值语义，不比较数据库重新输出的 JSON 文本字节。不能假设 JSONB/MySQL JSON 原样保留字段顺序。
- **格式校验**：Core 拥有逻辑版本与恢复含义，适配器拥有物理编解码与列/payload 一致性。当前 JSON.parse 加类型断言不是完整 schema 校验；迁移/导入必须检查身份、状态索引、修订、历史前缀和版本，不能默默“修好”未知载荷。
- **环境认证**：驱动、引擎版本、隔离级别、连接标志、关键 durability 参数与运行平台写入验收记录；接口相同不是支持声明。

## 7. 宿主持久化模块与物理落点

### 7.1 第一轮只收敛现有实现

本轮已在实际保留的 `cli/host/` 完成下列职责拆分，使用具名入口，没有新增 index.ts：

| 文件/区域 | 职责 |
| --- | --- |
| `host-session-binding.ts` | 继续拥有宿主 v2 binding 结构、严格验证与恢复环境语义；不移入 Core |
| `session-persistence-contract.ts` | 从 SQLite 文件迁出宿主查询 DTO；Core 的 History/Checkpoint 类型直接复用，不重新定义副本 |
| `sqlite-agent-stores.ts` | 具名写适配装配入口，返回 history/checkpoints/bindings 与统一 dispose；不公开数据库句柄 |
| `sqlite-session-queries.ts` | 具名只读查询实现；不调用写工厂、不运行 migration、不取得 lease |
| `internal/sqlite/` | 私有连接/事务、现有 DDL、history/checkpoint/binding；同后端协调跨表不变量。版本化迁移仍是后端替换前的后续工作，不新增空迁移框架或通用 SQL driver 层 |
| `session-directory.ts`、`create-agent-host.ts` | 负责当前宿主的数据根、发现与资源所有权；终端不获得数据库、存储全集或租约 |

以上落点已实现，`readSqliteAgentSessions` 与 DTO 的调用方已经迁移，没有旧入口 re-export；不恢复已删除的 Electron 桥接、不复制回 app。若未来桌面也成为实际消费者，先决定共享宿主协议及完整事务边界，再建立受控共享模块；禁止桌面导入 CLI 私有源码，或 CLI 反向导入 app。

### 7.2 第二后端到来时的替换单元

宿主选择一个完整的后端配置，装配同一数据集上的三类能力：

1. **执行端口**：Core SessionHistoryStore/CheckpointStore；应用只注入这些端口，不组装 Loop 内部类。
2. **宿主状态端口**：现有 HostSessionBindingStore，包括不可变性与“不收养”保证。
3. **宿主只读查询**：从真实消费者收敛具名 `HostSessionQueries.list` 输入/结果；与 Core 规范数据分开，保留一致快照和 CLI 当前的未完成 Query 正文排除规则，不用文本匹配猜消息归属。

schema/迁移、备份和导出属于适配器管理面，不注入 AgentServices。写连接/连接池由组合根拥有，端口借用；只读目录可以独立打开已有资源，不能为了取得查询端口先初始化写数据库。池/连接在 Run 排空后关闭。

首轮只有 SQLite 时，不提前增加包含未实现 PG/MySQL 的 provider 枚举、发现注册表或 SQL 方言接口。第二后端必须真正覆盖上述三类能力，才能引入其选择与配置。

### 7.3 为什么暂不只抽 Core SQLite 包

独立包若只返回 history/checkpoints，宿主 binding.ensure 仍需要原子判断已有 Core 状态，目录仍需要一致读。解决前不接受以下替代：

- 宿主导入包的私有 schema 或公开 raw DatabaseSync/pool；
- 将 binding 检查改成独立异步查询，悄悄失去原子性；
- 把 workspace/TerminalToolsMode 塞进 Core；
- 以任意 KV、任意 SQL callback 或上下文服务查找掩盖缺少的操作契约。

推荐先完成完整宿主适配与真实第二后端证明，再决定是否发布一个依赖 Core 公开契约的持久化包。若包化，协议、默认实现、迁移、连接生命周期和验收同时交付；不能只留下接口集合，把所有实现重新推回 main。此决定不阻止今后包内支持多种数据库，也不要求每个数据库一个包。

## 8. “审核”需要分开定义

| 含义 | 本项目应如何处理 | 不能声称的内容 |
| --- | --- | --- |
| 工具授权/人工审批 | 宿主策略独立提供；回答只匹配已存 pending；消费按 checkpoint CAS；恢复重新授权；换数据库不能改变允许/拒绝/取消语义 | 不能从“数据库已保存 waiting”推导外部工具恰好一次 |
| 审计追溯 | 当前 checkpoint 是可推进的恢复状态，不是永久审批账本。若明确需要合规审计，另行定义 interactionId、受信任审批主体、决定、策略版本、时间和消费结果 receipt | 不能从诊断日志或临时 interaction.resolved 事件推导防篡改、永久保留、认证身份 |
| 后端审核/认证 | 共享行为契约 + 真实引擎竞争/故障/恢复证据；公开配置与限制 | 不能仅凭实现 TypeScript 接口、ORM 支持方言或测试替身通过就认证 |

若未来要求“审计成功后才准执行”，审计记录与回答消费必须同事务提交，或有明确可恢复的双记录协议；普通异步日志回调不够。若使用 outbox，它只解决同库状态与待发布记录原子落盘；发布/消费仍需幂等，不能承诺数据库与外部工具一起提交。本轮不默认建设该体系。

## 9. 数据版本、迁移与运维契约

### 9.1 区分版本和权限

- 物理 schema 版本、Core checkpoint 格式、宿主 binding 格式、插件 continuation/extensions 版本、厂商 replay 格式分别拥有和升级。
- migration 按后端维护，记录版本和 checksum；运行时检查支持范围。未知较新 schema/逻辑格式明确拒绝，不回退旧表、不静默重置或降级。
- 老 writer 不会自动理解后来新增的版本标记。升级必须停止并隔离旧入口，必要时使用独立目标库/账号/写权限；不能靠 minWriterVersion 元数据自称已经围住旧代码。
- migration 的 DDL 权限、运行 DML 权限、只读查询权限按部署划分。引入服务端数据库不自动提供用户认证、租户隔离或审批主体真实性。
- migration 版本校验不能证明业务数据正确。MySQL DDL 的隐式提交、PG 不能在事务中执行的 DDL 要单独编排，不能一律承诺整次升级回滚。

### 9.2 新空库与已有数据切换不是同一件事

已有数据切换默认采用**停写、离线迁移、单写入端切换**，不默认双写：

1. 停止受理新请求，排空 Run，停止派发工具；确认旧进程与旧写入方停止。已落盘 waiting 保留；不能以取消或强杀代替等待恢复语义。
2. 使用数据库支持的一致备份/导出，记录来源格式与适配版本；活跃 WAL 数据库不能只复制一个 .db 文件。
3. 导出 history head、全部 batches/receipts、全部 Query checkpoint（含终态/空行）、revision/generation/owner 信息、host binding、pending/已消费回答续传、extensions/replay 等权威内容。目录不是完整导出 API，不能只迁可见消息或最新 unfinished。
4. 目标使用后端专用 schema；迁移工具校验数量、唯一性、内容/批次顺序、身份和修订关系；未知格式拒绝。配置/Key 仍走配置和凭据模块，不混进执行数据包。
5. 已存 owner 不证明进程仍活着。保留代际事实，按确认旧 writer 已停止的显式接管流程处理；禁止迁移工具直接清 owner 或重置 generation 后自称恢复完成。
6. 在目标实际验证相同 Query、新 Run、pending 批准/拒绝/取消、提交未知对账与租约释放；确认原权限环境仍匹配，再把唯一写端切到目标。
7. 新端发生写入后，回滚需要反向数据迁移/恢复方案，不能仅切回旧连接串。旧库保留为受控只读证据，不同时开放两个权威写端。

恢复旧备份可能倒退 generation，因此 fencing 数值不能替代旧 writer 的外部隔离。备份恢复演练必须验证 receipt、pending、修订和代际，而非仅能打开数据库。HA 的 RPO/RTO、同步成员、故障切换和脑裂隔离另外验收；单机事务测试不证明 HA。

## 10. 修复前调查证据：Thread 准入反例

环境：Windows、Node `v24.20.0`、Node SQLite `3.53.4`；两个独立 SQLite store 连接同一自建临时文件，两个公开 `createAgentApplication` 创建相同 agentId 的实例；模型为受控 ModelClient，不访问远程厂商。两个实例都满足各自单实例一次激活约束。

确定性门闩只延迟 A 的 acquire 调用，不伪造 findUnfinished 的返回，不替换 SQLite 读写：

1. A 对相同 agent/thread、新 query-A 的真实 unfinished 读取返回 null；在进入真实 acquire 之前暂停。
2. B 用 query-B 执行到审批，真实持久化并返回 waiting。
3. 放行 A，A 获取不同 Query key 的 lease，追加新输入、进入模型并 completed。
4. 再从数据库读取：B 仍为 waiting，两条 checkpoint 的 owner 均已释放，历史包含 B 输入、A 输入、A 的完成回复。

| 观察项 | 实际值 |
| --- | --- |
| A 准入前读到的 unfinished | null |
| B 的结果 / A 的结果 | waiting / completed |
| A 完成后仍未解决的 Query | query-B / waiting |
| 模型调用 / 工具 execute | 2 / 0 |
| history revision | 3 |
| 规范历史顺序 | user:pending-B → user:new-A → assistant:new-A-completed |
| 最终 writer owner | query-A、query-B 均为 null |

该反例证明**现有 Core 新 Query 检查可被过期读取越过**，并非历史 CAS 已阻止了问题；本场景没有工具外部副作用。它是单进程内两个 Application/真实连接的受控交错，不是两个 OS 进程、不经过完整宿主 binding/终端，也不是远程模型验收。

实际命令为临时脚本的 esbuild 打包和原生 Node 执行：`npm.cmd exec -- esbuild ... --bundle --platform=node --format=esm --packages=external`，随后 `node` 运行。先在调研初始宿主路径观察反例，再在并行迁移后的 `cli/host/sqlite-agent-stores.ts` 运行并观察到同样结果。临时数据库及脚本在调查后清理，不新增永久测试；后续修复应将该交错纳入正式行为回归。

上述限制属于调研阶段：当时未修改运行时、未执行修复后检查。后续 P1/P2 已按第 13 节实施与验证；PG/MySQL、网络 ACK 丢失、断电、数据迁移/备份恢复、审计及 HA 仍未验收。

## 11. 实施顺序与验收

P1/P2 已实施；P3/P4 仍待执行。M2-A/B 不重新打开，CLI 并行实现的成果不计入本切片；实际证据见第 13 节。

| 切片 | 修改范围 | 验收与依赖 |
| --- | --- | --- |
| P1：当前 SQLite 职责收敛（已完成本地验收） | 已拆分写装配、只读查询/DTO、私有连接/DDL/三个 store；调用方迁移且无兼容转发 | 原数据格式不变；receipt/CAS/fencing、binding 不收养和目录私有信息排除回归通过；实际 Node CLI 无插件对话、文件审批、EOF 与跨进程恢复通过 |
| P2：Thread 原子准入（已实施并验证所列窗口） | acquire 原子检查其他 Query 的 owner/非终态，统一 Core 与全部 store/消费者 | 同进程等待/首存/释放窗口回归、三种跨进程窗口及第三进程重开通过；提交未知与更完整故障矩阵仍按 M3-D 独立验收，不承诺 exactly-once |
| P3：第二后端认证 | 先实现真实 PostgreSQL 适配及同一宿主的 binding/查询/资源/配置选择；再按需要实现 MySQL。研究基准为 PG 18、MySQL 8.4，不据此声明其他版本兼容 | 对应真实引擎、锁定驱动/配置运行共享契约及实际宿主烟测；公开支持前必须满足 P2。不得保留 SQLite 文件查询或把不支持操作回退内存。第二后端不以迁移现有用户库作为默认启动动作 |
| P4：已有数据迁移与包边界复核 | 受控导出/导入、版本升级、备份恢复和切换操作；依据真实复用决定是否抽一个多后端持久化包 | 停写一致迁移后保持 batch receipt/顺序/Query/pending/replay/版本，显式接管、拒绝/取消/unknown/applied 与释放正确；实际验证回滚边界。若包化，受控 exports、声明/依赖闭包和仓库外真实消费同时通过，不留下源码直连 |

后续已按 [M3-C 增量安排](m3-c-persistence.md#12-c1c3-增量实施与验收记录)补齐 C1/C3 并完成验收，当前进入 D/E 待执行阶段。P2 与 C2 是同一次交付，不另起持久化准入实现；P3/P4 不作为 M3 的前置或完成门槛。

后续第二后端复用已验证的行为断言，补自身锁/隔离/提交未知和完整宿主消费证据，不复用 SQLite 特有 SQL 或写锁方式。版本化 schema 管理尚未交付，与已经完成的职责拆分分开记录；引入物理版本机制时另定 legacy 识别、升级和较新版本拒绝规则，不把“已拆出 DDL 文件”写成“已完成迁移体系”。

后端共享验收应覆盖以下调用方可见性质，而不是源码/SQL 字符串或类名：

- 相同批次幂等、异内容冲突、不同批次同 expected revision 仅一成功，完整保留规范消息顺序和前缀。
- 一致读取；首次创建竞争；lease 非重入；精确 replace；过期 save/release 不影响新代；stale 优先于 conflict。
- binding 同值重放、异值拒绝；缺 binding 却已有历史/空批次/其他 Agent checkpoint 时不收养；与首次执行状态创建的竞争复用 M3-C1-7，保持跨表原子判定而非仅单表唯一性。
- Thread 初始准入、waiting、回答消费、终态恢复拒绝及累计预算；分清实例活动槽与跨写入方约束，保留 P2 已有三类 PID 窗口，不重复制造同路径用例。
- 提交前失败与**提交后丢确认**分别注入；包括 acquire 已提交但无返回 lease、首次 save 前无 payload 的情形。该项归 M3-D2，与重复 batch 对账、dispatched/已消费回答不重做、applied 不被错误或取消抹去一起验收，不倒推为 P2 已通过。
- MySQL FOUND_ROWS 开/关、RR/RC、真实死锁；PG 隔离/唯一竞争和序列化失败；ID/整数/JSON 边界与 schema 升级/拒绝。
- 每个后端使用真实数据库、独立连接和独立进程，门闩控制交错而非 sleep 猜测。可使用 [Testcontainers for Node.js](https://node.testcontainers.org/) 提供环境，但容器不代替故障模型，也不证明物理断电或多节点 HA。

## 12. 数据库与运维资料

数据库细节以对应版本官方资料为依据；以下用于实施约束，不是已运行结果。

- SQLite：[事务](https://www.sqlite.org/lang_transaction.html)、[WAL 与 durability](https://www.sqlite.org/wal.html)、[busy timeout](https://www.sqlite.org/c3ref/busy_timeout.html)、[Online Backup](https://www.sqlite.org/backup.html)。
- PostgreSQL 18：[事务隔离](https://www.postgresql.org/docs/18/transaction-iso.html)、[唯一性检查](https://www.postgresql.org/docs/18/index-unique-checks.html)、[事务失败处理](https://www.postgresql.org/docs/18/mvcc-serialization-failure-handling.html)、[WAL/fsync/synchronous_commit](https://www.postgresql.org/docs/18/runtime-config-wal.html)、[连接终止与执行结果](https://www.postgresql.org/docs/18/protocol-flow.html#PROTOCOL-FLOW-TERMINATION)、[pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)。
- MySQL 8.4：[InnoDB 隔离](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html)、[affected rows](https://dev.mysql.com/doc/refman/8.4/en/information-functions.html#function_row-count)、[JSON](https://dev.mysql.com/doc/refman/8.4/en/json.html)、[collation](https://dev.mysql.com/doc/refman/8.4/en/case-sensitivity.html)、[flush 参数](https://dev.mysql.com/doc/refman/8.4/en/innodb-parameters.html#sysvar_innodb_flush_log_at_trx_commit)、[半同步复制](https://dev.mysql.com/doc/refman/8.4/en/replication-semisync.html)、[一致导出限制](https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html#option_mysqldump_single-transaction)。
- Flyway：[Validate](https://documentation.red-gate.com/fd/validate-277578898.html)、[Migration transaction handling](https://documentation.red-gate.com/fd/migration-transaction-handling-273973399.html)。借鉴版本、checksum 与按数据库编排迁移，不在本轮引入 JVM/Flyway 运行时，也不将其校验当作执行语义认证。

## 13. P1/P2 实施与验收记录

本轮按用户授权实施当前 SQLite 优化与准入修复，没有创建独立 SQL 包、ORM、第二套 ThreadLease、重试或自动接管。

### 实现与兼容

- `sqlite-agent-stores.ts` 只装配具名端口。私有 `connection/schema/history/checkpoint/binding/revision/history-queries` 内聚连接、事务与 SQL；binding.ensure 仍在同一个写事务检查 history/checkpoint，不降级为分离查询。
- `sqlite-session-queries.ts` 与宿主 DTO 独立；目录仅打开已有文件，不建目录、schema 或租约，保留原有未完成 Query 历史范围算法。history.read 使用一致只读事务，不再为读取取得写锁。
- Core 移除独立 unfinished 前置检查；acquire 按 stale → busy → thread-pending → acquired 裁决。首次 save 前的活动空行、终态 save 后 release 前的行都占用线程；释放非终态仍阻止新 Query，释放空行保留代际但不阻塞。
- lifecycle 与两份真实包消费者的完整内存端口同步规则。旧会话列表夹具改为合法的前序终态释放后开启新 Query，不绕过新规则创建多个正常 unfinished。
- MiMo 检查夹具改用当前数据库及实际 handle 身份；CLI 测试修正结果判别联合构造。集成 HTTP 夹具依据明确 `[tool_error]` 标记处理纯文本失败，不再把审批拒绝内容强行当作成功文件 JSON；未改生产工具、模型投影或错误语义。
- JSON/表格式不变不代表旧 writer 可混用。部署须停旧入口后统一升级；未新增 TTL、强制接管、自动修复异常库或副作用重放。

### 真实运行证据

- 定向七文件 90 项通过，覆盖 SQLite、binding、目录、Core runtime/lifecycle/session-host 与跨进程回归。
- 新增 `general-agent-reliability.integration.test.ts` 及原生 Node `.mjs` worker：不同 PID 在模型在途、首次 save 前、终态 release 前分别竞争；失败方 THREAD_PENDING、模型零调用；释放后新 Query 正常完成。A/B 退出后第三 PID 重开，核对完整有序历史、checkpoint 与 inspection 后的 generation=2。
- 夹具先完成空库 WAL/schema 初始化，再打开第二连接竞争执行准入；没有通过增加 SQL 重试隐藏数据库初始化锁竞争。该证据不包含并发建库保证。
- 额外原生 Node 烟测：活动写事务内的未提交 revision=99 不影响另一连接读取已提交 revision=1 与匹配消息；缺失目录查询不创建存储。
- 实际 Node CLI + Windows DPAPI + 本地 SDK HTTP/SSE：无插件对话 completed；随机文件码在批准前不进入模型；EOF 返回 3、checkpoint waiting 且 lease 释放；新进程批准后同 Query/新 Run completed、消费真实随机码、lease 再次释放。该场景共 3 次本地 HTTP 模型请求，不调用远程厂商；受控输入不作为真实 TTY/键盘验收。

### 最终检查

| 命令 | 实际结果 |
| --- | --- |
| `npm.cmd run build:cli` | 五个 workspace 与实际 Node CLI 构建通过 |
| `npm.cmd run typecheck` | 最终完整命令通过；包括五包构建、全部依赖边界及 node/web/CLI 类型检查 |
| `npm.cmd test` | 197 个文件通过，1710 项通过、3 项条件跳过 |
| `npm.cmd run test:integration:harness` | 三文件十项通过；包含实际 CLI 恢复与新增原生进程准入，已进入常规集成命令 |
| `node scripts/verify-harness-package.mjs`、`node scripts/verify-tools-package.mjs` | 真实 tarball 隔离安装、声明/原生消费通过；内存端口含新 Thread 准入规则，不把该消费当跨进程持久性证明 |
| Biome | 24 个变更文件完整检查通过；另 3 份正在迁移的 CLI 测试/夹具只检查 lint、不批量重排既有格式 |
| `npm.cmd run agent -- --help` | 真实生产 Node 命令正常退出并显示帮助 |

Windows 下三项跳过分别为基础文件工具的 final-file symlink、项目编辑器的 symlink 场景，以及 Node 凭据的非 Windows 安全失败场景；跳过不计作验收。

校验中修复了旧数据路径/Agent 身份和错误传输测试夹具。曾观察到构建产物缺失及模型门禁内部 TypeScript 异常；诊断副本未复现该编译器异常，最终完整 typecheck 通过，没有修改或降级边界门禁，也不声称已经修复编译器内部问题。

### 限制

P1/P2 交付时，完整 M3-C1/C3 与 D/E 尚未完成；后续 C1/C3 的新增验收见第 14 节，D/E 与 P3/P4 仍待执行。该轮没有认证 PostgreSQL/MySQL、迁移生产库、进行断电/ACK 丢失/HA 演练、增加永久审计或重跑 ASAR/安装器；未改变包 exports/打包解析，公开联合分支通过既有真实 tarball 消费验证。

## 14. 后续 M3-C 增量验收

[M3-C 第 12 节](m3-c-persistence.md#12-c1c3-增量实施与验收记录)记录本轮新增 C1/C3：复用 P1 的分层与 P2 的原子 acquire，扩展现有真实 PID 夹具验证直接存储竞争、第三进程重开及 binding 跨表不收养；真实 waiting 的定义/插件/模型/工具/宿主兼容拒绝均有原配置恢复对照，并固化只读 history/无创建边界。没有修改存储协议或表格式。

本轮类型/边界、全量回归、注册集成文件、Core/tools tarball 及原生 CLI 烟测通过；精确数字、初轮失败与最终命令结果以 C 的记录为准，不重复计入 P1/P2。下一步 D 包含 acquire 提交确认未知、dispatched/回答消费结果丢失及 unknown/applied；这些仍未验收，P3/P4 不因 C 完成而启动或通过。
