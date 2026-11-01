# M3-A：公开能力组合与安装原子性

[返回计划目录](README.md) · [M3 总计划](m3-reliability.md) · [项目整体规划](../project-plan.md)

状态：M3-A 已通过后续独立复核并验收完成，见第 10 节。第 9 节保留原实施阶段的通过、失败和并行改动记录，不覆盖历史失败；B–E 不由 A 的完成自动获得验收。

## 1. 目标与范围

通过 `@agent-harness/core` 的公开入口证明：能力由显式插件组合形成；全部安装并绑定成功后才发布 Agent；安装冲突、失败或创建取消不会发布半初始化实例、误关共享服务或吞掉清理失败。

这里的“安装原子性”是**发布与所有权边界**，不是任意插件代码的数据库事务或外部副作用回滚。setup 只安装贡献与取得资源；不能调用模型或执行工具来准备测试，也不能声称一个抛错的 disposer 已成功释放资源。

本步交付：

- 登记 M3 A–E 的既有覆盖与未覆盖项，运行相关基线；后续组保持待执行。
- A1：无插件/文件能力复用已有验收；新增两个独立插件组合的真实执行、提示词顺序、模型路由和宿主拒绝场景。
- A2：三类跨插件注册冲突、后续 setup 失败、创建取消与回收失败的公开行为。
- 原生 Node 实际运行新增组合路径，检查权威历史、真实文件及资源所有权，而非只报告 Vitest 通过。

不改变公开协议、包 exports、资源树、注册表、默认装配或现有版本。只有失败回归证明实现违背既有契约，才修最小缺陷并迁移受影响调用方。不引入插件依赖解析、热装卸、全局容器、并行工具、新业务插件、厂商调用或生产迁移。

## 2. 已核对的实现与可复用覆盖

下列为源码和断言核对，不代替本步实际运行记录。

| 代码/测试落点 | 当前事实 | 本步处理 |
| --- | --- | --- |
| `packages/harness/src/agent/application/default-agent-factory.ts` | 逐 Agent 创建模型/工具/提示词注册表；先 installPlugins，后绑定模型、seal、发布；异常回收并释放创建 ID | 沿用实现，经公开 create/run/resume 验证，不直接构造 DefaultAgent |
| `packages/harness/src/agent/extensions/plugin-manager.ts` | 先检查重复 plugin ID；顺序 setup；每次安装提供窄 scope，注册句柄自动归属该 scope；失败回收整次安装 | 冲突夹具使用不同 plugin ID，避免只测到重复插件预检查 |
| `packages/harness/src/agent/model/model-registry.ts` | 显式 provider 路由优先于宿主 fallback；注册表不拥有借用工厂，Agent 拥有已取得 binding | 注册插件间相同 providerId 才是冲突；不能把宿主 fallback 与插件同名路由当作冲突 |
| `packages/harness/src/agent/extensions/prompt-registry.ts` | 贡献按注册顺序串行 render；run-controller 合成基础指令和贡献 | 使用夹具自有标记验证先后，不钉住产品提示词文案、分隔空白或序列化格式 |
| `packages/harness/src/agent/application/agent-application.ts` | 同步占用创建 ID；失败后移除；close 取消未发布创建并等待落定，不能吞掉 AggregateError 代表的回收失败 | 重点补“取消与回收失败”两种来源，不将普通取消视为关闭错误 |
| `tests/general-agent-lifecycle.test.ts` | 已覆盖创建 ID 占位及失败复用、迟到 binding、setup 重入 close、单安装资源归属 | 复用已有用例；补有失败 disposer 的取消组合，不复制整套资源树测试 |
| `tests/general-agent-infrastructure.test.ts` | 已有重复注册、seal、提示词顺序、重复插件预检查和逆序回滚白盒断言 | 保留；新增场景不导入其内部实现或扩大白盒豁免 |
| `tests/general-agent-session-host.test.ts` | 公开 SessionHost 已覆盖无插件对话、未安装工具拒绝、真实 SQLite、普通 ledger 审批恢复、setup/cleanup 错误保留 | 复用该文件的临时目录、SQLite、清理和规范结果读取；新增组合不是再复制一套无插件/单 ledger 测试 |
| `tests/base-tools.test.ts`、`scripts/verify-harness-package.mjs` | 已有真实文件能力及仓库外安装消费；包消费者的存储是内存夹具 | 作为 A1 基线，不将其计为新增双插件组合或跨进程恢复证明 |

当前 lifecycle 夹具返回同一个 binding 对象。A 组的失败创建在模型绑定前停止，不用它证明多 Agent binding 隔离；B1 仍需逐次返回独立 binding 的专门场景。新增组合如需多个成功 Agent，模型工厂必须为每次 create 返回独立 binding 与 dispose 记录。

## 3. 使用入口与依赖所有权

新增永久测试只消费以下公开路径：

- `@agent-harness/core/application/agent-application`：Application 创建与关闭。
- `@agent-harness/core/session-host`：组合执行与固定 Thread。
- `@agent-harness/core/agent-contract`、`agent-factory`：创建、激活及服务类型。
- `@agent-harness/core/extensions/plugin-contract`、`model/model-contract`、`tools/tool-contract`：插件、模型、工具协议。
- `@agent-harness/core/protocol-values`、`protocol-errors`、`session/session-contract`、`session/checkpoint-contract`：结果、错误和持久端口。

复用当前宿主 SQLite 适配作为测试端口不等于把它移入内核。工作目录和凭据不进入 AgentServices；临时文件位置由能力工厂闭包固定，不接受模型任意指定路径。

| 对象 | 所有者 | 释放规则 |
| --- | --- | --- |
| 临时目录、SQLite、宿主 fallback 模型工厂 | 测试宿主 | Application 排空后由测试关闭；不随失败 Agent 或单个插件关闭 |
| 插件 A/B 安装资源、注册句柄 | 本次插件安装 scope | 创建失败回滚；成功则随所属 Agent 释放；不同安装不共享可变安装状态 |
| 每次模型 binding | Agent | 成功创建后归 scope；绑定迟到取消路径沿用原有回收机制 |
| 门闩、观察记录与执行凭据 | 单个测试/临时消费者 | 在 finally/现有测试清理中解除门闩、等待创建/关闭落定后清理，不遗留 pending Promise |

插件工厂可捕获一个借用端口，但不能因取得引用就将宿主共享工厂或存储交给 scope.own。dispose 次数只证明调用次数；成功释放还须用资源状态和关闭后借用服务仍可用来证明。

## 4. 两个独立能力夹具

只在现有测试文件内定义私有夹具，使用具名协议类型；不新增公开 API、通用测试容器或共享 fixture 包。

### 4.1 插件 A：受控模型与提示词贡献

- plugin ID 为 `acceptance-model`，version 为 `1`；注册 providerId `acceptance-model` 及一个独立 prompt ID。
- 创建参数显式选择 `{ providerId: "acceptance-model", modelId: "acceptance-model-v1" }`；不是只注册 A，却继续使用原 fixture 的 deterministic provider。成功后的请求、waiting 检查点和结果身份均按该选择核验。
- 工厂实现公开 ModelClientFactory；每次绑定独立 ModelBinding，保存本次请求和释放状态。宿主 fallback 是另一个可用的受控工厂，有单独调用记录；不能靠 fallback 的固定异常冒充路由验证。
- 模型首轮根据用户输入中的随机 nonce 发出 `receipt.append` 调用；看到规范 tool-result 后，成功路径解析实际 receipt，拒绝路径消费安全错误类别，再生成对应答复。不按第几次 generate 硬编码“成功”，没有结果时不能凭预置答案结束。
- 模型请求记录只留在隔离夹具中用于断言，不写诊断或终端。断言注册路由被实际使用、fallback 未代替它；创建阶段 generate/stream 和工具体均未进入。
- 插件只注册，不在 setup 启动模型。提示词内容是测试自有标记，分别验证基础指令、A/B 贡献的相对顺序。

### 4.2 插件 B：可恢复的真实 receipt 能力

- plugin ID 为 `acceptance-receipt`，version 为 `1`；贡献 `receipt.append` 工具和另一个 prompt ID。
- 工具 mode 为 resumable，version 为 `1`；输入严格 schema 为 `{ nonce: string }`，输出为 `{ nonce: string, receiptId: string }`。路径来自工厂闭包，不属于模型输入。
- execute 校验后返回 waiting，effects 为 none；interaction ID 由本 Query/call 身份生成，owner 为 `acceptance-receipt`，payload 为 `acceptance.receipt-confirm` v1；continuation 为 `acceptance.receipt` v1，data 保存 nonce。该等待是能力自身交互，不是宿主授权批准。
- resume 只接受匹配交互且 `response.type === "answer"`、`response.value === true` 的回答；再严格校验本工具 continuation 的 type/version/data，在临时文件追加一条含调用身份、nonce 和 receiptId 的执行凭据，写入完成后返回 succeeded/applied。非肯定回答返回明确失败且无写入，不提供假 resume 或空实现。
- toModelContent 从实际 ToolResult 投影 nonce/receiptId；失败投影使用安全错误类别。最终模型输出、规范工具结果和磁盘凭据三者必须一致，不仅检查文本“已完成”。
- A1 成功场景的宿主策略为 allow，因此只发生一次能力等待；宿主 deny 场景在进入 execute 前结束。既有 ledger 测试继续承担“宿主 approval → 批准/拒绝”的基线，避免把两种交互叠加后误判审批次数。

此能力是隔离验收夹具，不是生产领域模块，不声称其追加文件具有恰好一次、原子回滚或崩溃恢复保证；这些由 D 组另行验证。

## 5. 场景与精确断言

基线登记直接复用总计划 M3.3 的覆盖矩阵，不另建台账或测试框架。本步实际重跑 A 相关文件；未重跑的 B–E 项标为未重跑，既有断言与本次运行证据分开记录。

| 编号 | 场景与确定性交错 | 验收结果 |
| --- | --- | --- |
| A0 | 运行既有基线，按 M3 A–E 登记“已有断言/本轮实测/缺口” | 无插件、文件和单能力审批已有覆盖不重复新增；B–E 缺口不因基线通过而关闭 |
| A1-1 | 经公开 SessionHost 装配 `[A,B]`，执行含随机 nonce 的输入；run 返回能力 waiting，再用新 runId 回答恢复 | 创建阶段零模型生成/工具执行；选中 A 路由而非 fallback；只有已装工具；等待前磁盘无凭据；同 Query/新 Run，execute/resume 各一次，最终 completed；历史 callId/结果配对，磁盘恰一条凭据，模型消费同一 nonce/receiptId；检查点终态且可重新取得并释放租约 |
| A1-2 | 使用新 Thread、新安装，将顺序换成 `[B,A]`，执行相同业务语义但独立 nonce | 模型在全部插件安装后仍能绑定；基础指令不被覆盖，贡献顺序跟随注册顺序；不是只检查拼接函数，也不把同一 Thread 的换序当恢复兼容 |
| A1-3 | 同样的 `[A,B]`，宿主策略 deny `receipt.append` | 模型只能收到错误工具结果；execute/resume 均零次，无能力 waiting、无磁盘凭据；最终状态依模型按规范结果继续决定，不把工具拒绝强行等同整个 Query failed |
| A2-1 | 两个不同 plugin ID，分别参数化重复 providerId、tool name、prompt ID；第二插件先取得可观察资源再触发冲突 | create 拒绝；失败安装没有模型绑定/生成或工具执行；所有 disposer 最多一次，成功项确实释放；共享服务未关闭；失败 ID 可在同一仍开放 Application 中重新创建并真实运行；不检查私有 registry 大小或具体错误文案 |
| A2-2 | 第一插件安装成功；第二插件注册贡献并托管资源后抛出一个具名测试异常 | 不发布 Agent；回滚覆盖前两个插件且按取得资源的逆序；错误未被普通成功覆盖；失败安装保留的公开 context 不能再注册；失败 ID 可重新创建；另一健康 Agent 使用相同注册键仍可执行，证明注册不跨安装污染 |
| A2-3 | setup 进入门闩后，外部 creation signal 取消；至少一个 disposer 抛出已知 cleanupError，再解除 setup 门闩 | create 拒绝且 cleanupError 仍在失败链中；其它 disposer 继续执行；不能声称抛错资源已释放；无 binding/工具进入；Application 仍可创建同 ID 的新 Agent，共享端口可用；不钉住内部取消码或 AggregateError 的嵌套层数 |
| A2-4 | setup 进入门闩后调用 Application.close；disposer 抛错；观察关闭未完成，再解除 setup 门闩 | 新创建立即拒绝；close 等待未发布 setup 退出，create 和 close 都报告相应失败，close 不吞 cleanupError；所有 disposer 最多一次；共享服务不被接管；已关闭 Application 不要求 ID 可重用；重复 close 返回原完成承诺 |

A2-4 只覆盖“未发布创建 + 回滚失败”的 A2 边界；活动工具、用户 cancel/close 终态竞态、多 Agent 同时在途仍属于 B。A2 中另一健康 Agent 使用不同 Thread，失败前后对比自己的 binding、资源与实际输出，不借此宣称跨进程隔离。

错误保留断言采用已知 Error 对象身份和消费者可见结果；需要检查多错误时递归读取 AggregateError.errors，沿用既有测试模式，不锁定包装顺序、栈、路径或凭据。对外投影仍用 asProtocolError，不能把原始异常直接打印为证据。

## 6. 文件落点与实施顺序

| 顺序 | 落点 | 改动 |
| --- | --- | --- |
| 1 | 本文、M3 总计划的现有矩阵及各相关测试 | 记录基线与覆盖映射；使用当前 `@agent-harness/*` 构建产物，不沿用历史旧名或跳过包构建 |
| 2 | `tests/general-agent-session-host.test.ts` | 在原 fixture/清理约定上新增 A/B 私有夹具，完成 A1-1/2/3；复用真实 SQLite、既有 checkpoint 检查方式，不复制存储实现 |
| 3 | `tests/general-agent-lifecycle.test.ts` | 新增 A2-1/2/3/4；复用 Application 入口和现有具备 CAS/收据的端口夹具。需要多个成功绑定时局部替换 bind 为逐次独立实例，不全局重写 fixture 或顺带实施 B1 |
| 4 | 对应 application/extensions/model/scope 内部实现，仅在确有失败回归时 | 先复现违约再作最小修复；不通过吞异常、放宽重复注册、默认回退或禁用清理使测试变绿；公开符号若必须变化，先查引用并说明兼容影响 |
| 5 | 一次性原生 Node 消费程序 | 真实调用 createAgentApplication，装配 A/B 并运行 waiting→resume→completed，再覆盖一个注册冲突回滚；读取真实凭据文件，核验借用存储仍可用；只导入公开包入口，不调用 Vitest 或私有 Registry |
| 6 | 本文、M3 总计划、计划目录 | 写入实际结果、失败修复和限制；仅将 A 标为完成，B–E 仍按各自证据推进 |

不新建永久测试套件、不新增 package.json 命令，不改边界检查白名单。一次性 Node 消费可用现有 Vite 方式仅编译 SQLite 适配及夹具，Core 保持 external、运行时原生解析实际包产物；不 alias 到 Core 源码。它证明公开组合消费，不证明 tarball 新边界或进程崩溃恢复。

所有门闩用 Promise.withResolvers 和显式 entered/release 控制，不用 sleep 或随机压力猜竞态。对可能拒绝的 create/close 先登记错误观察，再触发取消；finally 解除本次创建的所有门闩，等待任务落定后关闭 Application、存储并移除临时目录，不留下未处理拒绝。

## 7. 实施后的验证与完成门槛

下列保留实施后的重跑清单；本轮实际运行结果与未通过项见第 9.3 节，不能把命令清单当作通过记录：

```text
npm.cmd run build:packages
npx.cmd vitest run tests/general-agent-lifecycle.test.ts tests/general-agent-infrastructure.test.ts tests/general-agent-session-host.test.ts tests/base-tools.test.ts
npm.cmd run verify:harness-package
npm.cmd run typecheck
npx.cmd biome check tests/general-agent-lifecycle.test.ts tests/general-agent-session-host.test.ts
npm.cmd test
```

若修复触及运行时执行、宿主或 SQLite，补跑相关 runtime/host 回归和 `npm.cmd run test:integration:harness`；对本次修改的其它受支持代码补静态检查。包 exports/声明或发行机制未变，不重复 ASAR/安装器验收；若确实改变，再重跑对应真实消费检查。不能只跑 help 或现有单插件 tarball 场景代替新增双插件烟测。

A 组完成要求：

1. A0 与 A1/A2 的每个场景都有既有或新增的明确证据；未写新测试的复用项可定位到现有行为断言，不以测试数量交付。
2. 组合的真实结果、安装发布边界、完整清理尝试、清理失败报告和共享服务所有权都成立；没有永久占位 fixture、源码锁定或内部类依赖。
3. 新增路径在实际 Node 消费程序中运行，成功等待/恢复、磁盘结果与失败回滚被观察；仅清理本次资源，临时脚本删除。
4. 如发现实现缺陷，保留失败前/修复后的消费者可见回归；若尚未修复，不把 A 标为完成。
5. 不宣称 B–E、Thread 原子准入、并行执行、容量治理、恶意插件隔离或跨进程恢复已完成；C2 候选竞争仍保持总计划的独立门槛。

## 8. 方案设计阶段证据（历史记录）

本次只设计方案、核对代码及运行已有基线；A1/A2 的新增夹具、永久测试和运行时修改均未实施。以下为本次实际结果，不复用 M3 总计划或包身份修正的历史数字：

| 命令/检查 | 本次结果与限制 |
| --- | --- |
| `npm.cmd run build:packages` | Core 与 logs 构建成功 |
| 第 7 节四个相关文件的定向 Vitest | 4 文件通过，69 项通过、1 项按现有 Windows 条件跳过；跳过的是 base-tools 的 final file symlink，不表示该平台场景已验收 |
| `npm.cmd run verify:harness-package` | 当前 Core 真实 tarball 仓库外离线安装、NodeNext/Bundler 声明消费、原生 Node 对话、审批等待/恢复、拒绝与安全错误投影通过；旧别名不可用，临时产物已清理 |

上述包消费者明确使用内存存储并报告 crossProcessDurability=false；它没有本方案新增的 A/B 组合。未运行新增组合烟测、全量单测、全仓类型/静态检查、CLI 集成或远程厂商调用，不能据此将 M3-A 标为实施完成。

## 9. M3-A 实施与验收记录

### 9.1 实际改动及场景映射

本轮仅增加两个现有测试文件中的公开行为覆盖，未修改 Core/宿主运行时、公开协议、包导出、版本或数据库格式；未新增永久套件、共享测试框架、命令或白盒豁免。本次覆盖未暴露需要修改运行时的违约，不将验收扩展包装成新增执行机制。

| 方案编号 | 本轮证据 | 状态 |
| --- | --- | --- |
| A0 | 改动前构建包并运行 lifecycle/infrastructure/session-host/base-tools 四文件：69 项通过、1 项既有 Windows 跳过；无插件/未安装工具沿用 session-host 原用例，文件操作沿用 base-tools | 基线已登记 |
| A1-1 / A1-2 | session-host 的 `composes and resumes a real receipt with %s registration order` 两种顺序；真实 SQLite、独立 Thread/nonce、文件追加收据；规范历史和模型消费结果一致，关闭后借用存储与 fallback 仍可使用 | 新增回归 |
| A1-3 | session-host 的 `keeps host denial ahead of the installed receipt capability and models the real error`；无能力 waiting、无写入、execute/resume 零次；按实际工具错误投影生成模型答复，不解析或钉住错误文案分隔格式 | 新增回归 |
| A2-1 | lifecycle 的 `rolls back a cross-plugin %s conflict and reuses the failed ID in the same application`，参数化 providerId/tool name/prompt id | 新增三项回归 |
| A2-2 | lifecycle 的 `rolls back later setup in reverse order without poisoning retained contexts or healthy installations`；同键健康安装不受影响、失败 ID 可复用、保留 context 的注册入口全部失效 | 新增回归 |
| A2-3 | lifecycle 的 `retains rollback failure after external creation cancellation and keeps the application usable`；已知 cleanupError 保留、其它释放继续、失败资源未伪称释放、同 ID 重建执行 | 新增回归 |
| A2-4 | lifecycle 的 `drains unpublished setup on close and reports rollback failure from both creation and close`；close 等 setup 退出、创建和关闭都保留 cleanupError、重复关闭幂等、借用端口仍可用 | 新增回归 |

A2 的局部模型夹具逐次创建独立 binding，不改变原 lifecycle fixture 的默认语义；这只服务安装隔离场景，不计作 B1 的多 Agent 同时在途验收。未要求取消中的 setup 退出前所有已取消资源均不得释放；本步契约是 close 必须等待未发布创建落定，不锁定资源回收微任务与 setup 的偶然交错。

### 9.2 新增路径的原生 Node 烟测

一次性 Node 程序只将当前 SQLite 适配编译为 ESM，Core 保持 external，原生解析 `@agent-harness/core/application/agent-application`；没有调用 Vitest、内部 Registry 或源码 alias。实际运行结果：

- `[模型, 工具]`、`[工具, 模型]` 各自完成 waiting→resume→completed，execute/resume 各一次；等待前无收据，恢复后磁盘恰一条，nonce/receiptId/调用身份与规范历史、模型答复一致。
- 宿主 deny 时 execute/resume 均为零、无文件，公开错误结果驱动模型继续并完成；拒绝工具不被错误等同于整个 Query 失败。
- 跨插件工具名冲突在模型绑定前失败；逆序回滚且工具未进入；同 ID 重新创建后实际完成一次对话。
- 完成检查点与租约释放、Agent 自有 binding/插件资源释放、关闭后借用历史仍可读均核验。

烟测输出 `nativeNode=true/coreExternal=true/realSqliteAndReceipts=true`；临时脚本、编译目录、隔离数据库及收据目录均已清理。该程序使用受控模型，**没有**验证远程厂商或跨进程崩溃恢复，也不声称 receipt 追加具备恰好一次保证。

### 9.3 集中检查、并行改动与剩余门禁（实施时记录）

| 检查 | 实际结果 |
| --- | --- |
| 新增后四文件定向 Vitest | 4 文件通过，78 项通过、1 项既有 Windows 条件跳过；相对改动前新增 A1 三项与 A2 六项，后续全量中本轮两个修改文件也均通过 |
| 两个修改测试文件的 Biome | 通过，修正本轮新增代码的导入/格式；未改其他文件或放宽规则 |
| `npm.cmd run verify:harness-package` | 当前 Core 的真实 tarball 仓库外安装、公开声明、原生消费及旧别名拒绝通过；其内存存储证据不冒充新增 SQLite 烟测 |
| `npm.cmd run typecheck` | 首次检查通过原有 Core/logs 门禁及 node/web 类型检查；并行 models 迁移后再次检查，三个包边界均通过，但全仓 TypeScript 失败，诊断在模型配置/开发 setup 与 models/remote-models 测试，不在本轮两个修改文件 |
| `npm.cmd test` 实施阶段最后一次全量 | 193 文件中 192 通过、1 失败；1646 项通过、1 失败、2 项既有跳过。失败为 `remote-models.test.ts` 的 Anthropic 发现用例：断言期望 SDK baseURL 为 `https://api.anthropic.com`，实际为 `https://api.anthropic.com/v1` |

全量检查期间仓库并行新增 `@agent-harness/models`，早一次全量因调用方已经迁移、workspace 尚未链接而出现 9 文件失败；没有抹去该次失败。离线 npm 安装因 SDK 注册表元数据未缓存而 ENOTCACHED，且禁用 lockfile 写入；随后只为已声明的本地 models workspace 建立标准目录 junction 并构建三个包，未修改模型源码、锁文件或 npm 命令。缺包问题解除后的全量结果如上，剩余 URL 契约失败不通过回退、改预期或删除他人的测试来掩盖。

实施阶段最近一次全仓类型检查的具体诊断包括：`src/main/agent-configuration/management.ts` 的 modelAdapter 类型不匹配，`src/main/agent-host/development-setup.ts` 的 mimoProfile 可能为 undefined，`tests/models-creation.test.ts` 的 adapterId 类型不匹配，以及当时 `tests/remote-models.test.ts` 的 mimo 名称/类型问题。这是运行时的仓库快照证据，不声称并行分支后续状态；本轮没有接管这些独立迁移文件。

实施时结论（后续收口见第 10 节）：M3-A 的实现、A0/A1/A2 定向证据和新增原生消费已交付；当时全仓验收仍有外部阻塞，暂未标记完整完成。并行迁移修复后需重新完成全仓类型/全量门禁。B–E 没有新增实现或验收；其部分既有测试随全量运行，不代表 C2 Thread 准入、故障窗口、并行执行或容量治理已完成。当时未运行 CLI 集成、远程厂商、生产构建或 ASAR 验收。

## 10. 后续独立复核与完成结论

在后续“校验 M3-A 完成情况”任务中，逐项核对新增 A1/A2 的真实断言；两项独立只读审查未发现本步阻塞性缺陷或明确验收项遗漏。已记录的并行模型迁移失败点出现后续修正后，重新执行当前快照门禁，而不是沿用旧失败或改动他人的预期：

| 复核项 | 实际观察 |
| --- | --- |
| 三包构建与四文件定向回归 | 构建通过；78 项通过、1 项既有 Windows 条件跳过 |
| 两个修改测试文件的 Biome | 通过，无自动修改 |
| `npm.cmd run verify:harness-package` | 仓库外真实 Core tarball 安装、声明、原生行为及旧别名拒绝通过 |
| `npm.cmd run typecheck` | Core/logs/models 三包边界及 node/web 类型检查通过 |
| `npm.cmd test` | 193 文件通过，1648 项通过、2 项既有跳过 |
| 新建原生 Node 组合核验 | Core 保持 external；两种插件顺序均完成 waiting→resume→completed；真实 SQLite/receipt、正确 nonce/receiptId、租约释放和借用服务可用均核验；宿主拒绝零写入、冲突逆序回滚及失败 ID 重用通过 |

该复核的原生脚本首轮错误地读取了首条输出而非最终响应，修正临时脚本后通过，没有修改生产实现。脚本、编译目录、隔离数据库和收据已清理。复核未修改永久代码或测试，未调用远程模型、未运行 CLI 集成、生产构建或 ASAR；这些场景不是本步未改运行时情况下的新增完成声明。

结论：按复核快照，M3-A 的 A0/A1/A2 和全仓门禁已闭环，可以验收完成。下一步为 [M3-B：执行隔离、单实例准入与关闭排空](m3-b-lifecycle.md)；B–E、C2 Thread 准入及其它可靠性边界仍须独立实施。B 方案阶段新发现的迟到 binding 回收异常不在 A 原有场景内，不改写 A 的历史验收范围。
