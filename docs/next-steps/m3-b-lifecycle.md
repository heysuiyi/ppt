# M3-B：执行隔离、单实例准入与关闭排空

[返回计划目录](README.md) · [M3 总计划](m3-reliability.md) · [前一步 M3-A](m3-a-composition.md)

状态：方案已制定，新增永久回归与运行时修复待实施。M3-A 已通过后续独立复核；本步承接 B1/B2，不将 A 的组合验收或本次既有基线通过计作 B 的新增完成证据。

## 1. 目标与不变边界

验证**共享宿主端口下的多 Agent 隔离、同一实例竞争拒绝、关闭期间的在途排空和错误保留**。这是现有异步执行模型的可靠性工作，不增加并行调度。

- 同一 Agent 的 run/resume 共用一个活动槽；竞争明确拒绝，不排队、不自动重试。槽位覆盖取得句柄前和 Run 清理期间。
- 同一 Application 内可以同时激活不同 Agent；本步使用不同 agentId、不同 Thread/Query，共享同一模型工厂、历史、检查点和授权端口。它们不是共享模型 binding 或共享取消信号。
- waiting 结束 Run 并释放活动槽；后续恢复仍使用原 Query、新 Run。槽位释放不等于允许新 Query 越过同一 Thread 的待决工作。
- Application.close 停止新创建，并关闭各 Agent；Agent.dispose 停止自身激活；SessionHost.close 同步停止自身受理。它们拥有的对象不同，不能把“关闭 Agent A”写成“关闭整个 Application 后 B 仍执行”。
- ModelBinding、插件资源在 Agent 层；Run 的取消信号、临时资源和租约在激活层。Run handle.completed 等待执行及 Run 清理，不代表长寿命 Agent 的 binding/plugin 已释放；Agent/Host/Application 的关闭承诺才覆盖各自自有资源。
- 不改变 Query/Run/Step、审批、HostSessionBinding v2、检查点 v1、插件版本或数据库格式，不增加 exports、测试钩子、全局锁、线程池、隐式队列或默认超时。

C1/C2 的跨进程竞争与 Thread 原子准入、C3 的版本兼容、D 的崩溃/副作用恢复、E 的观察容量均不属于本步。尤其不能以本步的 agent-busy 证明 Thread 级跨进程安全。

## 2. 前置结论与代码依据

M3-A 后续独立复核已实际通过：四文件 78 项通过、1 项既有跳过；全仓 typecheck 及三包边界通过；全量 193 文件、1648 项通过、2 项既有跳过；原生 Node 双插件、真实 SQLite/receipt、冲突回滚和 ID 重用通过。原 A 实施时的 models 迁移失败保留为历史，不再作为当前阻塞；详见 [A 的复核记录](m3-a-composition.md#10-后续独立复核与完成结论)。这些是前置证据，不是 B 新场景的实测结果。

| 落点 | 当前实现/已有断言 | 本步缺口 |
| --- | --- | --- |
| `packages/harness/src/agent/runtime/default-agent.ts` | activate 在异步边界前占槽；完成 Run scope 清理后释放槽；dispose 设置 closing/interrupted 并中止激活 | 多 Agent 同时在途、resume/resume 竞争、已持久终态但租约未释放时仍占槽 |
| `packages/harness/src/agent/runtime/run-controller.ts` | 执行结束 finally 释放租约；取消分类时看 isInterrupted；已保存 waiting 不被关闭覆盖 | 两种取消/关闭交错、终态已提交与完成承诺之间的精确边界 |
| `packages/harness/src/agent/application/agent-application.ts` | 创建占位、关闭取消未发布创建并等待落定；普通创建取消不算关闭失败，清理聚合失败需报告 | 迟到 binding 清理失败不能被当成普通取消吞掉 |
| `packages/harness/src/agent/application/default-agent-factory.ts`、`model/model-registry.ts` | 创建按安装→绑定→seal→发布；取消后迟到 binding 由创建链释放 | 已确认迟到 binding 的 dispose 异常丢失，见第 3 节 |
| `packages/harness/src/agent-host/session-host.ts` | binding.ensure 完成前不发布 Host；关闭先拒绝 run/resume，再由 Application 排空；借用服务不归 Host | 活动工具排空、慢 disposer 与 Host.close 完成边界 |
| `tests/general-agent-lifecycle.test.ts` | 已覆盖 run/run、run/resume、普通用户取消、模型中断、lease release 门闩、创建 ID、迟到 binding、setup 重入 close、A2 回收异常 | 不重写上述用例；局部补缺失交错，原 fixture 的共享 binding 不可用来证明独立绑定 |
| `tests/general-agent-session-host.test.ts` | 已有真实 SQLite、A 的逐次 binding、receipt、等待恢复、Host 关闭拒绝及模型排空 | 在同一 Application 中同时运行两 Agent；活动工具与真实存储提交/释放边界 |

## 3. 已复现缺陷：迟到 binding 回收失败被取消掩盖

本次用一次性原生 Node 程序复现，使用公开 createAgentApplication、真实 SQLite、受控 ModelClientFactory：

1. create 进入模型工厂，工厂以 entered/release 门闩暂不返回 binding。
2. 调用 Application.close，创建信号被中止；此时先登记 create/close 的拒绝观察。
3. 工厂迟到返回 binding，分别让其 dispose 正常完成或抛出已知 cleanupError。
4. 两种情况都没有模型生成，dispose 都仅调用一次，借用历史仍可读。

| 受控条件 | create 结果 | close 结果 | cleanupError 是否保留 |
| --- | --- | --- | --- |
| dispose 正常 | 拒绝创建 | 成功完成 | 不适用 |
| dispose 抛错 | 拒绝创建 | **仍成功完成** | **create/close 均未保留** |

原因链已核对：ModelRegistry.create 的取消分支在 try 中 await binding.dispose，却在 finally 中 signal.throwIfAborted；finally 的取消异常覆盖清理异常。Application.close 随后将该创建拒绝当作普通取消，不报告绑定资源未能释放。

### 3.1 最小修复设计

- 在 `model/model-registry.ts` 的迟到回收分支，区分“回收成功后抛取消”与“回收失败”。成功保持既有取消行为；失败将原取消原因与 cleanupError 一并保留为内部 AggregateError，不导出新错误类型、不改变公共签名。
- 核对 `application/default-agent-factory.ts` 中 binding 已返回但尚未托管时的同类取消回收分支，采用一致的错误保留规则；不能让原始清理异常被 Application 的“预期创建取消”过滤掉。只处理这两个真实所有权交接点，不把所有创建失败无差别包装成新协议。
- 同一 binding 只能选择一个回收所有者：ModelRegistry 已回收并拒绝时，外层没有取得 binding，不能再次释放；交付给默认工厂后则由外层取消分支或 Agent scope 二选一接管。
- 不新增重试、不强制声称资源已关闭、不抹掉普通取消语义；所有后续资源仍尝试清理。对外继续使用 asProtocolError 安全投影，不打印原始取消原因、SDK 异常或清理堆栈。
- 通过公开 create/close 回归先失败后通过；断言已知 Error 对象在错误链中，不锁定 AggregateError 嵌套层数或文案。精确到交付边界的补充交错必须由公开 Promise/信号固定，不为覆盖内部指令增加钩子、私有导入或源码断言。

本次只复现并制定修复方案，尚未修改上述实现。该问题是 B 的阻塞项，不回溯否定已验收的 A1/A2 场景。

## 4. 夹具及观察协议

新增夹具仅为现有测试文件的私有函数/具名记录，不建立 Scheduler、EventLoop 或通用并发测试框架。

### 4.1 逐绑定模型记录

- 每次 ModelClientFactory.create 返回独立 binding、released 状态、dispose 记录、模型 entered/continue 门闩及实际请求记录，不沿用 lifecycle 原 fixture 的同一个 binding。
- 测试顺序 await 创建 A、B，明确记录两次绑定归属，然后同时激活；不靠可变“当前 Agent”全局变量路由执行。需要关联时使用公开 ModelCallContext.identity，只作测试观察，不写入模型消息或重放状态。
- 模型只在自己门闩上暂停；取消后暂不退出，直到测试释放门闩才检查 signal 并结束，以证明 close 确实等待在途工作。最终答复必须来自真实工具读取结果，不按 generate 次数预置成功。
- 使用一个共享插件对象安装两次；setup 内取得本次安装记录、独立 scope signal 和闭包，不把安装态放在共享对象的 current 字段。

### 4.2 真实只读 probe 能力

在现有 session-host fixture.directory 内生成两个内容不同的随机 nonce 文件；每次安装绑定自己的固定文件窄端口，注册同名 `probe.read`，输入为空对象、输出为严格 `{ nonce: string }`。execute 通过 Node 读取本安装文件，检查 signal 和资源仍打开；路径不由模型输入指定，不另造生产文件工具的安全规则。

B1 让 A/B 同时停在各自首轮模型请求，关闭 A 并确认只有 A 的信号/资源受影响。A 排空并关闭后再释放 B，B 通过自己的 probe 取得实际 nonce 并完成；核验请求、工具、事件、历史和 checkpoint 的身份不串用。资源计数须与实际 released 状态结合。

B2 的活动工具使用独立 entered/continue 门闩暂停同类只读 probe；不在工具里追加副作用，不把本步扩成 applied/unknown 的恢复验收。scope signal 可以先中止；**中止信号不等于 disposer 已执行或底层资源已关闭**。

### 4.3 租约与清理门闩

- 生命周期的槽位测试复用现有 hooks.beforeRelease；真实 SQLite 场景用公开 CheckpointStore 包装器委托原实现，仅对指定 agent/thread/query/run 的 release 暂停。
- 包装 save 时，先等待真实 save 返回 saved，才记录“该状态已提交”；这利用存储公开持久承诺，不用事件文本猜提交。记录后不阻塞 save 返回，终态后的暂停统一放在 release。
- inspector 等后续 acquire/release 必须绕开目标 Run 门闩，门闩只生效一次，避免测试自己持有检查租约造成死锁。
- 单独阻塞 binding.dispose 的完成，证明 Run completed 与 Agent/Host close 是不同完成边界；不能仅用 dispose spy 被调用证明资源已释放。
- 事件从各 handle 自己的 events 读取，检查所属 Run 身份即可；不规定跨 handle 的全局顺序，不新增慢观察/容量策略，E1 仍另行验收。

## 5. 验收场景

| 编号 | 确定性交错 | 必须观察的结果 |
| --- | --- | --- |
| B0 | 复用 lifecycle/session-host/runtime/infrastructure 基线及 A 的已有回归 | 已有 run/run、run/resume、用户取消、模型关闭、创建回滚不重复造测试；新增场景单独登记，C–E 不随基线通过而完成 |
| B1-1 | 同一 Application、相同借用服务、同一插件对象；不同 Agent/Thread 同时进入独立模型门闩；dispose A，排空 A 后才继续 B | A 为 interrupted；仅 A 的激活/安装信号中止、binding/插件资源释放各一次；B 信号与资源仍有效，实际读取自己的 nonce 后 completed；请求/工具/事件/历史不串身份；两边租约释放，共享端口仍可用 |
| B1-2 | 先取得真实 waiting；启动第一个 resume，在其句柄返回前立即发第二个 resume，并在在途期间再尝试激活 | 第二个 resume 为 agent-busy，不另取租约、不消费回答、不进入工具/模型；第一个使用原 Query/新 Run 完成。run/run、run/resume 的既有断言继续复用，不增加隐式排队 |
| B1-3 | 正常 Run 已提交终态，但 release 门闩未放行；再尝试同实例 run/resume | 两者仍 agent-busy，completed 尚未落定；放行 release 后才解除槽位；下一次合法 Query 可运行。若前态为 waiting，下一次合法操作是恢复原 Query，不允许以新 Query 绕过 Thread 待决 |
| B2-1 | 工具 entered 后发起 Host.close；保持工具门闩，再保持目标 lease release 门闩，最后保持 binding.dispose 门闩 | 关闭开始即拒绝新的 run/resume；工具未退出时 binding/插件底层资源不关闭；release 完成前 Run completed 不落定；Run 结束后 close 仍等待慢 binding disposer；放行后自有资源成功关闭且各一次、借用历史可读。不要断言 binding 与插件之间无关的内部回收顺序 |
| B2-2 | 模型/工具尚未退出，分别安排 cancel→close、close→cancel，再释放执行门闩 | 两种交错均不重新执行或重复清理；在终态尚未选择且关闭已生效的窗口，当前实现待验证预期为 interrupted，而非“首个信号获胜”；检查公开结果、最终 checkpoint 与租约，不锁定取消原因文案 |
| B2-3 | 参数化 completed/cancelled/waiting 已被 save 确认，但 release 尚未完成；此时 close，并调用旧 handle.cancel | 已提交状态不被关闭重写，结果与最终 checkpoint 一致；close 等租约及资源清理。waiting 后可在新实例/新 Run 恢复原 Query；completed/cancelled 不作为续跑入口。旧激活的取消信号或旧 handle 不能取消后续 Run |
| B2-4 | 模型工厂在 close 后迟到返回 binding；分别让 dispose 延迟成功或抛已知 cleanupError | 先保留失败回归，再按第 3 节修复；迟到 binding 只释放一次、绝不发布 Agent或执行模型；成功回收保持普通创建取消，close 等 disposer；失败回收在 create/close 错误链均可见，不伪称资源已释放，其它清理继续、共享端口不误关 |

B2-2/B2-3 对终态语义的区分是本步的关键：**信号发生、终态提交、租约释放、Run 完成、Agent 关闭不是同一个时刻**。新增交错在实施后才算验收；本次没有运行这些新增场景，不将静态预期写成已证明事实。

## 6. 实施顺序与文件落点

| 顺序 | 落点 | 动作 |
| --- | --- | --- |
| 1 | `tests/general-agent-lifecycle.test.ts` | 先加入 B2-4 的公开迟到 binding 失败回归，观察修复前丢失 cleanupError；保留正常取消对照及慢 dispose 门闩 |
| 2 | `packages/harness/src/agent/model/model-registry.ts`、`application/default-agent-factory.ts` 对应所有权交接分支 | 实施第 3 节最小修复；不改接口、版本、Application 全局受理策略或其它失败分类。若修复超出本范围，先补具体设计而非顺带重构 |
| 3 | `tests/general-agent-session-host.test.ts` | 复用真实 SQLite fixture，在公开 Application 下完成 B1-1；复用 Host 入口完成 B2-1/2/3；局部私有 binding/probe 夹具，不抽共享框架 |
| 4 | `tests/general-agent-lifecycle.test.ts` | 补 B1-2/3，复用真实 waiting 流程及 release 钩子；需要不同绑定时局部替换 bind，不全局重写既有夹具；A2-4 和迟到绑定正向用例继续复用 |
| 5 | 现有 runtime/host 回归、两个 CLI integration、Core 包消费者 | 执行修复相关回归及全仓门禁；本步动到运行时，必须跑实际入口，不以单测或帮助代替 |
| 6 | 一次性原生 Node 消费程序 | Core 原生解析公开包产物，只编译 SQLite 适配/夹具；实际证明同时在途、关闭 A 后 B 读取真实结果、活动工具排空与迟到 binding 错误保留。无需 Vitest、私有导入或源码 alias，结束清理 |
| 7 | 本文、M3 总计划、计划目录 | 按编号记录实际新增/复用证据、失败前后和限制；仅在完成门槛通过后将 B 标完成，C–E 保持独立 |

测试只使用公开 Application/SessionHost、plugin/model/tool/session 协议及当前宿主 SQLite 适配。不得扩大 white-box 例外；内部实现修复前先核对引用与现有错误消费语义。没有导出协议变化时不引入兼容层或版本迁移。

finally 顺序固定为：解除本次门闩 → 等待已启动 create/run/close 的观察承诺落定 → 关闭 Application/Host → 关闭测试拥有的存储 → 移除临时目录。对可能拒绝的承诺在触发关闭前登记观察；超时只作测试失败保护，不用 sleep、随机压力、强杀进程或强制提前 dispose 冒充安全排空。

## 7. 实施后的检查与完成门槛

以下是实施后的清单，不是本次已通过的 B 新场景记录：

```text
npm.cmd run build:packages
npx.cmd vitest run tests/general-agent-lifecycle.test.ts tests/general-agent-session-host.test.ts tests/general-agent-runtime.test.ts tests/general-agent-infrastructure.test.ts tests/general-agent-host.test.ts tests/general-agent-host-binding.test.ts tests/general-agent-development-host.test.ts
npm.cmd run typecheck
npx.cmd biome check packages/harness/src/agent/model/model-registry.ts packages/harness/src/agent/application/default-agent-factory.ts tests/general-agent-lifecycle.test.ts tests/general-agent-session-host.test.ts
npm.cmd run test:integration:harness
npm.cmd run verify:harness-package
npm.cmd test
```

只检查实际修改的受支持文件；若修复触及其它代码，补对应静态检查。模型使用受控实现或现有 SDK 到本地 HTTP/SSE，不调用远程厂商。包 exports/声明及发行机制未变，不重复 ASAR/安装器验收；CLI 集成与一次性 Node 程序分别证明真实入口和新增竞态路径，不能互相替代。

完成门槛：

1. B0/B1/B2 每个编号有可定位行为证据；迟到 binding 丢失清理错误的回归修复前失败、修复后通过，无“普通取消”掩盖清理失败。
2. 同实例拒绝和多实例独立执行同时成立；共享服务存活、逐安装/逐 binding/逐 Run 的资源与取消归属被实际核验，不以 dispose 计数代替真实资源状态。
3. 在途工具、租约释放与慢 disposer 的各完成边界均有门闩证据；结果、checkpoint 与已确定的提交状态一致，关闭不因观察者速度而推进或中止。
4. 新增原生消费、实际 CLI 集成、类型/边界、静态和全量回归均通过；条件跳过与未运行场景明确记录，已知失败不能通过改预期、吞异常或缩小测试范围掩盖。
5. 临时程序、进程、隔离数据库及 nonce 文件清理；生产数据、独立 models 迁移及旧 Agent/PPT 链路不动。
6. 不声称 C2、跨进程副作用恢复、吞吐/容量、恶意插件隔离或外部操作恰好一次已完成；不承诺对不合作工具有固定关闭时限。

## 8. 本次方案制定证据

本次仅设计、运行既有基线及复现第 3 节缺陷；没有新增永久测试或修改运行时。新增 B 场景、最小修复及实施后的 CLI/全仓门禁均待执行。

- 三个 workspace 构建通过；lifecycle/session-host/runtime/infrastructure 四文件共 64 项通过，无跳过。
- `npm.cmd run verify:harness-package` 通过当前 Core 的真实 tarball 离线安装、NodeNext/Bundler 声明消费、原生对话/审批恢复及旧别名拒绝。其存储夹具为内存，不能作为 B 多 Agent 隔离或跨进程恢复的新证据。
- 原生 Node + 真实 SQLite 的迟到 binding 探针：正常和抛错回收各 dispose 一次、模型生成均零次；抛错组 create/close 均未保留 cleanupError，close 仍成功。它是问题复现，不是通过验收。
- 本次不重复运行上次已通过的全仓门禁，不把上次 193 文件/1648 项通过和原生 A 组合当成 B 已完成；也没有运行新增 B 全场景、CLI 集成、远程厂商或 ASAR。
- 迟到 binding 探针、编译适配与两份隔离 SQLite 数据库已清理；没有修改生产配置、共享库、永久测试或运行时源码。
