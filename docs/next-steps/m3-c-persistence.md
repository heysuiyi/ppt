# M3-C：持久并发准入与恢复兼容

[返回计划目录](README.md) · [M3 总计划](m3-reliability.md) · [前一步 M3-B](m3-b-lifecycle.md#10-后续独立审核与完成结论)

状态：**M3-C 已完成本轮验收。** C2 原子准入由持久化 P1/P2 交付，本轮补齐 C1 真实进程竞争、C3 分层恢复兼容与只读行为回归，集中类型/边界、全量回归、真实 CLI 集成和包消费通过。新增实现、失败定位、命令结果及限制见第 12 节；P1/P2 历史记录见[持久化实施记录](persistence-backends.md#13-p1p2-实施与验收记录)。D/E 与第二后端仍未完成，不增加并发调度能力。

## 1. 目标、顺序与边界

本轮已按 **复用 P1/P2 基线 → 补齐 C1 剩余真实进程竞争 → 补齐 C3 分层恢复兼容 → 集中验收** 执行。没有重新实施 C2 或再次拆分 SQLite；第 11 节保留当时的增量方案，第 12 节记录实际交付。后续进入 D/E，不能将 C 的正常竞争与兼容证据当作故障恢复或容量证明。

- Agent 实例活动槽、Thread 准入、Query 写租约、checkpoint CAS、history batch receipt 是不同层次，不互相代替。
- Thread 准入在当前 checkpoint 协议的 `(agentId, threadId)` 范围内强制；同一 Query 仍使用独立 Run 与单调 generation。具体 Host 的 binding 按 threadId 固定 Agent，history 也按 threadId 保存；不宣称不同 Agent 可安全复用同一个历史 threadId。
- waiting/interrupted/running 的 Query 未结束，即使没有活动租约也阻止另起 Query；已保存终态但租约尚未释放，也不能提前让新 Query 进入。
- 无 TTL、无自动接管、无排队、无隐式重试；显式接管仍须宿主确认旧 writer 停止，并比较完整旧租约。
- 不切生产 UI/PPT/旧 Agent，不新增线程池、Worker、工具并行、全局容量治理、第三方沙箱或新容器。D 的崩溃/副作用窗口与 E 的观察语义仍独立待执行。

## 2. 当前代码与证据边界

| 落点 | 现状 | C 的动作 |
| --- | --- | --- |
| `packages/harness/src/agent/runtime/run-controller.ts` | 已删除 unfinished 前置准入检查，统一按 acquire 裁决；恢复校验保留 | C2 已落实；C3 兼容矩阵仍待集中验收 |
| `packages/harness/src/agent/session/checkpoint-contract.ts` | acquire 已增加 thread-pending，明确 stale/busy/其他 Query 判定顺序 | SQLite、完整内存端口、结果消费者及包声明已同步 |
| `cli/host/sqlite-agent-stores.ts`、`internal/sqlite/checkpoint.ts` | 写装配与私有 SQL 已分离；同写事务检查其他 Query 的 owner/非终态，再取得租约 | 首存前/终态释放前与真实进程回归已通过；schema/围栏/CAS/receipt 保持 |
| `cli/host/host-session-binding.ts`、`packages/harness/src/agent-host/session-host.ts` | HostSessionBinding v2 精确比较；ensure 通过后才安装 Agent 与创建模型 binding | 区分宿主绑定拒绝与 Core 的恢复校验，不让前者掩盖后者 |
| `tests/general-agent-host.test.ts`、`general-agent-host-binding.test.ts` | 同进程多连接、顺序重开、旧租约及幂等已覆盖 | 保留快速回归，新增真正独立进程竞争，不把 Promise.all 当跨进程 |
| `tests/general-agent-runtime.test.ts`、`general-agent-session-host.test.ts` | 已有真实 waiting、跨实例恢复和持久状态断言 | 补 definition/plugins/model/tool version 的公开行为矩阵 |
| 现有 CLI integration、`scripts/verify-harness-package.mjs` | 真实 Node CLI、本地 HTTP、包消费及新 Thread 规则已验证；包脚本的 store 是内存实现 | 保留既有证据，扩展现有原生 PID 夹具，不重复新增执行入口或宣称包脚本证明持久竞争 |

### 2.1 P1/P2 基线与入口约束

初始方案中的旧测试路径、库名和 Agent 身份漂移属于 CLI 迁移期间的历史问题；P1/P2 已迁移实际调用方、修正 MiMo inspector，并记录 build:cli、完整 typecheck、全量回归及真实 Node CLI 恢复通过，详见持久化第 13 节。不再将当时的路径漂移列为当前实施前置或重做 CLI 切片。

下一轮使用 `cli/host/` 实现、`cli/dist/host/sqlite-agent-stores.js` 进程消费产物和实际会话身份。开工运行相关基线以发现新的工作区变更，不恢复旧源码别名或另建 SQLite 实现；新增进程命令前先构建 CLI，而非仅构建 workspace 包。

## 3. C2 已复现：陈旧空读取越过 Thread 待决检查

以下保留修复前的一次性调查：使用当时 Core 公开构建产物与 SQLite 宿主适配，两个 Application、两个连接打开同一隔离磁盘库，不安装业务插件、不访问远程模型。该旧行为已由 P2 修复，不是当前缺陷状态。

1. B 的 `findUnfinished` 委托真实存储取得 null，以端口包装器暂停返回。
2. A 使用相同 agentId/threadId、不同 queryId，取得租约并将 running/checkpoint 和用户输入真实提交，进入受控模型门闩。
3. 放行 B 返回旧 null；B 的 acquire 只检查自己的 Query 键，仍成功，随后也进入模型门闩。
4. 两 Query 均有已保存 running，两个键再次 acquire 均返回 busy；两侧均持有各自租约，而非只有句柄创建成功。
5. 两 Application 关闭、放行模型后均得到 interrupted，存储与临时资源正常清理。

**修复前结论：Thread 准入存在可复现的 TOCTOU 缺陷。** Query 租约与 history CAS 未阻止两 Query 同时进入模型；不能把后续历史冲突当作准入保护。这份调查本身是同进程证据；随后 P1/P2 已补原子修复、永久回归及三类独立进程窗口，见第 10 节，不再安排重复复现或重复实现。

### 3.1 最小修复决策：加强现有 acquire，不增加第二把 Thread 锁

现有 `CheckpointStore.acquire` 已承担原子 Thread 准入，不暴露额外 ThreadLease/Registry/释放协议。SQLite 复用现有事务与 checkpoint 行，不新增锁表；这是当前后端的实现选择，不限制未来 PG/MySQL 在适配器内部使用稳定同步行或约束实现同一公开保证。

`CheckpointAcquireResult` 已增加具名分支 `{ status: "thread-pending"; queryId: string }`，运行时映射为既有 `THREAD_PENDING`；不是可选能力或旧语义兼容分支。原 busy/stale 和 I/O 拒绝语义保留，本轮真实包消费已验证新契约。

一次 acquire 的事务要求：

1. 读取目标键，按完整 key/ownerId/generation 验证 replace；过期 replace 不写入、不取得任何所有权。
2. 保留同键活动 owner 的 busy 规则，ownerId 相同也不能绕过。
3. 查同 `(agentId, threadId)` 下其它 queryId：只要其 `owner_id IS NOT NULL`，或持久 status 为 running/waiting/interrupted，就返回 thread-pending，不改变目标行、generation 或 revision。
4. 没有阻塞者才插入/更新目标行、推进 generation 并返回权威 checkpoint。**冲突检查与取得租约在同一事务提交**，中间没有 await 或向模型/工具派发。

由此覆盖两个易漏窗口：首次 acquire 后、首次 checkpoint save 前的无 payload 活动行；终态 save 后、release 前的仍持租约行。仅查询未完成 status 或给 findUnfinished 加索引都不足以修复。

运行时不再以独立 `findUnfinished` 作为最终准入依据；删除该前置检查，统一按 acquire 结果拒绝。`findUnfinished` 仍供宿主观察与待决发现使用，不删除端口，也不把查询结果当授权凭据。对应竞争夹具在公开 acquire 调用前固定旧观察窗口，不依赖被删除的实现调用顺序。

### 3.2 兼容与迁移

- SQLite、lifecycle 完整内存 fixture、`verify-harness-package.mjs`、`verify-tools-package.mjs` 及结果消费者已同步；后续变更仍须检查引用、迁移全部实现，不重新引入可选规则或兼容旧语义的 store。
- checkpoint v1、HostSessionBinding v2、插件/续传载荷及 SQLite 表格式已保持不变；物理 schema 版本管理与数据迁移不是本步准入修复的隐藏前置。
- 新 union 分支、构建声明、错误映射与真实包消费已同步；未新增 exports 或升级业务定义/插件版本。
- 原先通过合法 acquire 累积多个 unfinished Query 的夹具已替换为合法状态转换；后续测试不得绕过准入重新钉住旧行为。
- 已有异常库若含多个未完成 Query，不能自动挑一个赢家、删除历史或终结其它 Query；拒绝冲突准入并保留权威数据，明确报告，不新增自动修复或前端强制接管入口。已释放且无 payload 的空行不阻塞新 Query，但仍保留 generation，不能删行后重用围栏。

## 4. C2 永久回归与完成条件

| 编号 | 固定窗口 | 必须观察的结果 |
| --- | --- | --- |
| C2-1 | 两独立 Application 相同 agent/thread、不同 query；B 先到 acquire 前门闩，A 进入模型后放行 B | 修复前两模型均进入；修复后 B 的 completed 拒绝 THREAD_PENDING，B 无历史追加、无模型/工具派发、无新租约；A 不受影响 |
| C2-2 | A 已 acquire，但端口门闩阻止首次 save；再激活 B | A 的无 payload 活动行已占 Thread；B 被拒绝，无需等首个 checkpoint |
| C2-3 | A 保存 waiting/running/interrupted 后 release；分别另起 Query | 新 Query 均拒绝；原 waiting 仍能以相同 Query、新 Run 恢复，未消费旧回答 |
| C2-4 | A 已保存 completed/cancelled/failed，但 release 尚未完成 | 其它 Application 的新 Query 仍被拒；release 后才可正常启动新 Query |
| C2-5 | 同 Query 的两 writer、错误/过期 replace、旧 save/release | 既有 busy/stale/CAS 优先级不退化，旧 writer 不破坏新 writer |
| C2-6 | 不同 Thread 的两 Application 同时在途 | 无进程级大锁或隐式队列，允许独立推进；一侧关闭/冲突不影响另一侧 |

永久测试覆盖消费者可见的状态、拒绝及持久副作用；不用源码字符串、调用次数转发或错误措辞锁实现。保存前/释放前门闩包装公开端口，不给 Core 加测试钩子。

## 5. C1：真实进程 SQLite 竞争

已新增 `tests/fixtures/general-agent-reliability-entry.mjs` 与 `tests/general-agent-reliability.integration.test.ts`，通过原生 Node 24/IPC 消费已构建 Core 与真实 CLI SQLite 产物；三类 C2 进程窗口及第三进程重开已经通过。后续完整 C1 扩展现有 worker 的具体存储操作命令与阶段门闩，不另造 Vite/第二套执行入口，不建设通用数据库测试框架。fixture 不进入生产 out/**，无 Electron 或远程凭据依赖。

当前夹具先初始化空库 WAL/schema，再启动第二个独立 PID；两侧均 ready 后才竞争执行准入，避免把数据库配置 DDL 竞争误当准入失败。后续 C1 按 requestId/phase 固定交错；时间限制只负责失败回收，不用 sleep 或耗时阈值证明正确性。同步 SQLite 持锁方须是另一个独立进程。

| 编号 | 竞争场景 | 持久断言 |
| --- | --- | --- |
| C1-1 | 同 Query、不同 owner 同时 acquire；另测 ownerId 相同 | 恰好一 acquired、一 busy，busy 带赢家完整 lease；不预定哪个 PID 获胜 |
| C1-2 | 两进程持同一个合法 lease、相同 expectedRevision 保存不同 checkpoint | 一 saved、一 conflict，revision 只增加一次、payload 为真实赢家；共享 lease 仅是适配器 CAS 夹具，不表示生产允许双 writer |
| C1-3 | 新 Thread 两个不同合法 binding 同时 ensure，再各 ensure 赢家同值 | 首次一成功、一 HOST_BINDING_CHANGED；同值均成功，原绑定不替换 |
| C1-4 | 不同 batchId/消息争同 history revision；同 batchId/同消息并发重放；同 batchId/不同消息 | 分别是一 appended 一 conflict、同一原始 receipt 且只追加一次、内容冲突拒绝且原历史不变；收据先于过期 revision 判定 |
| C1-5 | 旧 writer 提交后退出并确认 exit；新进程精确 replace；独立连接再用旧 lease save/release/replace | generation 增长；旧 save/replace stale，旧 release 不清除新 owner，payload/revision 不被破坏；不在旧 writer 存活时声称安全接管 |
| C1-6（已有证据） | 两进程通过公开 Application 核验模型在途、首次 save 前与终态 release 前；第三进程重开 | P1/P2 已通过，保留现有三组回归，不重复实现；它不替代 C1-1～C1-5 的直接存储竞争 |
| C1-7 | binding.ensure 与首次 history head/无 payload checkpoint 创建交错；同值/异值绑定为对照 | 执行状态先提交时不得收养；binding 先提交则保持原绑定，后续按既有 Core 端口语义执行。不擅自新增“所有 Core 写入必须先绑定”的限制 |

### 5.1 第三进程重开不是可选项

A/B dispose 并确认退出后，新 C PID 打开同一库，核对完整 binding、history 消息顺序/revision、checkpoint payload/revision/generation，而非只检查行数或非空。

分别覆盖：未 release 的 writer 退出后普通 acquire 仍 busy；正常 release 后 acquire 成功并推进 generation；相同 batch receipt 重放不增加历史、不同内容仍拒绝。inspect 的 acquire 自身推进 generation，必须计入断言并在 finally release。正常退出重开只证明该窗口持久性，不冒充断电、强杀或 D 阶段丢确认验收。

## 6. C3：真实 waiting 的恢复兼容矩阵

先经公开入口产生并保存真实 waiting，再关闭实例/连接、重开库；每个参数组使用独立隔离状态，改变单个维度。不得手工伪造恢复快照。对所有未消费回答的拒绝路径，以原配置和 fresh runId 恢复同一 Query/interaction 成功作对照。

| 层次 | 变化 | 验收边界 |
| --- | --- | --- |
| Core definition | id、version 分别改变 | DEFINITION_CHANGED；不创建执行 session、不写失败快照、不消费回答、不派发工具或模型 |
| Core plugins | 两插件换序、新增、删除、id/version 改变 | ordered `{id,version}[]` 精确比较，不改成集合或 semver；原 waiting/pending 与 history 保留 |
| Core model | providerId/modelId/reasoningEffort 改变，含可选 effort 增删 | 对实际绑定 client.selection 校验，不让 Host 提前拒绝掩盖此路径；无 generate/stream |
| 待决 tool | 工具删除、version 改变；匹配 answer 与 cancel 分开观察 | TOOL_VERSION_CHANGED 发生在回答 CAS 消费前；pending/continuation/effects 与历史不丢，原配置仍能使用原回答 |
| Host binding | workspace、toolMode、connection fingerprint、definition/读取审批版本、插件有序列表、maxSteps 增减 | createSessionHost 的 ensure 先拒绝，原 binding 不覆盖，Agent 插件 setup/模型 binding 不进入；复用真实配置适配，不把密钥写进夹具 |
| 成功对照 | 原 definition/plugins/model/tool/宿主绑定；同连接身份下密钥轮换 | 原 Query、新 Run 正常恢复；真实随机文件结果/副作用账本匹配，最终 checkpoint 与 lease 同时核验 |

精确状态要求：

- Core definition/plugins/model 不兼容在租约取得后、session 创建前拒绝，仍须 finally 释放租约；“无 checkpoint save”不表示 acquire/release 或 generation 没有发生。
- 待决 tool version 当前在恢复激活 save 之后校验，因此 revision/lastRunId 可能已更新；验收要求 waiting、pending、continuation、effects、规范历史与**未消费回答**保留，不错误钉死整份 checkpoint 字节完全不变。
- 模型 binding 创建与 generate/stream 是两件事；Core 层拒绝时 binding 可以已经存在，不能断言 models.create 为零。具体宿主在 binding.ensure 前也可能准备日志、工作区和 provider，不能把宿主拒绝写成“零资源、零外部操作”。
- 无 response 的 waiting 恢复当前不会进入待决 tool version 校验；记录实际语义，不把它当成已验证新工具可以消费旧回答。
- instructions 或插件实现语义变化需升级对应版本；当前没有实现内容哈希。相同 tool version 下 owner/schema/continuation 的深层检查发生在回答消费后，不能借 C3 宣称全部异常都保留原回答；这类结果与当前权限重新授权按 D 的副作用/交互语义验收，不提前改消费顺序。
- Host 要求 maxSteps 精确相同；Core 预算仍使用已存与当前预算的较小值，不因恢复增加步数。此处复用既有预算不变量，不放宽 Host 绑定。

## 7. 实施落点与依赖

| 顺序 | 落点 | 交付 |
| --- | --- | --- |
| 基线复用 | 持久化第 13 节、现有 CLI 构建/集成入口 | P1/P2 已完成；核对本轮工作区与现有证据差异，只运行受影响基线，不重做拆分和准入 |
| C1 补齐 | 现有 reliability worker/integration 与 host 快速回归 | 补 C1-1～C1-5、C1-7；C1-6 保留已有证据；新命令继续由现有 test:integration:harness 执行 |
| C3 补齐 | runtime、host-binding、development-host 现有行为测试，必要时复用重开 worker | Core 与 Host 分层矩阵、原配置成功对照；只对实际复现缺陷修运行时，不扩公开面 |
| 集中验收 | 本文、M3 总计划、目录和整体路线 | 对照新增缺口记录实际结果；C1/C3 均完成才标记 M3-C 完成，不重复计数 P1/P2 |

生产实现职责已由 P1 固定；C1/C3 原则上只补行为验收，不再次调整持久化分层。只有新增场景复现契约缺陷时，才做最小生产修复。所有在途承诺在故障触发前登记成功/拒绝观察；失败 finally 先放行门闩、等待进程退出，再关闭存储和移除本次目录，不碰共享库或其它切片进程。

## 8. 实施后的检查与完成门槛

以下用于下一轮 C1/C3 集中验收，不是本次文档优化新增的通过证据。worker 导入 CLI 构建产物，先执行 build:cli；已有 test:integration:harness 已包含构建和 reliability 文件，不再重复注册或新建集成命令。

```text
npm.cmd run build:cli
npx.cmd vitest run tests/general-agent-lifecycle.test.ts tests/general-agent-session-host.test.ts tests/general-agent-runtime.test.ts tests/general-agent-host.test.ts tests/general-agent-host-binding.test.ts tests/general-agent-development-host.test.ts
npx.cmd vitest run tests/general-agent-reliability.integration.test.ts
npm.cmd run test:integration:harness
npm.cmd run verify:harness-package
npm.cmd run verify:tools-package
npm.cmd run typecheck
npx.cmd biome check <本次修改的受支持代码与配置文件>
npm.cmd test
```

完成必须同时满足：

1. C2 不再允许过期观察、首存前占位或终态释放前窗口产生第二个准入；失败侧不派发，原 Query 可正常恢复，跨 Thread 仍可推进。
2. C1 的独立进程、不预定赢家、CAS/fencing/binding/receipt、第三进程重开均有结构化证据；I/O 错误与领域冲突分开报告。
3. C3 兼容矩阵逐项有拒绝和原配置成功对照；不丢 waiting、未消费回答或已确定 effects，不把失败内存快照覆盖持久状态。
4. 所有端口实现、结果消费者与声明同步；包原生消费者、真实进程路径、既有 CLI 入口、全仓边界/类型/静态和全量回归通过，跳过项明确列出。
5. 无临时程序、SQLite/WAL/SHM、nonce 文件或子进程遗留；无远程厂商用量。公开存储类型变化需要重跑真实包声明/消费，不把是否需要额外 ASAR 产物检查留成未决：若改变打包解析或产物边界，再执行对应既有 ASAR 验收；仅类型/行为加强不重复安装器验收。
6. C 的证据不作为 D/E、吞吐、内存有界、恶意插件隔离、自动故障接管或外部影响恰好一次的完成声明。

## 9. 初始方案制定证据（历史）

- 已阅读当前公开准入/恢复协议、SQLite 事务、Host binding 与已有行为回归，确认 C1 现有测试是同进程多连接，不能作为进程竞争证明。
- 一次性原生 Node C2 探针已实际运行通过其缺陷复现断言：两个 Application、两个真实 SQLite 连接、一个 OS 进程，相同 Agent/Thread 不同 Query 均进入模型并持有租约；关闭后两侧 interrupted。它证明缺陷存在，不是修复通过。
- 探针委托真实存储，只在公开端口暂停旧读取；没有新增 Core 测试钩子、永久测试或修改运行时。隔离 SQLite 已由程序 finally 清理，临时程序及编译目录 `.vite/m3-c-admission-design/` 已删除并确认不存在。
- 方案制定阶段同步 M3-B 独立审核结果，当时未执行 C1/C2/C3、CLI 或全仓门禁；后续 C2 实施与新增证据见第 10 节，完整 C1/C3 仍未验收。
- 本次修改的 5 份文档共 67 个本地链接及 Markdown 标题锚点校验通过；新增 C 文件、B 审核记录、目录与整体路线相互可达。

## 10. C2 随持久化 P1/P2 实施

- acquire 与 Thread 阻塞检查已在同一事务内完成，run/resume 不再依赖独立 unfinished 观察。首存前、终态 release 前、释放非终态、释放空行保留代际均有行为回归，未加第二把锁、TTL、自动接管或重试。
- 同进程反例转为拒绝行为：延迟新请求不能越过持久 waiting，不追加输入、不调用模型，原 Query 仍能批准后执行真实文件操作。
- 真实 Node PID 在模型在途、首次 save 前、终态 release 前分别竞争，失败方 THREAD_PENDING/模型零调用；释放后正常执行，第三 PID 重开核验完整历史、checkpoint、修订与代际。集成文件已接入 test:integration:harness。
- 当前七文件九十项、全量 197 文件/1710 项、三文件十项集成、完整 typecheck 与 Core/tools tarball 消费通过；具体检查及三项 Windows 条件跳过见持久化第 13 节。
- C1 的完整 CAS/binding/batch/接管竞争、C3 的分层版本矩阵及 D/E 不据此完成；SQLite 并发初始化、崩溃/提交 ACK 丢失和外部效果 exactly-once 也不在本轮证据内。

## 11. P1/P2 完成后的下一轮执行安排

以下保留 P1/P2 完成后的执行安排；其中 C1/C3 已按第 12 节实施验收，11.3 的 D 与后端专项仍独立待执行。

### 11.1 只补尚缺的竞争证明

1. **存储独占与提交竞争**：C1-1/C1-2/C1-4。两 PID ready 后同一 go 阶段争租约、checkpoint CAS、history CAS/receipt；不预定赢家。CAS 夹具使用同一合法 lease，不将 fencing 失败冒充 revision conflict。
2. **绑定与围栏竞争**：C1-3/C1-5/C1-7。保持 binding“不收养”跨表事务；接管前确认旧 writer 已退出，第三进程再核对完整赢家 payload、history/binding、revision 和 generation。
3. **只读语义不退化**：P1 已有“未提交写入不污染另一连接读取”与“缺库目录不创建”的烟测证据；在本轮相关持久行为组中固定必要的快照一致/无创建回归，不用 SQL 字符串或事务方法转发断言代替。history.read 的 head 与 batches 必须来自同一读视图，不将它改回写事务。

三类 Thread 准入进程窗口已有实现，不重复写一组仅换名称的用例。每个新增竞争组第三 PID 重开核对本组真实赢家，而不是沿用 C1-6 的固定历史作为全部持久性证明。

### 11.2 恢复兼容单独成组

先补 Core definition/有序 plugins/model 的拒绝矩阵，再补 pending tool version 与 Host binding 矩阵。Core 组不让宿主 ensure 提前拦截；Host 组验证其早期拒绝。每个未消费回答的拒绝组均以原配置、新 runId、同一 interaction 的成功恢复收尾，比较持久 pending/effects、历史和租约，而非只断言错误码。

复用第 6 节边界：tool version 拒绝允许已有激活元数据变化；模型 binding 创建不等于 generate；同版本 owner/schema/continuation 深层失败与当前授权重新校验不改消费顺序，归 D 的交互/副作用语义。C1/C3 可以并行补测试，但不各自改存储协议。

### 11.3 留给 D 与持久化专项的明确工作

- **D2 增补 acquire 已提交但确认丢失**：通过公开端口包装真实 acquire，提交后拒绝返回；核验本次不进入模型/工具、不生成新 Query 绕开，权威 owner/generation 保留。确认旧激活停止后，按原 Query、精确旧租约和权威 checkpoint 处理接管；首次 save 前无 payload 与已有 payload 分开验收，不盲目重试 acquire，不把空行当普通 waiting。
- D1/D2/D3 仍覆盖 dispatched、回答消费、history receipt/终态丢确认、unknown/applied 和权限/预算；C2 已修复不代表这些故障窗口已通过。
- P3 真实第二后端不作为 M3-C 的前置；先沉淀 SQLite 的行为验收，再由真实 PG 复用这些断言、补自身锁/隔离/部署证据。允许后端私有同步机制不同，不提前抽通用 SQL 层。
- 版本化 schema、已有数据迁移/备份恢复、包化与 HA 归持久化后续阶段。所有 writer 统一升级仍是部署要求；仅保留旧表格式不能证明新旧二进制混跑安全。

### 11.4 本次方案优化的证据范围

本次依据用户报告及持久化第 13 节的实施记录，核对了当前装配、私有事务/准入实现、只读 history、原生 worker、三类进程用例和根集成命令，调整剩余任务。没有修改运行时、永久测试或重新执行 P1/P2 验收；该阶段历史数字不计作本次独立审核。完整 C1/C3、D/E 与第二后端仍未完成。

本次已校验所修改 5 份文档的 82 个本地链接与标题锚点，全部通过；未重跑 build/typecheck/回归或真实模型调用。文档检查只证明导航有效，不代替下一轮 C1/C3 的行为验收。

## 12. C1/C3 增量实施与验收记录

本轮按第 11 节实施剩余 C1/C3，复用 P1/P2 的持久结构与准入协议；没有重新拆 SQLite、修改 Core 执行协议、接入第二后端或实施 D/E。以下是本轮新增证据，不与第 10 节历史数字混算。

### 12.1 永久行为覆盖

| 范围 | 文件与实际断言 |
| --- | --- |
| C1-1/C1-2 | 现有 reliability worker 增加具体存储命令与 prepare/go；两个 PID 争同 Query（不同/相同 owner），只一方 acquired；共享合法 lease/revision 保存不同 payload，只一 saved、一 conflict |
| C1-3/C1-4 | 异值 binding 首写只有一赢家，赢家同值并发重放不替换；history 不同 batch 的 CAS、同 receipt 同内容/异内容竞争，推进 head 后旧 receipt 仍返回原 revision |
| C1-5 | 旧 writer 已关闭后才精确接管；另一 PID 使用旧 lease 的 save/replace 均 stale，旧 release 不影响新 owner；重开核对新 payload、revision、generation |
| C1-7 | binding 与空 history head/无 payload checkpoint 两种提交顺序；执行状态先提交不得收养，binding 先提交保持绑定且不新增 Core 必须预先绑定的限制 |
| C1 持久性 | 每个新增组在 A/B 关闭后打开新 PID，核对本组完整 history/binding/checkpoint 及 revision/generation；保留原 C1-6 三窗口，不重复复制 |
| Core C3 | definition id/version、双插件有序列表的顺序/增删/id/version、实际 client.selection 的 provider/model/effort 增删改；不兼容拒绝不保存失败快照、不消费回答，waiting/pending/applied 与历史保留，租约释放且代际增长 |
| Pending tool C3 | 删除/version 改变分别 answer/cancel，另有无 response 与同版本成功对照；允许激活元数据更新，不丢待决续传；原配置、新 Run、原 interaction 仍能批准完成 |
| Host C3 | 真实 SessionHost binding 逐项变化及 configured-host 的工作区、工具模式、读取审批版本、连接指纹、预算增减；拒绝不覆盖权威状态，原配置仍可恢复；保留同连接密钥轮换成功证据 |
| 真实副作用 | C3 在等待前以 wx 创建随机 nonce 账本；恢复后模型实际收到有序工具结果中的同一 nonce，既有 applied 不被重做；核对实际文件内容与最终 checkpoint/租约 |
| 只读回归 | 另一连接持有未提交写事务时 history.read 仍读到已提交 revision 与匹配消息；提交后读取新匹配视图，读取不存在 Thread 不创建 head；复用已有目录缺库不创建行为 |

C1 新增 12 项、保留原 3 项，整文件 15 项通过；C3 相关 runtime/development-host/host-binding 三文件 83 项通过。主线程另跑 host/目录/终端三文件 18 项通过。上述有重叠文件，不能相加作为不重复总数。

### 12.2 失败定位与实际入口

- 开工 build:cli 先遇到 `terminal-controller.ts` 两处 TS2367：refresh 入口已经排除 closing，后面的 closing 分支不可达。本轮最小删除重复判断，保持现有控制流；终端回归及实际 CLI 路径通过，不重设计终端状态机。
- 随后一次构建在日志导出并行变动期间失败，读取后相应源码已具备导出；未修改日志/模型实现或放宽门禁，后续 build:cli 通过。旧产物缺失曾导致原 3 个进程基线失败，不能计为存储准入失败。
- C3 初跑新增 30 组成功对照 failed，原因是验收插件把 toModelContent 的 ToolResult 当作 output，投影出 undefined；修正夹具读取成功结果的 output，并把模型实际输入断言移到执行完成后，避免断言异常被运行时投影成 failed。未为通过测试修改生产错误处理。
- 两项既有 configured-host 断言在模型源码/构建产物不一致时失败；保留新源码对应的契约预期，产物收敛后相关三文件 83 项通过，不增加不支持适配器的静默回退。
- C1 首轮整组超时；有界 IPC 诊断确认 CAS 已完成且子进程 exit(0)，但父端与 worker 同时 disconnect 导致 Windows close 事件未收齐。正常断开改由 worker 唯一拥有，父端等待 close，失败路径仍终止并排空。没有延长 deadline、减少矩阵或改生产 SQLite；修正后 15 项通过。
- 一次性原生 Node 程序使用真实 CLI 构建产物、Windows DPAPI 与本地 SDK HTTP：无插件对话 completed；批准前文件不存在；EOF 退出码 3、checkpoint waiting、lease 释放；同连接密钥轮换后，新进程批准同 Query/新 Run，写入真实随机码，最终 completed 且 lease 再次释放。共 3 次本地模型请求，零远程厂商调用；受控输入不作为真实 PTY/键盘验收。
- 临时烟测脚本 `.vite/m3-c-execution-4d21/` 已移除，隔离数据库与工作区由 finally 清理。C1/C3 两路只读代码复核未发现阻塞性缺陷；静态复核与实际运行证据分别记录，不互相替代。
- 一次集中 typecheck 在全部边界检查通过后报告 Core 子路径声明缺失；随后核对相应产物存在，单独 Node/Web/CLI 三项目类型编译通过。未改 exports、模块解析规则或跳过失败文件，最终完整门禁另行记录。
- C1 首轮超时的 6 份遗留隔离目录，经创建窗口和新夹具 Agent/Thread/批次身份核对后逐路径清理；清理前查询未发现存活 reliability worker。诊断线程另外清理其本次产生的 6 份目录，未按共享前缀批量删除。

### 12.3 集中门禁与完成结论

| 命令/场景 | 本轮实际结果 |
| --- | --- |
| `npm.cmd run build:cli` | 五包及实际 Node CLI 构建通过 |
| `npm.cmd run typecheck` | 最终完整命令通过，包含五类边界及 Node/Web/CLI 类型编译 |
| `npm.cmd test` | 202 文件通过，1827 项通过、3 项条件跳过；包含同期工作区其它切片，不把总数差额全部归于 M3-C |
| C1 定向进程矩阵 | 现有 reliability 文件 15 项通过；12 项新增，3 项原场景保留 |
| C3 定向矩阵 | runtime/development-host/host-binding 三文件 83 项通过，无跳过 |
| `test:integration:harness` 注册的三个文件直接 Vitest 运行 | 最终 3 文件、23 项通过，无跳过；实际 Node CLI、本地 HTTP/DPAPI 与独立 PID SQLite |
| `node scripts/verify-harness-package.mjs` | Core 真实 tarball 隔离安装、NodeNext/Bundler 声明及原生公开消费通过 |
| `node scripts/verify-tools-package.mjs` | Core/logs/tools 离线 tarball 闭包、声明与工具实际消费通过 |
| 六个本轮修改代码文件 Biome | 通过，无待应用修正 |
| 一次性实际 CLI 烟测 | 无插件对话、EOF waiting、同连接密钥轮换、原 Query/新 Run 批准真实写入、终态与租约释放通过 |

一次 `npm.cmd run test:integration:harness` 完成构建后，CLI 的 seed/inspect 出现 6 项失败，C1 同批通过；其后观察到包与 CLI 产物被再次生成，独立 seed 成功，再直接执行注册的同一组三文件得到 23 项通过。没有缩小集成范围、修改成功预期或把失败命令写成通过；该轮产物变化与失败的因果未由故障注入证明。

全量 3 项条件跳过仍是 Windows 环境下两类 symlink 场景和非 Windows 凭据失败场景，不计验收。包脚本的内存端口不是跨进程持久证据；C1 的原生 PID/SQLite 与实际 CLI 路径分别提供相应证据。没有远程厂商、断电、提交确认丢失、HA、生产 UI/PPT、ASAR 或安装器新增验收，不承诺外部副作用恰好一次。

**完成结论：C1/C2/C3 满足本步门槛，M3-C 可以标记完成。** 下一步按总计划 D1/D2/D3 推进，其中 acquire 已提交但丢确认及首存前空行的恢复必须明确验证；E 与 P3/P4 不随 C 完成而自动通过。

交付前已验证本轮 5 份文档的 82 个本地链接及标题锚点，全部有效；本轮临时烟测与超时隔离库已清理，未删除共享数据库或其它切片目录。
