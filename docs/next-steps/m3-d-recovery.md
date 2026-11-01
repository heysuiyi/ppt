# M3-D：持久故障、副作用与恢复安全

[返回计划目录](README.md) · [M3 总计划](m3-reliability.md) · [前一步 M3-C](m3-c-persistence.md#12-c1c3-增量实施与验收记录) · [后一步 M3-E](m3-e-observation.md)

状态：**D0/D1/D2/D3 已实施并完成本地验收。** release 双失败已先失败后修复；同进程 B/R、39 个新增真实强杀场景、第三进程权威核验、实际 Node CLI、包消费和全仓门禁通过，证据见第 12 节。后续 [M3-E 已完成独立验收](m3-e-observation.md#8-本轮实施与验收记录)，M3 本轮计划范围完成；原有调查与 A/B/C 历史结果不计为 D 新增证据。

## 1. 目标与明确不做

D 要证明：故障后以权威状态继续，而不是以“调用抛错”推断没提交；不能重做未确认的副作用，不能用旧内存覆盖已提交事实。默认保持 checkpoint v1、HostSessionBinding v2、现有表结构与公开端口，只有实证缺陷才做最小修复。

- Query 标识不因恢复改变，Run 使用新标识；恢复只读取存储，不接受客户端拼装 checkpoint。
- 工具 dispatched 与回答消费是保守边界，不承诺外部影响恰好一次；unknown 不是 rollback。只有此前持久事实已知 applied 时，恢复才必须保留 applied。
- 历史与 checkpoint 不假设共享事务；继续使用持久追加意图、稳定 batchId 和幂等 receipt，不把它们合成一个新事务仓库。
- 无 TTL、自动接管、请求/工具自动重试、补偿、双写、通用故障框架或新管理平台。PPT、PG/MySQL、迁移/备份/HA、审计账本均不进入本步。
- 宿主确认旧 writer 已停止才可显式接管；SessionHost/CLI 不开放 takeover，不接受前端租约强制恢复。

## 2. 代码依据、已有证据与缺口

| 落点 | 方案制定时的事实 | 本步缺口（验收结果见第 12 节） |
| --- | --- | --- |
| `packages/harness/src/agent/runtime/run-controller.ts:279–295,336–369,375–409` | acquire 在清理 try 之外；resume 校验权威 checkpoint；持久失败不保存 failed 覆盖断点；finally await release | acquire 已提交但未返回 lease、空占位、release 双失败与终态确认未知 |
| `runtime/query/checkpoint-session.ts:41–109` | 只在 saved 确认后推进内存；history intent → append receipt → checkpoint 确认，恢复先对账再核对前缀 | input/tool/final 三批次及确认 checkpoint 的提交前/后失败 |
| `runtime/turns/tool-turn.ts:14–29,101–115,153–177,186–229` | dispatched 无结果、resume 消费后无结果转 unknown，不重进工具体；pending 已知 applied 保留 | 四个故障窗口、持久 status/effects 与真实副作用次数 |
| `tools/tool-pipeline.ts:153–270,279–335` | 续传解析/归属、当前授权、token、业务体与安全投影分开；拒绝可以成为工具结果而非整个 Query failed | 权限撤销、旧回答、先前 applied、恢复预算与故障组合 |
| `cli/host/internal/sqlite/` | 原子 Thread 准入、CAS/围栏/receipt 已由 C 验收；短事务，不覆盖外部能力 | 真实崩溃后的权威读取、精确接管与租约对账 |
| `tests/general-agent-runtime.test.ts` | execute/resume 副作用后结果保存前拒绝；input append 提交后丢确认；正常预算/终态已有用例 | 现有 faultingCheckpoint 是调用底层前抛错，不能充当“已提交丢确认”；缺 tool/final、消费前后与真实 kill |
| 现有 reliability worker/integration | C 的不同 PID、prepare/go、第三进程重开与正常 close 已具备 | worker 当前无工具/resume/故障状态，正常 close/disconnect 会清理，不能冒充 crash |

既有定位：runtime 中 `does not replay an external effect...`、`reconciles a committed-but-unconfirmed history append...`、`does not consume an answered interaction twice...`；infrastructure 中恢复重新授权与 applied 保留。优先扩展消费者可见断言，不复制既有成功路径，不新增 Core 私有导入。

## 3. 联网调研后确定的边界

| 官方来源 | 已查明的事实 | 本项目决策 |
| --- | --- | --- |
| [PostgreSQL 18 连接终止](https://www.postgresql.org/docs/18/protocol-flow.html#PROTOCOL-FLOW-TERMINATION) | 连接终止会回滚仍开放的事务，但服务端可能先完成非 SELECT 操作并提交，之后才发现断连 | 传输/确认失败不证明未提交；本轮用 SQLite 包装器复现应用确认丢失，不冒称已测 PG 网络故障 |
| [SQLite 隔离与 WAL 快照](https://www.sqlite.org/isolation.html) | 不同连接只能看到完整提交；WAL 读事务保持快照；同连接操作不是另一独立视图 | 对账另开权威连接；确认旧 PID 停止后读状态/租约，不拿旧连接内存或目录投影当依据 |
| [AWS：幂等 API 与安全重试](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/) | 安全重试依赖明确的请求身份及与业务操作一致的幂等契约；超时本身不足以判断影响 | batchId 仅保护相应历史批次，不泛化为工具幂等；工具 ledger 不自行去重，以免掩盖重复派发 |
| [Node 24 子进程 kill](https://nodejs.org/docs/latest-v24.x/api/child_process.html#subprocesskillsignal)、[close](https://nodejs.org/docs/latest-v24.x/api/child_process.html#event-close) | Windows kill 是强制终止；close 在进程退出及 stdio 收口后发生，kill 返回不等于已收口 | crash 模式强制结束本次 worker 并等待 close，不用 SIGINT/普通 close 冒充崩溃；不在 close 前接管或删库 |

资料为设计依据，不是故障注入结果；Node 24 系列在线文档本次显示 v24.22.2，本机探针为 v24.20.0，最终进程行为仍须在实际运行版本验收。

## 4. D0：先固定提交未知与错误保留

D0 是 D2 的前置工作，不是另建一个执行状态机。

### 4.1 acquire 确认丢失：区分空占位、已有断点与终态

本次原生 Node + SQLite 已观察：真实 acquire 返回成功后，公开端口包装器拒绝交付结果；Core 未调用模型/工具，但 owner 已持久保存。Application 关闭不替调用方猜测并释放这份未收到的 lease。

| 权威状态 | 恢复决定 | 禁止行为 |
| --- | --- | --- |
| 有 owner，payload=null、revision=0 | 确认旧激活停止；受信任宿主以同 key acquire 得到 busy 的完整 lease，再精确 replace 读取；确认确为未初始化占位后 release 新 lease，保留 generation。报告“没有可恢复 checkpoint”，不得伪造输入 | 不凭 findUnfinished=null 当线程空闲，不删行或清 owner，不调用 resume 重建状态 |
| 有非终态 checkpoint | 原 Query、新 Run，使用精确旧 lease 显式 takeover，按权威 pending/inflight 恢复；只有仍 waiting 且 interaction 匹配时才可重新提交尚未消费的回答 | 不重建快照，不默认复用旧 Run/signal，不自动重发已消费回答 |
| 有 completed/cancelled/failed | 确认状态并清理精确残留 lease；保持终态，正常 resume 仍拒绝 QUERY_TERMINAL | 不因当前句柄报错就续跑，不用新 Query 越过旧活动 owner |
| 普通新 key 未提交任何占位 | 对照组不留 owner/checkpoint/history；是否重新提交仍由显式调用决定 | 不把所有 acquire 异常都分类为 busy 或自动重试 |

空占位的关键限制：**输入尚未持久保存，无法保证自动恢复原请求。** 只有调用方仍拥有原始输入且明确重新提交时，才可在受信任清理后用 `run()`、相同 provisional queryId、新 runId 提交；这是显式重新受理，不是 resume，也不要求客户端提供执行快照。原输入已丢失则报告不可续跑，不杜撰数据。该维护流程通过现有公开存储端口验收，不为本轮新增管理员 CLI。

本次探针实际观察到：空占位不在 findUnfinished 中；同 Query busy，另一 Query thread-pending；带 takeover 的 resume 拒绝 QUERY_NOT_FOUND，finally 释放其新 lease；后续显式同 Query/new Run 的 run 可完成。方案推荐直接以存储接管/读取/释放检查空占位，不把一次预期失败的 resume 当作日常解锁 API。

已有 waiting 的 acquire 丢确认探针：回答尚未消费、工具体零进入；确认旧激活停止后按原 interaction、原 Query/新 Run 与精确 takeover 完成，工具体共进入一次。两类结果不能合并写成“acquire 丢确认均可 resume”。

### 4.2 已复现缺陷：release 覆盖执行失败

方案制定时，公开包装器让首次 checkpoint save 拒绝，再让 release 在委托底层前拒绝。原生实测 `handle.completed` **仅拒绝 releaseError，PERSISTENCE_FAILED 被 finally 覆盖**；模型零调用、lease 仍 busy，随后由调查程序精确释放。本轮已按下述要求修复，证据见第 12 节。

最小修复要求：

1. 先补失败回归，确认执行与清理双失败都保留；再在 run-controller 的执行/释放交接处聚合，不改变成功路径和持久状态。
2. 单执行失败保持原拒绝；单 release 失败仍拒绝，不能把已持久 completed 当作清理成功；双失败用内部 AggregateError 保留两者，不吞 release，不以 finally 覆盖前错。
3. 覆盖 release 委托前拒绝（owner 保留）与真实释放后拒绝（owner 已空），不将二者都报告为“锁未释放”。persistence/conflict 的原始分类不能被清理错误抹掉，安全投影不泄露原生异常。
4. 不为解除租约而保存 failed、重写 terminal、重试副作用或自动接管；恢复由权威 owner/generation/status 决定。必要时只迁移受影响错误消费者，不新增公共错误类型或框架层。

## 5. 故障模型与确定性门闩

| 标签 | 注入位置 | 允许的证据声明 |
| --- | --- | --- |
| B：提交前拒绝 | 选中公开 save/append/acquire/release，不委托底层，抛一次性已知错误 | 该操作未提交，旧权威状态仍在 |
| R：提交后拒绝 | await 底层成功后不交付结果，拒绝一次 | 存储已提交但调用方未确认；可能执行 finally，不是崩溃 |
| K0：提交后、Core 获确认前死亡 | await 底层成功，在 wrapper 返回前发 boundary 并暂停，父进程强杀 | 只证明已提交且未交付确认，不标作 Core 已确认 |
| K1：Core 获确认后死亡 | 底层结果已返回，在下一公开端口/能力边界发 boundary 并暂停，再强杀 | 证明 Core 已接受成功、后续阶段未进入；不执行优雅清理 |

selector 精确匹配 key/Run/callId/interactionId、checkpoint 判别状态或稳定 batchId，不靠“第 N 次调用”。命中一次后关闭故障，恢复进程不再注入。B/R 用同进程重开连接和实例的行为回归；K 用不同 PID 与同一隔离磁盘库。

**禁止用观察消费暂停执行。** handle.events 是独立队列，async consumer 返回 Promise 不会阻塞 Core 的 emit。K1 的 dispatched-before-body 与 consumed-answer-before-resume 使用宿主 `authorizeTool` 异步门闩：持久 save 已确认后才会走到执行/续传管线的重新授权；门闩不放行，业务体尚未进入。按完整 RunIdentity/callId 区分初始与恢复授权。schema 使用无自定义 transform/refine/preprocess 的普通 Zod 校验，ledger 只在 execute/resume 体内写；只声称“业务体零进入”，不声称所有准备代码都未运行。

其它可达 K1 边界：acquire 后的 history.read；append 后的确认 checkpoint.save 入口；已确认 input/tool checkpoint 后的下一模型端口入口。工具真实副作用之后、返回结果之前可在工具体内暂停。终态 save 后的 K1 可停在 release 入口。不得新增 Core 测试钩子或私有 observer 阻塞。

## 6. D1：派发与回答消费矩阵

以下四个窗口分别覆盖 B/R 和至少一种真实 kill，明确 K0/K1 相对哪一次存储提交。工具体内“副作用已 sync、completion save 尚未发起”的死亡单列为 effect-before-save，不误称 completion save 的提交后死亡。每组用真实 ledger，不让工具自行幂等去重。

| ID | 窗口 | 必须观察的结果 |
| --- | --- | --- |
| D1-1 | dispatched save 前/后、execute 业务体前 | B 保持 pending，恢复可执行一次；R/K 保持 dispatched，恢复不得 execute，生成 unknown/unknown，execute ledger=0 |
| D1-2 | execute 已追加并 sync 真实副作用、completion save 前/后 | completion 的 B 或工具体 effect-before-save 死亡：仍 dispatched，恢复 unknown，execute ledger=1。completion 的 R/K0/K1：已有持久 completion，复用原结果、ledger=1，不降成 unknown、不重 execute |
| D1-3 | 回答消费 CAS 前/后、resume 业务体前 | B 仍 waiting，原回答可在新 Run 正常消费；R/K 为 inflight resume，带旧回答拒绝 STALE_INTERACTION，无 response 恢复 unknown，resume ledger=0 |
| D1-4 | resume 已 sync 真实副作用、completion save 前/后 | completion 的 B 或工具体 effect-before-save 死亡：仍为持久 resume，恢复 unknown，resume ledger=1。completion 的 R/K0/K1：复用已保存 completion、ledger=1，不再 resume 或 execute 原工具 |

D1-3 与 D1-4 中实际恢复为 unknown 的分支，分别设置 waiting.effects=none 与已持久 applied；后者必须得到 `status=unknown/effects=applied`，前者可为 unknown/unknown。completion 已提交的分支则保持该 completion 原本的 status/effects，不统一改为 unknown。首次 execute 的结果丢失、此前没有持久 applied 时，即使外部 ledger 有一条，也不能要求 Core 推断 applied。

证据按分支读取：恢复实际生成 unknown 时，检查新 Run 的公开 tool.completed 及进入历史前的权威 checkpoint；completion 已提交的 R/K0/K1 不要求恢复重发 tool.completed，因为事件不是持久日志，恢复可能直接组装已有工具结果批次。后一类在恢复 acquire 读取权威 checkpoint 时、completion 被历史确认替代之前，捕获完整 status/effects，再核验后续规范历史有序配对一次和 ledger 不增加。最终 modelContent 不能单独证明 effects，不新增事件重放协议，不要求未知影响回滚。

## 7. D2：历史、终态与租约矩阵

使用确定 query：input → 一个工具回合 → final。分别绑定 `${queryId}:input`、`${queryId}:step:1` 和 `${queryId}:step:2`，不依赖内容措辞或调用次数。

| ID | 故障窗口 | 恢复与持久断言 |
| --- | --- | --- |
| D2-1 | acquire 的 B/R/K0/K1，空占位与既有 waiting/running 分开 | 按第 4.1 节分类；不派发、不绕开占位；busy 返回完整旧 lease，接管前先确认旧 writer 停止；代际不重用 |
| D2-2 | input/tool-pair/final append 的 B/R/K | B 保持意图，恢复提交一次；R/K 已有 receipt，恢复原 batch/payload，revision 不重复增加；callId 与结果一一配对、ledger 不重做 |
| D2-3 | 上述三批次 append 已成功，但确认 checkpoint 的 B/R/K | B 允许历史领先 checkpoint，通过原 receipt 对账；R/K 已持久的进度不被旧内存覆盖，不等于 Core 已收到确认；持久状态已到 completed 时按终态拒绝，不重新 drive |
| D2-4 | completed/failed/cancelled save 提交后丢确认或 kill | 当前激活可报拒绝，但权威终态保持；run 同 Query 拒绝 QUERY_EXISTS、resume 拒绝 QUERY_TERMINAL；不再模型/工具调用 |
| D2-5 | release 的 B/R，叠加执行成功/持久失败/围栏冲突 | 按第 4.2 节保持拒绝与错误；核对真实 owner，而非从 error 猜锁状态；已提交终态/历史不回退 |
| D2-6 | 旧 writer 已停止后接管，新代已保存；再投递旧 save/release/replace | stale 优先于 revision conflict；旧 release 不清新 owner；过期接管不取得写权，不覆盖新 checkpoint |

必须区分：**final append 已提交、completed 未提交**可恢复对账；**completed 已提交、确认丢失**不可续跑。正常恢复先 reconcileHistory 再 verifyHistory，不能把预期的历史领先视为损坏；反过来，真实异内容 receipt 冲突或无合法前缀必须明确拒绝，不静默修史。

history receipt + checkpoint CAS 的存储竞争已有 C 证据，本步补其运行时故障链路，不重复写一套只测端口转发的用例。释放/错误保留矩阵也供 E1 的“终态 fact 不等于完成承诺”复用，不重复建设故障夹具。

## 8. D3：权限、回答和累计预算

| ID | 从真实 waiting 重建实例后的动作 | 必须观察的结果 |
| --- | --- | --- |
| D3-1 | 宿主策略从允许/原审批变 deny，或审批要求改变；用户提交旧批准 | 恢复重新授权，未获当前权限不进入工具体；可能形成失败工具结果并继续模型，而非强制整个 Query failed；原 applied 保留 |
| D3-2 | 拒绝、取消、错误 interaction、旧回答再次提交 | 错误 interaction 在消费前拒绝；匹配拒绝/取消只消费一次；已消费无结果的状态不凭旧回答再 resume；终态拒绝；拒绝不抹掉前序 applied |
| D3-3 | 多次 waiting/恢复跨越模型步数边界 | 同 Query、新 Run；maxSteps 与 committed.step 从权威 checkpoint 延续，Core 使用较小预算，不能靠恢复重置；Host 预算改变仍按 binding 拒绝 |
| D3-4 | 同版本 owner/schema/continuation 深层不兼容 | 明确此时回答可能已被持久消费，但业务体尚未进入；检查实际工具失败/unknown 与 effects，不错误要求保留原 waiting 或自动重试 |

优先复用 infrastructure 的管线测试和 runtime 的真实 SQLite fixture，将缺口提升为公开端到端行为，不复制 C3 definition/plugins/model 的拒绝矩阵。授权策略是宿主端口，插件不能自行批准自己。预算拒绝、权限拒绝、终态和 unknown 四种结果分开记录，不用统一“失败”掩盖影响。

## 9. 进程、ledger 与资源所有权

扩展现有 `tests/fixtures/general-agent-reliability-entry.mjs` 与 `tests/general-agent-reliability.integration.test.ts`，不新增另一套 Vite/Electron 入口：

1. worker 增加真实文件 resumable capability、确定 tool-call 模型、resume 及一次性 fault selector；继续消费 Core exports 和 cli/dist SQLite。
2. ledger 是独立临时文件，每次实际进入业务体追加 `{scenarioId, agentId, threadId, queryId, callId, phase, interactionId?, runId, pid, nonce}` 并 sync。不能以同内容覆写、进程内 counter 或工具自行去重作为唯一证据。
3. 父进程等精确 boundary，强制终止本次 worker并等待 close；不发 release、普通 close 或先断开 IPC，避免 disconnect handler 优雅释放改变故障窗口。
4. 新 PID 从权威存储读取，普通 acquire 得 busy 的完整 lease；确认旧 PID 停止后才 replace。第三 PID 核对持久 history/receipt/checkpoint/owner/generation，不仅看 IPC 成功或最终文件存在。
5. 正常完成只由 worker 发 disconnect，父端等待 close，保留 C 修正的单一断开所有者；超时只回收失败进程，不当正确性证据。仅清理本次 PID/目录，stdout 不用则 ignore，stderr 有界收集且不暴露凭据/完整重放数据。

进程强杀只能模拟应用进程死亡，不能模拟存储介质掉电或网络数据库 COMMIT ACK 丢失。副作用文件 sync 加 SQLite FULL 也不是跨两者事务；最终证据必须分层表述。

## 10. 实施顺序、落点与检查

| 顺序 | 动作 | 文件落点 |
| --- | --- | --- |
| D0 | 运行相关现有基线；固化空占位恢复决定；先失败回归再修 release 双失败错误保留 | runtime 测试、run-controller；必要时受影响错误消费者 |
| D1/D2 同进程 | 将现有 fault wrapper明确为 B/R；覆盖矩阵并在旧实例和连接关闭后重开 | `tests/general-agent-runtime.test.ts`，必要时同责任具名测试文件，不新建通用框架 |
| D3 | 授权/回答/预算与已有 applied 组合 | runtime/infrastructure/development-host 现有测试，复用真实文件端口 |
| K 进程验收 | 扩展现有 worker、故障边界及强杀/接管，逐组第三进程核验 | 现有 reliability fixture/integration，仍在 test:integration:harness |
| 集中收口 | 实际入口烟测、包消费及全仓门禁；记录限制与完成状态 | 本文、总计划、目录、整体路线 |

模型使用受控实现或 SDK 到本地 HTTP/SSE，不产生远程厂商用量。公开符号若确需改变，先查引用再一次迁移全部端口/消费者；不放宽边界门禁或添加兼容旧语义的默认实现。

待实施检查：

```text
npm.cmd run build:cli
npx.cmd vitest run tests/general-agent-runtime.test.ts tests/general-agent-infrastructure.test.ts tests/general-agent-lifecycle.test.ts tests/general-agent-session-host.test.ts tests/general-agent-host.test.ts
npm.cmd run test:integration:harness
node scripts/verify-harness-package.mjs
node scripts/verify-tools-package.mjs
npm.cmd run typecheck
npx.cmd biome check <本次修改的受支持文件>
npm.cmd test
```

构建、测试和包消费顺序执行，避免多个命令同时清理同一个 dist；出现工作区并行变更先核对源/产物，再定点运行，不用重复执行失败命令猜原因。只有行为或产物边界变化才补相应真实消费，不为本步重复安装器/ASAR。

完成门槛：D0/D1/D2/D3 每项有对应 B/R/K 与权威状态证据；已复现 release 覆盖先失败后通过；未知/终态/权限/预算不被混淆；实际文件 ledger 次数、历史配对、租约与代际同时正确；原生进程路径、实际 Node CLI、包消费及全仓门禁通过，跳过明确列出，临时资源清理。达到后才标记 D 完成，再由 E 集中验收观察/入口，不宣称 M3 已整体完成。

## 11. 本次方案制定证据

以下为方案制定阶段的历史记录；“未实施”等表述不代表第 12 节所记录的当前状态。

- 已阅读本节所列 Core、SQLite、工具授权与现有故障测试；官方来源已实际查询/阅读，未连接 PG/MySQL。
- 一次性原生 Node v24.20.0、真实 SQLite、公开 Application：acquire R 的空占位与已有 waiting 两类已实际执行，观察结果见第 4.1 节；没有修改持久数据模拟真实 checkpoint，没有远程调用。
- 一次性真实 SQLite 双失败探针已复现第 4.2 节：保存拒绝被释放拒绝覆盖，模型调用 0，真实 owner 保留；精确维护释放后清理。它是待修复缺陷证据，不是通过验收。
- 本次未实施永久测试/运行时修复，未执行强杀矩阵、全量测试、类型门禁或真实厂商调用。程序 finally 已清理各自隔离数据库，临时探针目录 `.vite/m3-de-design-91f6/` 已删除并确认不存在；不保留调查脚手架。
- D/E 两路只读方案复核已完成；修订了 completion 已提交时不应判 unknown、恢复不要求事件重放，以及真实存储故障/CLI 结算证据分层等边界，复核确认相关阻塞已解除。这是方案可实施性复核，不是运行时验收。
- 交付前校验本轮 6 份文档的 100 个本地链接与标题锚点，全部有效；新增 D/E 文件、目录、总计划与整体路线互相可达。

## 12. 本轮实施与验收记录

### D0：执行与租约释放错误保留

- `run-controller.ts` 在原执行错误处理之外保留最终拒绝，再单独处理 release：单执行失败原样拒绝，单 release 失败仍拒绝，双失败用内部 `AggregateError` 保留 `[executionError, releaseError]`。不改变 checkpoint、历史、租约端口或持久格式。
- runtime 新增执行成功、首存拒绝、真实新代接管围栏三类与 release B/R 的六分支。修复前双失败四分支全部失败（只收到 releaseError），修复后六分支通过。真实只读 SQLite 同时核对 owner、generation、payload 与历史；release R 不等于 owner 仍在，旧 release 不清新代 owner。
- 修改前相关 runtime/infrastructure/lifecycle/session-host/host 基线：5 文件、116 项通过。`npm.cmd run build:cli` 通过。
- 一次性原生 Node v24.20.0、公开 Application + 磁盘 SQLite 烟测：双失败同时保留，模型零调用；关闭旧实例/连接后重开，空占位不出现在 unfinished，但同 key 为 busy；精确 replace 得 generation=2、payload=null、revision=0，再 release。显式同 Query/新 Run 重新受理完成；终态 resume 拒绝，模型总调用一次，最终验证租约 generation=5。隔离目录与一次性程序已清理。
- 错误消费者有意不改：Core 的 `asProtocolError` 与 CLI 的 `terminalError` 只信任公开 `AgentError`，聚合错误走现有固定安全投影，不序列化原生异常；内部 completed 拒绝仍保留两份错误及原持久化/围栏分类。

### D1/D2/D3：同进程 B/R 恢复

| 验收组 | 永久落点 | 已执行结果与边界 |
| --- | --- | --- |
| D1-1～4 | `general-agent-recovery-effects.test.ts` | 四窗口分别覆盖 B/R、execute/resume ledger、原 none/applied、持久 completion status/effects、旧回答拒绝、新 Run unknown 事件及历史前的权威 completion；原 24 分支通过后去掉 6 个提交前完成状态的等价行，保留 18 个不同故障/持久结果分支 |
| D2-1～4、6 | `general-agent-recovery-persistence.test.ts` | 24 项通过：空占位/waiting/running acquire B/R；input/tool/final append 与确认 checkpoint B/R；三类终态 R；旧 writer save/release/replace 围栏；异内容 receipt 与非法前缀明确拒绝 |
| D2-5 | `general-agent-runtime.test.ts` | 六个执行/释放组合通过；不以拒绝推断 owner，不回退已提交终态 |
| D3-1～4 | `general-agent-recovery-policy.test.ts` | 22 项通过：当前 deny、审批改变/拒绝、错误 interaction、匹配拒绝/取消、消费 R 后旧回答拒绝、跨多次 waiting 的累计/较小预算、同版本 owner/schema/深层 continuation 不兼容；none/applied 分开核对 |
| D3 宿主预算绑定 | 既有 `general-agent-development-host.test.ts` | 与 D3 新文件合跑 54 项通过；继续复用宿主预算增减拒绝，不复制兼容矩阵 |

以上均使用受控模型、磁盘 SQLite、关闭旧实例和连接后重开，以及真实追加并 sync 的文件凭据。深层 continuation 不兼容由能力的 resume 入口解析拒绝：业务写入段与 ledger 未进入，不声称 resume 函数本身零调用。持久 completion 的恢复不要求重发事件。

集中定向回归曾运行 9 文件、224 项通过；最终精简矩阵后的全量结果见下节。真实 Node CLI 两个既有 integration 文件、8 项通过，模型为本地 HTTP/SSE；这不是远程厂商验收，也不是强杀矩阵。

### K：真实进程死亡与独立核验

现有 reliability worker/integration 原位增加 39 个强杀场景，保留原 15 个竞争/准入场景。最终 reliability 定点运行 54 项全部通过：

- D1：dispatched、消费回答、execute/resume completion 的 K0/K1，以及 execute/resume 体内 ledger 已 sync、completion save 未发起的死亡；resume 的原 none/applied 分开验证。
- D2：空占位/waiting/running acquire K0/K1；input/tool/final 三批次 append 与 checkpoint 确认 K0/K1；completed/failed/cancelled save K0/K1。
- 父进程收到精确 boundary 后 SIGKILL，并等待 close；没有先 disconnect 或优雅 close。下一 PID 普通 acquire 得完整 busy lease；确认旧 PID 收口后精确 replace，检查 generation、权威 checkpoint 和历史，再执行恢复。空占位只精确维护/释放，不制造输入。
- 第三 PID 核对终态、generation、无 unfinished、history revision/调用结果配对、稳定 batch receipt 与独立 fsync ledger；旧 save/release/replace 不破坏新代。已提交 completion 保持 succeeded/applied，不要求重放事件；实际 unknown 分支同时核对恢复事件和历史前的持久 completion。
- 首次集成发现夹具将未提供的 response/takeover 显式传为 undefined，被公开协议校验拒绝。已改为省略可选字段；没有放宽 Core 校验或改变恢复语义。修正后 54 项通过。

这些结果只模拟应用进程死亡，不模拟掉电、介质故障或网络数据库 COMMIT ACK 丢失；SQLite 与副作用文件仍不是跨资源事务。

### 集中门禁与限制

- `npm.cmd test`：205 文件通过，1897 项通过、3 项既有平台跳过（Windows 下两个 symlink 场景与非 Windows 凭据不支持场景）；不是新增跳过。
- `npm.cmd run typecheck`：通过，包括 Harness/logs/models/tools/CLI+configuration 边界及 node/web/CLI 编译工程。
- `npm.cmd run test:integration:harness`：最终完整运行 3 文件、62 项通过，无跳过；其中 reliability 54 项（新增强杀 39 项）、实际 Node CLI 8 项。首轮夹具协议错误及修正已在上节记录。
- `node scripts/verify-harness-package.mjs`、`node scripts/verify-tools-package.mjs`：最终构建产物的仓库外 tarball 安装、声明与原生消费者通过；包脚本的内存存储不冒充持久性证据，真实 SQLite/强杀由上节承担。
- `npx.cmd biome check`：本次修改的 7 个受支持代码文件全部通过，无警告。`npm.cmd run agent -- --help` 实际 Node 启动通过，行为烟测由 CLI integration 承担，不以 help 代替恢复。
- 最终原生 Node v24.20.0 烟测再次覆盖持久首存失败叠加 release B/R：两份错误均保留，公开 `asProtocolError` 不含原生诊断，模型零调用；重开连接后 B 为 busy、R 可 acquired，维护后 generation 均为 2。一次性脚本与隔离库均已删除。
- 不增加远程厂商调用，不更改 HostSessionBinding v2、checkpoint v1、表结构或公开端口，不新增自动接管、工具重试、补偿或管理员 CLI；生产 UI/PPT/旧 Agent 不迁移。D 自身通过不代表 M3 整体通过；随后 E 已完成独立验收，最终结论及新增门禁见 [E 第 8 节](m3-e-observation.md#8-本轮实施与验收记录)，本节保留 D 实施时的历史数字。
