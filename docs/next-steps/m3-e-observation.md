# M3-E：观察独立性与实际入口闭环

[返回计划目录](README.md) · [M3 总计划](m3-reliability.md) · [前一步 M3-D](m3-d-recovery.md) · [已完成 M3-C](m3-c-persistence.md#12-c1c3-增量实施与验收记录)

状态：**E1/E2 已实施并完成本地验收，M3-A～E 的计划门槛已满足，M3 本轮验收完成。** 有限观察、真实 CLI 持久断言、慢输出/断管/错误结算、生产与开发实际入口、包消费及全仓门禁证据见第 8 节。容量治理、HA、第二后端及 M4/PPT 迁移不随本次完成。

## 1. 目标与不可扩张的声明

E1 证明有限事件序列下，观察不是执行驱动或恢复历史；E2 证明真实 Node 入口正确消费执行协议，而非另造一套执行器。复用现有 Core 包、Node CLI、SQLite 与集成夹具，不回退 Electron，不新增 Vite 或供应商接入。

- Core `handle.events` 单消费者；放弃观察不等于 cancel，等待 `completed` 不要求先消费事件。
- stream delta 是临时内容；fact 也是观察协议，不普遍等同持久提交。规范历史/checkpoint 才是恢复权威。
- `run.completed` fact、`handle.completed` 成功、Host.close、CLI process exit 是不同边界，必须分别断言。
- 容量、吞吐、无界队列治理、默认丢事件、暂停模型、DoS/插件沙箱、全局配额不在本步。不承诺不合作模型/工具的固定关闭时限。
- 本轮不增加远程厂商调用，不沿用历史 MiMo/ConPTY 成功冒充新增故障矩阵通过；生产 UI/PPT 迁移仍归 M4。

## 2. 当前实现与已有行为盘点

| 落点 | 已实现/已有断言 | E 的缺口 |
| --- | --- | --- |
| `packages/harness/src/agent/runtime/event-stream.ts:4–71` | emit 不等消费者；close 保留未读队列；return 清队列并放弃观察；单消费者与空队列 pending-next 限制 | 经公开 handle 验证有限完整顺序、慢消费与并发读取，不新增私有类导入 |
| `runtime/default-agent.ts:90–177` | 每 Run 独立 identity/controller/stream；后台执行、Run scope 清理、清槽、events.close 后才落定 completed | 跨 handle 真正交错读取、完成前后观察与清理组合 |
| `agent-contract.ts:58–68`、`session/session-events.ts:11–18,47–93` | completed 包含 Run 清理；event.identity 属于当前 Run，invocation.identity 可以属于原 Run | 不将恢复调用身份错误改成当前 Run，不依据单条终态 fact 报成功 |
| `tests/general-agent-lifecycle.test.ts` | 不消费完成、立即 return 不取消、release 门闩、旧 cancel 隔离、已有私有流基础测试 | 部分读取后 return、确定暂停消费者、公开 pending-next 边界 |
| `tests/general-agent-session-host.test.ts` | 真实 SQLite/文件、完成后 drain、恢复身份、两个 Agent 隔离 | 有限流式事实完整性与 A/B.next 真交错，而非依次事后 drain |
| `cli/main.ts:23–29`、`terminal-controller.ts:135–165,356–444,785–880` | 普通输出等待 write callback；观察与 Core 完成分开；输出失败主动关闭宿主并排空 | 慢 Writable 与实际 EPIPE 分类、终态 fact 后 completed 拒绝的真实状态证据 |
| 现有两项 CLI integration | Node + DPAPI + 本地 SDK HTTP/SSE；无插件、默认只读、写审批、EOF、重启批准/拒绝/取消、key rotation、绑定变化、断管 | 强化四段身份、规范历史/回答消费、原配置成功对照和故障结算，不复制全部入口 |

这些是代码覆盖盘点，不是本次重跑结果；C 已记录的三文件集成及实际 CLI 烟测属于历史证据。

## 3. 联网调研与边界决策

| 官方来源 | 确认的边界 | 采用方式 |
| --- | --- | --- |
| [MDN for await...of](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for-await...of) | break/异常提前退出会调用并等待 iterator.return；return 如何影响生产者取决于实现 | Core 自定义 return 只放弃观察，不能照搬 Node Readable 的销毁/取消语义 |
| [Node 24 Writable.write](https://nodejs.org/docs/latest-v24.x/api/stream.html#writablewritechunk-encoding-callback) | write=false 表示暂停后续写入直至 drain；callback 表示该 chunk 被处理；highWaterMark 是阈值而非严格内存上限 | 普通 CLI writer 描述为串行等待 callback，不能谎称实现了独立 drain 订阅；终端恢复 writer 已单独处理 callback/drain/error/close |
| [Node 24 process I/O](https://nodejs.org/docs/latest-v24.x/api/process.html#a-note-on-process-io) | Windows stdout/stderr 到 pipe 可能同步阻塞；TTY/平台行为不同，慢写可能阻塞事件循环 | E1 只证明异步观察解耦，不承诺任意 OS 管道阻塞时同进程 Core 仍推进；有限受控慢 Writable 与真实管道断开分别验收 |
| [Node 24 child process](https://nodejs.org/docs/latest-v24.x/api/child_process.html#event-close) | 进程退出与 stdio close 不同；未消费管道可能阻塞 | 保留 C 的单一 disconnect 所有者及 close 收口；不用无限输出制造“慢消费者” |

Node 在线来源为 24 系列文档，本机调查程序为 v24.20.0；来源仅定义设计依据，不代替实际平台测试。

### 3.1 必须分开的三条路径

1. **Core 退订**：iterator.return 不调用 handle.cancel；后台执行继续，剩余观察可被丢弃，但规范历史照常提交。
2. **CLI 输出失败**：EPIPE/其它 output error 由宿主策略主动 close；可能导致 interrupted，或已经 completed。它不是 Core 因失去观察者自行取消。
3. **CLI 慢输出**：异步写回调未完成会停住观察任务，Core 仍可提交并释放 Run；CLI 进程需要等待观察/输出收口。Windows 同步 OS 写若直接阻塞整个事件循环，不属于该异步证明。

保持现有安全策略，不改成“断管后永远继续执行”，不加线程池规避物理阻塞，不借 E 引入丢事实事件或模型背压。

## 4. E1：公开句柄观察矩阵

使用现有公开 Application/SessionHost fixture、真实 SQLite 和有限受控 model.stream；最终权威 assistant 内容刻意不同于 delta 拼接。每条流固定少量具名 delta/事实，断言语义顺序与身份，不锁定内部辅助调用数或源码措辞。

| ID | 确定性交错 | 必须观察的结果 |
| --- | --- | --- |
| E1-1 不消费/事后 drain | 不 claim events，让模型完成并经过 terminal save/release；await completed 后再完整 drain | completed 与租约释放不依赖消费；历史/checkpoint 只有权威消息；有限序列无遗漏/重复，最终 next.done=true |
| E1-2 慢消费 | 读取到指定 delta 后停在消费者自己的门闩；放行模型完成；在消费者仍暂停时检查存储、release 和 completed，再放消费 | Run 可以完成，消费恢复后保持本流顺序与内容；不以 sleep/耗时阈值证明独立性，不用观察门闩控制 Core |
| E1-3 部分读取后 return | 至少消费 run.started 与一条 delta，再 return；继续放行模型 | signal 未因此 abort，规范执行正常完成；旧 iterator 后续 done；不能重新 claim；旧 handle.cancel 不影响新 Run |
| E1-4 双 handle 交错 | 不同 Agent/Thread/Query/Run 共享端口、独立模型门闩；A.next→B.next→B.next→A.next，再分别 drain | 四段 event.identity 与所属 handle 匹配、各流局部顺序正确，历史/租约不串；不要求两流具有全局总序 |
| E1-5 消费者边界 | claim 一次；将已有队列读空，用模型门闩阻止新事件；一个 next 已挂起后再 next，随后放模型 | 第二 pending next 拒绝 event-stream-busy，不抢第一 next 的事件；第二 iterator 始终拒绝 event-stream-consumed，return/close 后也不重新 claim |
| E1-6 终态 fact 与清理失败 | 复用 D2 release 的 B/R 与双失败场景，完整消费或事后 drain | 可以先看到 run.completed，但 completed 仍须拒绝；不伪造 failed checkpoint，分别核对 owner 保留/已释放；CLI 不依据 fact 报成功 |

E1-5 不能简化为“任意两个未 await 的 next 都拒绝”：有队列时 next 已立即消费并返回 resolved Promise。只有空队列上已有 pending 的竞争是 busy。无需改异步迭代接口来让偶然实现测试通过。

恢复场景补一组身份对照：当前 event.identity 使用恢复 Run，而 tool.completed.invocation.identity 保留原始派发 Run。waiting 后旧 signal/旧 handle 不能干扰新 Run；复用 B/C 证据，避免重复搭建。

### 4.1 顺序与权威性判据

- run.started 在输入追加意图保存后发出；输入 batch 可先产生 step=0 的 step.committed。对同一模型 step 核验 step.started → 对应 delta 序列 → 对应 step.committed，最后再有 run.completed；不错误要求输入提交晚于模型启动。工具/交互场景按公开事实核验先后关系，不要求跨 Run 全局顺序。
- 模型流未权威完成、截断或持久化失败时，不把临时文本提交为成功历史；复用 runtime 既有 provisional stream 回归，不再钉一套字符串。
- 对 E1-6，以 completed 的落定及权威状态裁决结果，不把事件队列当持久账本。Run completed 不包括 Agent binding/plugin 的长寿命关闭，Host.close 另验。
- RuntimeEventStream 数组当前无容量上限，落后消费者可能保留已读前缀，close 不清未读；有限场景通过不能推出内存有界或抗拒绝服务。

## 5. E2：实际 Node CLI 增量闭环

唯一执行入口仍是现有 `tests/fixtures/node-cli-entry.mjs` 导入的 cli/dist 真 runCli/createNodeHost，以及生产 `node cli/dist/main.js` 的自启动路径；继续使用已有 `node-cli-process.ts`、两项 CLI integration。本步不新增配置副本、私有模型 SDK 直连或恢复入口。

| ID | 复用既有用例 | 必须补齐的验收 |
| --- | --- | --- |
| E2-1 无插件/只读 | 无插件 piped query、默认 read-only 真实随机文件读取 | 四段 identity 对齐；规范历史 user→assistant 或 user→assistant call→tool result→assistant，callId 成对、revision 与 checkpoint 一致、owner 空；不暴露 replay/reasoning/Key |
| E2-2 写审批/EOF/批准 | EOF waiting=3→只读 inspect→同连接 key rotation→新进程批准 | 批准前不创建目标文件；同 agent/thread/query、新 run；interaction 只消费一次；终态不可用旧回答重复恢复，真实文件内容与持久历史一致 |
| E2-3 拒绝/取消/旧回答 | 现有 reject/cancel 参数组及 stale interaction 输入 | 错误 interaction 前后仍为原 waiting/pending；有效拒绝/取消只消费一次，不产生写影响、前序历史/applied 不丢；completed/cancelled 与 owner 释放精确一致 |
| E2-4 环境变化 | 现有 change-budget（实际改 gateway.maxOutputTokens）、恢复原设置后批准 | 拒绝不覆盖 binding/checkpoint/history、不调用模型/工具；原配置仍可恢复原 interaction。不要误称只改了 maxSteps，也不复制 C3 所有绑定维度 |
| E2-5 有限慢输出 | 通过公开 runCli 注入受控 Writable；在 progress/run.started 的写 callback 门闩暂停，包装真实宿主只观察 handle.completed，不改变执行 | 输出暂停期间真实 checkpoint 可终态、lease 可释放，但 CLI 仍待观察输出排空；放行后输出完整且退出。不是 fake host 回声测试，不声称真实 OS pipe 永远非阻塞 |
| E2-6 实际断管/错误结算 | 真子进程只验证现有 stdout.destroy/EPIPE；D2/E1-6 验真实 SQLite release/双失败/owner；CLI 通过现有 createHost 入口单独验拒绝与退出优先级 | 纯断管 141，权威 Query 可 completed/interrupted。completed 拒绝时不输出该 Run 的 assistant.message/query.result completed；completed 已成功、随后仅 Host.close 拒绝时允许已输出真实 Query 成功，但最终进程必须 1、可交付 process.finished 必须 failure |

E2-6 的三层证据分别报告：createNodeHost 当前不暴露 checkpoint/release 注入端口；替换或包装 handle.completed 只能验证 CLI 结算，不能算真实 SQLite release 故障。为组合测试不新增生产存储注入 API，不把 D 的 Application 夹具冒称完整 Node 宿主；正常真实 Node 持久路径、真实 EPIPE、D 的实际存储故障与 CLI 的失败结算共同验收，但不声称已执行一个无法注入的完整宿主持久故障场景。若未来确需该组合，须先另定最小注入协议及资源所有权。

默认文件能力 read/glob/grep 自动允许；write/edit 宿主审批。显式 requireReadApproval 的场景单独标记，不把旧“批准前不得读取”的配置提升为全局默认。`--prompt`/print/JSONL 不从 stdin 猜审批，piped `/exit` 是用户文本。恢复入口禁止换 prompt/model/tools，不能靠新请求“同意”替代持久 interaction。

文件同内容最终存在不能单独证明仅执行一次。工具次数的强证明优先复用 D 的独立 append+sync ledger；生产文件能力 E2 结合 mode=create 拒绝覆盖、历史唯一配对、终态旧回答拒绝与实际文件结果，不伪称已测任意外部影响 exactly-once。

### 5.1 inspect 与输出的安全边界

现有 inspect 仅输出 status/runId/leaseReleased/interaction/model；为新增断言只扩展必要的具名安全字段或在父进程本地只读核验：identity、revision、batchId/调用配对计数、pending 是否存在。不要把完整 checkpoint、continuation、replayState、工具参数/结果或配置凭据塞进公开 CLI 输出。

JSONL 的 progress/run.completed 不是成功结算；assistant.message/query.result 来源于 completed 成功，process.finished 还取决于关闭与输出结果。输出损坏时不要求补写一个无法交付的结束记录，不递归向坏 pipe 写错误。

保持既有退出优先级：执行/持久/关闭等 failure=1，高于 EPIPE=141；随后按真实状态处理 interrupted=143、waiting=3、用户取消=130。拒绝审批可为工具失败结果后模型完成、进程 0；不能统一要求拒绝必然 Query failed 或退出 1。

## 6. 实施依赖、文件与验证

E1 观察基本矩阵可与 D 的同进程工作并行；E1-6 与 E2 错误结算以 D0/D2 的 release/确认未知语义固定为前置，不能两边分别改错误规则。

| 顺序 | 落点 | 交付 |
| --- | --- | --- |
| E0 | 既有 lifecycle/session-host/CLI integration 与本文 | 核对已有行为证据、当前入口与默认审批，不重写 B/C 成功路径 |
| E1 | `tests/general-agent-lifecycle.test.ts`、`tests/general-agent-session-host.test.ts` | 公开句柄有限流、消费门闩、交错、退订与单消费者/next 竞争；不扩大白盒导入 |
| E2 | `tests/general-agent-development-cli.integration.test.ts`、`tests/mimo-development-cli.integration.test.ts`、现有 node-cli fixtures；必要时现有 cli-terminal-controller 测试 | 增强持久断言、原配置对照及真实输出结算，复用 D 故障夹具 |
| 消费与烟测 | `scripts/verify-harness-package.mjs`、实际生产/开发 Node CLI | 原生包公开消费与真实入口、真实临时工作区，审批/EOF/恢复结果和租约同验 |
| 收口 | 本文、D 文档、M3 总计划、目录、整体路线 | 逐编号证据与限制，只有 A–E 全部满足才标记 M3 完成，再单列 M4/PPT 切片 |

实现前运行相关既有基线；新增测试验证行为/边界而非源码文本或文件数量，发现缺陷先失败回归再修最小实现。不得仅为证明慢消费加容量阈值/生产遥测，或用永久测试锁定“当前数组如何裁剪”。

待实施门禁：

```text
npm.cmd run build:cli
npx.cmd vitest run tests/general-agent-lifecycle.test.ts tests/general-agent-session-host.test.ts tests/general-agent-runtime.test.ts tests/cli-terminal-controller.test.ts tests/cli-terminal-rendering.test.ts
npm.cmd run test:integration:harness
node scripts/verify-harness-package.mjs
node scripts/verify-tools-package.mjs
npm.cmd run typecheck
npx.cmd biome check <本次修改的受支持文件>
npm.cmd test
npm.cmd run agent -- --help
```

真实烟测至少无业务插件对话、随机文件读取、写审批前后、EOF 原 waiting/新进程恢复、拒绝/取消、绑定变化拒绝与原配置恢复；每个 Query 检查 status/history/checkpoint/lease，不能凭退出码 0 推导 completed。SDK 本地 HTTP 与受控模型分层报告，不新增远程请求。

若修改终端输入/渲染/模式恢复，补实际 ConPTY 或对应平台 TTY 操作验证；当前 pipe/伪造 isTTY 的集成不能替代键盘/resize/shell 恢复。若仅补观察/持久行为断言，不重复已验收 CLI 的全套视觉与安装器，不引用历史真实 TTY 证据冒充本轮新结果。

完成门槛：E1 六组覆盖，E2 复用组的新增持久断言及实际入口通过；D 的失败不被观察/CLI 结算掩盖；有限序列有序、四段身份正确、持久历史不取自展示；包消费、类型/边界、静态、全量与集成通过，条件跳过和平台限制明确，临时资源全部清理。容量、沙箱、HA、第二后端与业务迁移仍不纳入完成声明。

## 7. 本次方案制定证据

以下为方案制定阶段的历史记录；“未实施”等表述不代表第 8 节的当前状态。

- 已阅读公开事件契约、实际 event-stream/default-agent、CLI writer/controller、两项集成及包消费；已查询并读取上列官方资料。
- 一次性原生 Node v24.20.0、公开 Application + 真实 SQLite：消费至少一条事件后 return，再放行模型；Run completed，iterator 后续 done，权威历史仅保存最终 assistant 而非临时 delta，租约可重新取得并释放。该探针没有证明所有 E1 场景。
- D 的一次性程序已实测 acquire 丢确认与 release 错误覆盖，详见 D 文档；E1-6 必须复用其后续回归，不能依据终态 fact 抹掉失败。
- 本次没有新增永久测试或改生产行为，没有运行 E1/E2 新矩阵、全仓门禁、实际 EPIPE/TTY 或远程模型；旧集成/ConPTY/厂商记录只作历史定位。临时程序与隔离数据库已清理并确认脚本目录不存在，不保留永久验收脚手架。

## 8. 本轮实施与验收记录

### E0 与 D 证据复用

- 修改前基线：lifecycle/session-host/runtime/cli-terminal-controller/cli-terminal-rendering 共 5 文件、144 项通过；两个实际 Node CLI integration 文件、8 项通过。
- E1-6 原位增强 `general-agent-runtime.test.ts` 的 D release 六分支：拒绝的 completed 落定后排空事件，成功执行分支仍有一个 run.completed，持久失败/围栏分支没有伪造 run.failed；所有事件完整 identity 与所属 handle 一致。六分支通过，原 owner/generation/checkpoint/history 断言保留。
- `verify-harness-package.mjs` 的仓库外原生消费者改为先等待 completed，再读取有限事件队列，核对完整四段 identity 与唯一终态 fact；Core/tools 两个包消费脚本通过。此处存储仍为内存端口，不冒充 SQLite 持久恢复。
- 本轮一次性原生 Node v24.20.0、公开 Application/真实 SQLite：读到 run.started 与第一条 delta 后 return，signal 未取消、旧 iterator 后续 done、不能再次 claim；放行模型后 Query completed。第二个 Query 无观察也 completed，旧 handle.cancel 不影响新 signal；事后 drain 保留两条临时 delta 和终态事实。历史 revision=4，只保存两个权威 assistant（与 delta 拼接刻意不同），checkpoint 与历史一致且租约可正常取得/释放。脚本与隔离目录已删除。

### E1：公开观察矩阵

| 编号 | 本轮落点 | 已观察结果 |
| --- | --- | --- |
| E1-1 | `general-agent-session-host.test.ts` | 不 claim events 也能完成/释放；事后完整 drain 保留三条具名 delta、有序模型事实与唯一终态，最终 done；SQLite 仅含权威完成响应 |
| E1-2 | 同上 | 消费者读第一条 delta 后停在自己的 gate；放行模型后，消费者仍暂停但 completed、历史/checkpoint 与 lease 已完成，恢复消费后顺序完整 |
| E1-3 | `general-agent-lifecycle.test.ts` | 部分读取后 return 不 abort，规范提交正常；iterator 不可再次 claim，旧 handle.cancel 不干扰下一 gated Run |
| E1-4 | `general-agent-session-host.test.ts` | 两个独立四段 identity 共享同一组端口，实际 A.next→B.next→B.next→A.next；B 先完成时 A 仍 busy，随后历史/租约各自正确 |
| E1-5 | `general-agent-lifecycle.test.ts` | 已排队的两个 next 均可读取；队列排空且一个 next pending 后，第二个明确 busy，不抢首个事件；return/close 后仍 consumed |
| E1-6 | runtime 的既有 D 矩阵 | 复用上节六分支及真实 SQLite owner/state，不以终态 fact 覆盖 completed 拒绝 |

上述两个公开测试文件及 runtime 集中运行 3 文件、107 项通过。原私有 RuntimeEventStream 测试已替换为公开句柄/SQLite 验证，并删除对应精确白盒豁免，没有扩大私有导入。已有恢复用例同时核对当前 event.identity 与原 tool invocation.identity，避免把恢复 Run 覆盖为原派发 Run 或反之。

### E2：实际 CLI、慢输出与错误结算

- 两个既有 CLI integration 文件原位增强，8 项通过：父进程以独立只读 SQLite 连接核对完整 identity、history/checkpoint/revision、稳定 batch、调用结果有序配对、pending 和 owner；原生 SDK 只访问本地 HTTP/SSE。
- EOF 等待与写审批：批准前目标文件不存在；重启后保留 agent/thread/query，使用新 Run 消费原 interaction，真实 create 写入内容与规范历史一致。终态再次恢复拒绝，不增加模型调用/历史。
- 错误 interaction 保持原 waiting/pending 且不调用模型；匹配拒绝/取消仅消费一次，分别核对 completed/cancelled 与 owner 释放、无写影响。原 applied 的影响保留继续复用 D 的独立 sync ledger 矩阵。
- 改变的是 `gateway.maxOutputTokens`：拒绝前后 binding/checkpoint/history 完全不变；还原 1024 后仍可批准原 interaction 并完成真实写入，不误称修改 maxSteps。
- E2-5 在现有 node-cli-entry 增加 slow-output 模式：包装真实 createNodeHost.run，只观察原 handle.completed；受控 Writable 在 run.started 的 callback 暂停。子进程确认真实 Query/checkpoint completed、lease 释放，但 CLI 未落定且 callback 仍 pending；显式 flush 后输出完整、identity 正确并退出 0。
- E2-6 三层分开：既有真实子进程断管退出 141，父进程核对 SQLite 为 completed 或 interrupted 且 owner 空；D/E1-6 承担真实 release/双失败；runCli/createHost 注入承担 completed 拒绝、后续 Host.close 拒绝及 EPIPE 优先级。前者不输出 assistant/query 成功，后者可输出真实 Query 成功但 process.finished 为 failure/1；纯 EPIPE=141，叠加执行/关闭失败=1。坏管道无法交付结束记录时不强求补写。
- `cli-terminal-controller.test.ts` 定点 18 项通过，包括真实慢 Writable 子进程场景。首轮修正慢输出夹具的错误顺序预期（实际 run.started→输入 step.committed→模型 step.started），未改变 Core。
- 仓库期间已有模型选择 UI 变化：移除旧 description 文案锁定；目录失败仍保留配置选择时，测试显式退出后再核对草稿/绑定。没有改动该生产 UI 逻辑，不把原有受控 isTTY 场景冒称本轮 ConPTY 验收。

### 集中门禁、真实入口与完成边界

| 命令/场景 | 本轮结果 |
| --- | --- |
| `npm.cmd run build:cli` | 通过；构建与后续消费顺序执行 |
| `npm.cmd run typecheck` | Harness/logs/models/tools/CLI+configuration 边界及 node/web/CLI 编译通过 |
| `npm.cmd test` | 205 文件、1930 项通过，3 项既有平台条件跳过；全仓总数包含同期工作区内容，不全算作 E 新增 |
| `npm.cmd run test:integration:harness` | 3 文件、62 项通过，无跳过；包含 D 的 54 个 reliability 场景与增强后的 8 个 CLI 场景 |
| Core/tools 包消费脚本 | 仓库外 tarball、声明与原生运行通过；Core 新增 postCompletionDrain/fullEventIdentity 结果为 true |
| `npx.cmd biome check` | 本次修改的 10 个受支持代码/脚本文件最终通过，无警告；保留共享文件的并发修改 |
| 合并后 controller 定点回归 | 1 文件、28 项通过，包含真实慢输出子进程与同期已有 UI 场景；不将全部项数归为 E 新增 |
| `agent -- --help` / `agent:dev -- --help` | 两个实际启动路径通过；不以 help 代替行为验收 |
| 生产 `cli/dist/main.js` 与开发 `scripts/run-agent.mjs` | 一次性原生探针各执行一次无插件真实 SDK→本地 SSE 对话；Query completed，history revision=2、user→assistant、checkpoint 与历史一致、owner 空，精确校验随机回答 |

实际入口探针复用现有 seed/DPAPI 配置，运行于自建临时工作区和隔离数据目录，只把模型固定 endpoint 的 transport 重定向至本地服务，共两次本地模型请求、零远程调用；未新增配置副本或替代执行器。探针初始 Windows preload 使用普通路径导致启动失败，改为 file URL 后两入口通过；本地 SSE 采用已有夹具的完整事件帧。一次性脚本、preload 与隔离目录均已删除，开发入口自行清理本次临时 emit。

3 项跳过为 Windows 下的两个 symlink 场景与非 Windows 凭据不支持场景，不新增跳过。E2-5 的真实慢 Writable 位于 controller 测试文件并已由全量单测实际执行；不把 3 文件 integration 命令误称包含该文件。

本轮只扩展验收、包消费与精确边界门禁，不更改生产 Core/CLI 的执行协议、持久格式、审批策略、终端输入或渲染实现。未运行新的 ConPTY/真实键盘/resize/shell 恢复验收，也不引用历史 TTY 成功作为新增证据；并发工作区已有 UI 修改保持原样。

不承诺事件容量有界、任意 Windows 同步管道阻塞下仍能推进、沙箱、HA、第二后端、自动接管或外部副作用 exactly-once。D 的真实存储故障、CLI 的拒绝/关闭优先级与实际 EPIPE 分层报告，不冒称无法注入的完整宿主 release 故障已经运行。

完成结论：E1 六组与 E2 六组均有上述实际行为证据，D 的失败语义未被观察或 CLI 结算覆盖；本轮集中门禁通过，临时资源已清理。结合 A/B/C/D 的各自验收记录，M3 计划范围完成；下一阶段按具体宿主需求单列 M4，不能把 PPT 或旧生产入口自动视为已经迁移。
