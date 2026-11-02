# M4-B 执行计划：桌面消费与生命周期闭环

状态：B0～B6 已实施并完成本地验收，证据见第 8 节。已完成主文档隔离、异步裁决、真实双窗口与原生目录/关闭验收；C～E 不因本切片自动完成。[M4-A](m4-a-host-boundary.md#9-实施与本地验收记录)已完成，B 复用其中立 NodeHost、纯安全投影和依赖门禁。所属范围见 [M4 总计划](m4-host-consumption.md#5-执行切片)，持续约束见 [AGENTS.md](../../AGENTS.md)。

## 1. 目标与范围

将真实 Electron 桌面的一次执行从可信文档输入、事件观察、待决交互到窗口/应用退出串成可验证闭环，重点处理竞争与资源所有权，不重写 Harness 状态机。

本阶段交付：

- 窗口、主文档、宿主 scope、会话和 Run 的身份隔离。
- 快照、命令回包、模型目录与事件的陈旧结果裁决。
- 正常关闭、renderer 丢失、文档重载及应用退出时的停止受理、中断、排空和错误结算。
- 双窗口不同 Thread 隔离、同 Thread 写竞争的真实 SQLite 验收。
- 原生目录选择的确认、取消、迟返回和窗口所有权验证。
- 真实桌面操作与持久事实相互印证，保持 A 的 CLI 消费及恢复语义不退化。

不包含：UI 风格重做或全量 U3～U5、PPT/Skill/子 Agent、旧 Agent/Gateway 退出、完整存量数据迁移矩阵、第二后端、独立宿主包、ASAR/安装器总认证、自动重试/抢租约、并行调度和容量有界建设。新建永久第二窗口产品入口也不是隐含需求；验收可通过受控 Electron 消费者创建两个生产窗口。

## 2. 实施前基线与待证问题

| 已核对落点 | 实施前事实 | B 的处理 |
| --- | --- | --- |
| `app/main/agent-host/ipc.ts` | 按 webContents.id 持有宿主；请求及事件调用 assertTrusted；关闭跟踪 closingWindows 和 pending | 补主文档世代及关闭竞争验证，不能仅凭 URL/相同窗口 ID 认定仍属原文档 |
| `app/main/index.ts` | 核实可信窗口 ID、senderFrame/mainFrame 和 URL；renderer 丢失/closed 调用 closeWindow；应用退出等待 Harness 再关闭日志 | 以真实窗口验证所有入口、结束原因和顺序；完整关闭失败需有安全诊断 |
| `app/main/window/create-window.ts` | will-navigate 阻止外链导航；window.open 交系统浏览器 | 保持现有外链策略；同 URL 重载、renderer 重建和跨文档切换仍需独立身份规则 |
| `desktop-host.ts` | 有 scopeId、单调 revision、active/transition/closing；快照先捕获身份，先发布运行身份再消费事件 | 保留有效机制，补目录选择、发布、关闭交错；不靠延迟或吞异常通过 |
| `workspace-controller.ts` | 有 generation/disposed、scope/revision 和完整 Run 比较；refresh 有世代检查，命令/refreshModels 不全走同一检查路径 | 逐异步路径验证卸载再挂载、旧 scope 回包、发送草稿与切换结果；静态差异不直接当作已复现缺陷 |
| `DesktopApp.tsx` | 设置页通过 hidden 保留工作区及同一控制器 | 设置往返不等于文档重载；不得为修复生命周期改成每次切页销毁宿主 |
| 现有桌面测试 | 已覆盖延迟快照、首段预览、待决恢复、错误保密、基本窗口身份/关闭及草稿保留 | 增量覆盖未证竞争，不复制已测路径或重新钉文案/布局 |
| A 的真实烟测 | CLI/Electron 的改造前 waiting 均恢复成功；桌面无插件和批准后文件读取通过 | 作为已有证据，不能替代 B 的双窗口、文档与原生选择器验收 |

目前只确认上述实现和覆盖面；任何行为缺陷应在 B0 复现后再修，不能以本计划推断所有竞争都已失败。实施时须重新核对用户当前桌面改动，保留现有标题、输入、停止按钮、草稿与展示交互。

## 3. 设计契约

### 3.1 身份与权威来源

| 身份 | 所有者与用途 | 不允许的替代 |
| --- | --- | --- |
| webContents.id | Main 管理窗口及销毁生命周期 | 不能单独代表同窗口重载前后的文档 |
| 主文档世代 | Main 管理跨文档导航、重载及 renderer 重建，绑定受理/回包/事件 | 不能由 renderer 自报世代取得权限；URL 相同不是同一文档 |
| scopeId + revision | DesktopHarnessHost 的观察身份与快照顺序 | revision 不能跨 scope 比大小；未知旧 scope 不能随意替换当前已确认 scope |
| Thread/Query/Run | 宿主/Core/持久层的执行身份 | 展示名称、选中行、工具 callId 或自然语言“同意”都不是执行身份 |
| interactionId | 权威 waiting checkpoint 内的回答目标 | 不能只依赖按钮是否禁用或页面缓存 |

主文档世代仅是 Main 内部的安全/lifecycle 元数据，优先不新增 IPC 字段或握手 API。既有 scopeId、revision 和 Run 足以供 renderer 观察；确需改变 IPC 时必须先记录必要性并同轮迁移 Main/preload/renderer/测试，不留兼容别名。

### 3.2 可信文档与重载策略

确定采用“**跨主文档失效时回收旧宿主，新文档从权威存储显式继续**”的保守策略，不让新文档继承旧执行的活跃调用栈。

- 每个请求先核实可信窗口、当前主 frame 和允许 URL，再绑定 Main 当前文档世代；跨异步等待后，回包/事件投递前再次核实世代与窗口状态。
- 已阻止的外部导航、hash/同文档路由及单纯退出观察不触发宿主关闭；真正提交的主文档替换、显式 reload 和 renderer 丢失才使旧文档失效。区分 Electron 导航开始、取消和提交，不能误把被拒导航当作成功替换。
- 文档失效立即停止旧代受理/投递，中断并排空它拥有的宿主；active 按 Harness 关闭规则 interrupted，已持久化 waiting 保持 waiting。
- renderer 重建或可信页面重新加载后，同一 webContents 可获得新文档世代和新 scope。新宿主只在旧宿主排空成功后发布，不从 closingWindows 的永久墓碑错误推断窗口永远不可用。
- 新文档初始化可以等待旧代的资源释放屏障；这是宿主生命周期排序，不是 run/resume 请求排队。失效旧代的业务请求必须拒绝，不能等到新代后自动执行。
- 旧宿主关闭失败不静默创建替代宿主、不自动抢旧租约。返回安全错误，保留持久事实供诊断/显式处理。
- 活动 Run 不因页面重新加载自动续跑；新页面查询历史后由用户显式恢复/取消。非终态和恢复范围继续使用现有协议。

实施落点优先是已有注册器/窗口装配；确需提取生命周期协调器时由 desktop 模块内聚，不建立全局容器、通用窗口框架或第二套运行时。

### 3.3 异步结果与输入裁决

- 控制器每次 start/stop 对应独立本地 generation，覆盖 refresh、refreshModels、命令 action、finally 清理和事件订阅，而不只覆盖初次 snapshot。
- 一个命令开始时固定目标、原草稿 key、控制器世代和已接受 scope。旧代回包不能修改新代 pending/error/drafts/composingNew 或选择状态。
- 首次有效初始化快照确认当前 scope；后续 scope 更换只允许由受控的新生命周期初始化确认，不能因任意晚到旧 snapshot 的 scope 不同就替换当前视图。
- 同 scope 的旧 revision 丢弃；相同 revision 不制造重复追加。事件只有在 scope 与完整 Run 匹配时进入临时预览/工具进度；晚到旧 run.settled 不能清掉新 Run 预览或发起影响新上下文的刷新。
- 保留 Main“先发布运行身份，再排空首段事件”的现有顺序；run/resume 回包晚到不能覆盖已观察的终态，重复预览渠道不重复显示正文。
- 发送失败保留原草稿；成功只清除实际提交且期间未编辑的那份草稿。首次真实会话创建成功、run 失败时，草稿必须归到已创建会话，不退回虚构新会话。
- 卸载只停止观察，不取消执行。相同文档重新订阅从新快照对账；文档替换由 Main 的所有权策略处理中断，不能将这两者混为一谈。
- 重复发送/审批/恢复/取消在 UI 和 Main 两侧都验证；Main 与持久层是最终边界。失效请求明确拒绝，不新增自动重试或伪幂等缓存。

### 3.4 窗口关闭与应用退出

| 结束原因/状态 | 既定结果 | 必须保留的事实 |
| --- | --- | --- |
| 用户取消 active 或 waiting | cancelled | 已发生 applied 影响不回滚，临时文本不冒充历史 |
| 只卸载订阅/打开设置 | 不改变运行终态 | 执行独立推进，可重新读取权威结果 |
| 窗口关闭/文档重载/renderer 丢失时 active | 按关闭协议 interrupted；已提交终态不倒退 | 排空后释放 lease/模型/存储，不重做工具 |
| 上述情况下已持久化 waiting | waiting | pending 不丢失，不伪造取消回答 |
| idle 窗口关闭 | 释放窗口拥有资源 | 不关闭其他窗口或应用共享服务 |
| 应用退出 | 所有窗口停止受理并排空后释放共享依赖 | 重复 quit/close 共用关闭 Promise，错误不被成功退出文案掩盖 |

具体顺序为：标记受理关闭与文档失效 → 请求宿主中断/关闭 → 排空 transition、目录等待、观察和在途 IPC → 回收该窗口资源；应用级再关闭共享存储/日志。已关闭结果可供多处 await，不可由第一次调用删除映射而让第二次关闭遗漏排空。

窗口可以先销毁 UI，Main 仍必须持有排空 Promise；若需阻止 close 等待排空，只做最小窗口级协调，不能新增无需求的退出确认交互。应用 before-quit 与窗口 close 同时到达也必须等待同一批资源。

一个窗口关闭/崩溃不能中断另一个窗口的 Harness 执行。旧业务的全局 abortAllActiveRuns 与旧 Agent 仍由旧链路拥有；不为此切片重写旧调度，必要衔接只改受影响的通用宿主所有权。

关闭错误保留安全分类与失败资源阶段；先停止受理、继续回收可回收资源，最后聚合报告。不得以 catch 后固定成功、提前关闭日志或丢弃失败 Promise 验收。不新增完整日志平台或输出 SDK 原始异常。

### 3.5 双窗口与持久写入

- 两个生产 BrowserWindow 各拥有 DesktopHarnessHost/scope/选择/草稿/订阅；共用借用的 application configuration/logs，不能在单窗口 close 时关闭共享实例。
- 不同 Thread 各自可运行是已有多实例消费，不新增单 Agent 并行或宿主全局调度。
- 同一 Thread 两窗口竞争通过原绑定/持久准入与 lease/fence/CAS 拒绝一个写入方，不能自动接管、轮询重试或默默排队；失败方不能消耗待决回答或重派工具。
- 执行状态以 DB 为准，其他窗口列表更新不引入自动广播/全局 Store 要求；手动刷新后可以看见权威事实，但当前选中状态不替另一窗口执行恢复。

### 3.6 原生目录选择

- 继续调用 `dialog.showOpenDialog(所属窗口, { properties: ["openDirectory"] })`；不能在失去所属窗口后回退成与窗口无关的 picker 并发布其结果。
- 开始选择前捕获窗口/文档世代，返回后先验证仍属原请求，再调用既有 workspace 校验及最近记录。关闭/重载后迟返回不能创建最近记录、切换新工作区或再打开 NodeHost。
- 取消选择保持原工作区、会话、绑定、草稿和权限；不把“返回原快照”误当成新会话切换。
- 确认有效目录后按现有工具路径守卫处理并绑定，不能由 renderer 传任意路径绕过选择/签发机制。无权限/不存在路径返回安全错误，旧上下文保持。
- 运行期间 picker/工作区切换保持明确 busy 规则；waiting 时现有页面禁止切工作区的交互保持，不扩展新的导航能力。直接 IPC 仍需保证不能改写等待请求的原绑定。

## 4. 执行切片与文件落点

### B0：行为基线与竞争复现

前置：A 完成，确认当前用户改动与公开 API。

- 核对 DesktopHarnessHost、IPC 注册、窗口可信来源、before-quit 与控制器全部调用方；导出协议改变前查询引用。
- 使用可控 deferred 模型/存储/目录结果复现顺序：首段事件早于回包、旧快照晚完成、旧命令跨 stop/start、关闭发生在创建/发布/picker 内。
- 建立真实 Electron 的独立 HOME/USERPROFILE、safeStorage、本地 SDK/HTTP 和随机文件工作区。保存每个场景的初始选择/草稿、scope、Query/Run、checkpoint 与 lease。
- 复用已有桌面测试；缺陷保留失败前/修复后消费者回归。没有复现的问题只补必要验收，不为了计划预设一轮重构。

交付：基线、确证缺陷与覆盖缺口清单，以及可重复执行的最小消费路径。

### B1：窗口/主文档注册与安全边界

落点：`app/main/agent-host/ipc.ts`、`app/main/index.ts`、必要的 `app/main/window/create-window.ts`，以及确需更新的公开注册契约。

- 将文档世代、注册/失效、回包与事件验证纳入同一窗口生命周期；保留现有可信 URL/主 frame 校验。
- 分离真实窗口关闭和文档重建的回收语义，允许同窗口在排空后新建 scope；旧 pending 始终归原代。
- 窗口关闭、registry.close、导航失效和多次调用共同等待所有所属资源，不从 Map 删除后遗失关闭失败。
- 覆盖非可信 frame/URL、跨窗、同 URL 重载、renderer 丢失后重建、旧请求迟回包及被阻止的外链导航。

交付：Main 不把旧文档权限/执行自动交给新文档，桌面 IPC 不泄漏内部快照/凭据。

### B2：控制器异步裁决与桌面状态

落点：`app/renderer/src/desktop/workspace-controller.ts`、`DesktopApp.tsx`、`DesktopWorkspace.tsx` 的必要消费改动；`app/shared/harness-ipc.ts`/preload 仅在契约确需变化时修改。

- 统一本地生命周期世代检查及 scope 确认，覆盖命令/模型刷新/事件/finally；旧结果不能解除新操作 pending 或删除新草稿。
- 保留当前标题、输入与停止按钮、权限和模型呈现；只修行为，不重做 CSS/页面架构。
- 核验重复点击、旧交互、旧 Run 结算、草稿中途编辑、首次会话创建后失败、设置返回和监听清理。

交付：React 真实消费者回归与实际桌面观察证明状态归属，不锁定 CSS、文案或 mock 回声。

### B3：关闭排空与双窗口准入

落点：`desktop-host.ts`、`ipc.ts`、Main 关闭装配及既有桌面宿主回归。

- 按第 3.4 节验证 idle/active/waiting、创建/发布中、关闭失败和重复关闭；必要修复保留原 Core 不变量。
- 两个窗口不同 Thread 同时运行，关闭/renderer 丢失一个窗口，核验另一个未被取消；同 Thread 竞争核验唯一持久写入方。
- 退出途中阻止新 IPC，等待 pending、观察与依赖正确关闭，不能只凭窗口消失或进程退出码为 0 判断成功。

交付：UI/进程与 SQLite 状态相符，窗口范围和应用范围回收可区分，错误资源有安全诊断。

### B4：目录选择竞态与原生确认

落点：Main `chooseDirectory` 装配、`DesktopHarnessHost.chooseWorkspace/switchWorkspace`、workspaces.ts 的必要变更。

- 核验取消、不合法结果、迟返回、跨文档结果和关闭后返回；无效结果不得产生最近记录或新宿主。
- 在真实 Windows 选择器通过实际键鼠完成“打开→定位本次临时目录→确认→界面绑定”；再做取消路径。记录实际选择路径、窗口归属和后续工具根。
- `remember()`/预写 JSON/直接注入路径只能作为其他场景的准备，不算原生确认。本地 OS 输入环境若阻塞，完成其余实现并如实保留 B4 未完成，不能把 B 标完成或换成假 picker。

交付：目录确由系统 UI 选择，切换后的只读工具只看到新绑定工作区；取消与晚结果不改变旧上下文。

### B5：真实桌面综合验收

前置：B1～B4 完成。使用当前构建产物而非 ui:dev，从同一生产装配创建两个真实窗口；临时控制器只负责开窗/触发条件/取证，不替代生产 IPC、宿主或选择器。

执行第 5 节矩阵：公开输入及真实 UI 操作、受控本地 SDK/SSE、真实工作区文件与 SQLite 联合证明。重启/重载分场景记录，不把强杀、取消或直接 API 调用当成正常关闭/点击批准。

交付：实际命令、PID/webContents/文档世代/scope、Query/Run、动作、最终持久状态及已验证限制。受影响 CLI 实际入口 smoke，避免桌面切片破坏 A 的共享消费。

### B6：门禁、清理与证据收口

- 运行受影响行为回归、类型/边界、完整回归、构建和本轮文件静态检查；不在并行分片重复构建共享产物。
- 只保留能捕获消费者可见风险的永久测试；删除临时脚本和本次创建的隔离数据、截图、服务与窗口，不动生产会话或其他进程。
- 回写本文及 M4/整体路线状态。必测未通过必须保持待完成，不把未执行的真实矩阵列为通过；B 完成不勾选 C～E。

依赖顺序：B0 → B1 → B2/B3/B4 → B5 → B6。先稳定文档失效契约；renderer 与 Main 的独立实现才可并行，ipc.ts/Main 共享装配由同一集成者拥有，不能各造一个 epoch 注册器。

## 5. 行为验收矩阵

| 场景 | 必须证明 | 证据层 |
| --- | --- | --- |
| 无插件对话与首段预览 | 无文件工具，首段只出现一次，最终正文来自提交；回包晚到不覆盖已完成态 | 真实 Electron + 本地 SDK + DB |
| 请求/事件可信来源 | 非可信窗口/子 frame/URL 被拒，无工具/配置读取；旧文档事件和回包不外泄 | Main 消费者回归 + 真实 reload/窗口 |
| 旧快照/模型刷新/命令跨代 | 不覆盖新 scope、选择、pending、error 或草稿；旧 settled 不清新 Run | deferred 消费者回归 + 实际切页/重载 |
| 重复发送与重复审批 | 只有合法一次激活，旧 interaction 不被消费，工具效果不重复 | UI/Main 回归 + SQLite/临时文件 |
| 失败与草稿 | 发送失败、创建会话后失败、在途编辑均不丢草稿；SDK 异常不回显 | React 回归 + 实际页面 |
| 单纯观察卸载/设置往返 | 不取消，重新观察可读权威结果，无重复监听追加 | 消费者回归 + 实际设置操作 |
| 同 URL 重载/renderer 丢失 | 旧宿主排空；新代新 scope，不自动续跑；active 中断、waiting 保留 | 真实 Electron + DB；崩溃场景不冒充正常关闭 |
| idle/active/waiting 正常窗口关闭 | 资源释放；active interrupted 或已有已提交终态，waiting 不丢；lease 释放 | 正常 OS 窗口关闭 + 新进程只读核验 |
| 两窗口不同 Thread | scope/草稿/事件隔离；关一窗不影响另一执行 | 两个真实窗口 + 各自 checkpoint |
| 两窗口同 Thread 写竞争 | 一个写入方，失败方不收养 binding/回答或重派工具，不能抢租约 | 两真实消费者/进程 + DB 围栏/结果 |
| 正常应用退出与关闭失败 | stop→drain→dependencies；在途 IPC 不重入，失败有安全诊断，重复 quit 不漏资源 | 消费者错误注入 + 实际应用退出 |
| picker 确认与取消 | 原生 UI 选中临时目录，绑定实际根；取消保持旧会话/草稿 | 真实 Windows 对话框键鼠 + 后续文件结果 |
| picker 迟返回/失效 | 关闭/重载后不记最近目录、不换 workspace、不重新开宿主 | deferred 回归 + 实际关闭时开着 picker |
| 用户取消和拒绝 | cancelled/拒绝语义保持，已发生影响保留，临时输出不进历史 | 实际按钮 + 规范历史/lease |
| waiting 重启恢复 | 原 Query、新 Run、批准后消费随机文件；审批前未读取，正常退出保持 waiting | 真实 Electron 新 PID + DB/文件 |
| CLI 共享消费回归 | 帮助加载、无插件对话及文件 waiting/恢复不退化 | 当前 Node CLI 实际入口 + 相关集成 |

所有“未执行”与“环境阻塞”单独记录。浏览器截图只证明当前表面，不证明持久状态；退出 0 不证明 Query completed；受控 SDK/HTTP 不代表远程厂商兼容。

## 6. 验证方式与命令

永久回归优先扩展 `tests/desktop-harness-host.test.ts`、`desktop-workspace.test.tsx`、`desktop-settings.test.tsx` 及现有 CLI/边界回归。若需单独文件，只按真实文档/窗口行为组织，不做主文件源码字符串、注册次数、导出数量或简单转发断言。

```text
npx.cmd vitest run tests/desktop-harness-host.test.ts tests/desktop-workspace.test.tsx tests/desktop-settings.test.tsx tests/cli-boundaries.test.ts
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:integration:harness
npx.cmd biome check <本次修改的受支持文件>
npm.cmd run build
npm.cmd run agent -- --help
npm.cmd run agent:dev -- --help
```

先构建新入口再跑依赖 CLI 产物的消费者，避免 A 首轮 fixture 已改而产物未生成的顺序问题。实际 Electron 从构建入口启动，隔离 HOME/USERPROFILE；原生 picker 操作应使用可控制真实 OS 窗口的工具，不拿 browser 页面 DOM 操作冒充系统对话框。运行前确认环境可用；本计划不为通过验收添加生产测试开关或改变路径安全策略。

默认只使用本地 SDK/HTTP 和受控模型，不产生远程厂商用量。需要远程补验时先说明厂商、模型、场景和用量，使用现有授权配置，不复制/打印 Key。完整 ASAR/安装器矩阵仍归 E；若 B 改动了打包解析，则必须补受影响产物 smoke，不能拖后掩盖。

## 7. 完成定义与本次记录

- [x] B0：基线、可复现竞争和测试覆盖缺口清楚。
- [x] B1：请求、回包、事件与主文档失效/重建边界通过。
- [x] B2：控制器全部异步路径的世代、scope、草稿与 Run 裁决通过。
- [x] B3：关闭排空、错误结算、双窗口隔离及同 Thread 竞争通过。
- [x] B4：原生目录确认/取消及迟返回安全通过。
- [x] B5：真实桌面综合矩阵与持久证据齐全，CLI 受影响路径通过。
- [x] B6：类型/边界/回归/构建/静态检查通过，临时资源清理，证据同步。

2026-11-02（设计阶段）：核对 M4/A 状态、Main 可信来源/窗口/退出装配、DesktopHarnessHost、IPC/preload、renderer 控制器及已有桌面回归，制定 B0～B6。当时只更新计划与导航，未复现或修复生产缺陷，未运行代码测试、模型、真实窗口或系统对话框；历史 A 验收不计为新增 B 证据。

设计阶段文档核验：4 份文档 UTF-8 有效、代码围栏配对，89 处本地链接目标存在、50 处链接锚点可解析；当时 B0～B6 章节齐全，7 项完成清单待实施。该文档核验不计入 B 行为验收；后续实施证据见第 8 节。

## 8. 实施与本地验收记录

2026-11-02：完成 B0～B6。保持 Core、模型协议、IPC DTO、SQLite/宿主 binding 格式、授权和 CLI 基础执行语义；不新增重试、自动接管或全局调度。并发存在的标题、输入/停止按钮、Markdown 和工具结果展示改动保留，不计为本切片新增功能。

### 8.1 已复现问题及修复

1. **同 URL 重载复用旧宿主**：改造前真实 Electron reload 前后 scope 均为 `4287a55c-a143-40d8-939a-cb6079f9fbf5`。Main 注册器现按提交的主文档世代持有宿主，重载/renderer 丢失回收旧代，新宿主等待旧代排空成功。非提交导航及 hash 不改变所有权，失败屏障不静默恢复。
2. **旧模型刷新覆盖新控制器**：独立消费者脚本先证实 stop/start 后旧 refreshModels 将 scope 从 new 覆盖回 old；修复后保持 new。控制器现在统一检查 generation、确认 scope、完整 Run 及命令目标，覆盖回包、catch/finally、订阅和初始化。旧 settled 不清理新 Run，旧命令不解除新 pending 或删除新草稿。
3. **原生目录事件先于回包导致新工作区不可输入**：真实选择新目录后出现无会话但模型菜单禁用；独立脚本证实 composingNew 为 false。切换前固定原工作区身份，避免提前到达的 snapshot 将“是否变化”的比较基准改掉；页面回归及修复后原生目录→审批→真实新根文件结果通过。
4. **关闭遗漏在途资源**：宿主为读取/临时模型目录、初始化、运行身份发布和观察保留排空屏障；所有异步安装/最近记录提交点检查生命周期。重复 close 复用 Promise，多个读取用 allSettled 排空；目录读取与清理双失败都保留，公开诊断不泄漏原异常。
5. **原生 picker 父窗口先销毁可遗留系统对话框**：真实 Windows 验收发现，窗口已消失但 picker 仍在，应用退出因此继续等待。`window-lifecycle.ts` 现先拦截 close、停止受理并排空，picker 归还后才关闭其原生父窗口。无新增确认框、强杀或超时假释放；用户尚未结束原生选择时，关闭请求保持等待且父窗口仍可交互。

`ipc.ts` 新增 Main 使用的 documentCommitted/invalidateDocument，最终 closeWindow 与文档失效分离；请求、回包、事件和 chooser 都核实原文档。`create-window.ts` 在加载前安装生命周期；Main 沿用原可信 URL/主 frame 规则和共享服务关闭顺序。注册器、宿主和控制器的调用方及消费测试同轮更新，未暴露前端可自报的世代或 checkpoint。

门禁同时处理了并发工具投影使用 `node:path.posix.normalize` 的冲突：只允许 `node:path`/`path` 的词法计算，不放开 fs 或其他平台端口；正例及原 I/O 拒绝场景均通过，工具投影和文件安全实现未重写。

### 8.2 验证环境、命令与结果

共享工作树首轮全量出现两个 configuration/dist 模块加载失败套件，CLI 集成首轮有两项退出码失败。没有修改业务逻辑或放松断言去掩盖；最终将源码、清单及构建配置复制到本轮独立临时验证目录，第三方依赖只读借用，五个 workspace 产物在副本独立构建，按构建→完整单测→集成顺序执行，避免与其他构建共享可被移除的 dist。最终 12 个 B 相关源码/测试/门禁文件与当前工作树逐字节一致。这个证据不等于任意并发构建下共享产物稳定，也不认证快照之后其他人的改动。

| 检查 | 实际结果 |
| --- | --- |
| 首轮四文件定向回归 | 65 项通过、1 项测试误把安全文案中的普通 private 单词当作泄漏；改为实际注入的唯一敏感 sentinel，保留产品错误文案 |
| 修正后的四文件定向回归 | 4 文件、66 项通过；后续双失败、目录回包和原生父窗口回归继续纳入最终全量 |
| 最终窗口/宿主/控制器定向回归 | 3 文件、60 项通过 |
| `npm.cmd run build`，最终在隔离副本执行 | 五包构建、Core/logs/models/tools/CLI/UI 边界、node/web/CLI 类型及 CLI/Electron main/preload/renderer 构建全部通过 |
| 最终隔离副本的全量单测 | 222 文件通过，2348 项通过、3 项既有跳过 |
| 三文件 `npx.cmd vitest run`，最终隔离副本 | general-agent-development-cli、mimo-development-cli、general-agent-reliability 共 3 文件、62 项通过 |
| 本轮 12 个支持文件的 Biome | 最终检查无修改、无诊断 |
| `npm.cmd run agent -- --help`、`npm.cmd run agent:dev -- --help`，隔离副本 | 两入口均通过，开发构建保持独立缓存 |
| 两个独立控制器复现脚本 | 旧模型刷新和原生工作区回包顺序均先复现失败、修复后通过 |

新增回归一度使用未注册的 jest-dom matcher，已按仓库约定改为原生 DOM 属性断言；没有安装额外测试框架。初次本地流驱动的增量/最终正文不一致被适配器正确拒绝，修正驱动后重验，不降低模型完整响应校验。公开接口迁移通过解析依赖图、类型、构建和实际消费者核验。

### 8.3 真实桌面矩阵与持久事实

使用真实 Windows Electron、隔离 HOME/USERPROFILE、safeStorage、OpenAI Responses SDK→本地 HTTP/SSE、两个临时工作区和随机文件校验码。多窗口由临时驱动触发现有生产 activate/createWindow 装配，未新增产品开窗入口或替代生产 IPC/宿主。关键阶段先在实际工作树产物运行，再在同源码的稳定隔离构建产物完成最终复验。

| 场景 | 实际动作与观察 |
| --- | --- |
| 无插件与预览 | 真实页面发送普通对话；未安装文件工具。持有模型响应期间预览可见；最终以规范历史结算 |
| 双窗口不同 Thread | 两个窗口各自运行；关闭一个后其 Query interrupted/租约释放，另一窗口保持活动并 completed。不是新增单 Agent 并发 |
| 同 Thread 竞争 | 两个真实窗口经生产 IPC 同时提交；一个激活，另一个明确 HOST_QUERY_UNFINISHED，只有一个模型请求和持久写入方。另有真实 SQLite 消费者回归验证租约竞争、待决回答与不重放工具 |
| 正常 active reload | 新 scope、无活动 Run、原 Query interrupted、租约释放，不自动续跑 |
| renderer 崩溃/重建 | 实际 forcefullyCrashRenderer 后重载取得新 scope，原 Query interrupted；另一窗口活动执行不受影响。自动化重新挂接期间有额外重载，不冒充单次 OS 正常关闭 |
| hash/被拒导航 | 同文档 hash 和被阻止的非可信本地导航保持原 scope；没有打开外部站点 |
| waiting reload | 同一持久待决交互保持 waiting、lease released；选回原会话后可以明确拒绝，文件校验码未进入历史 |
| 拒绝、waiting/active 取消 | 真实拒绝/停止按钮生效；取消为 cancelled，临时模型文本不进入 committed，运行中编辑的下一条草稿保留 |
| 设置/观察 | idle 设置往返保持草稿；运行/审批中设置沿现有 UI 禁用规则，不为验收新增导航能力。单纯订阅卸载不取消由控制器消费者回归证明 |
| 原生目录确认与取消 | 从真实页面打开系统 picker，以 Windows 原生编辑控件输入、WM_LBUTTONDOWN/UP 交互确认目录；取消保持工作区/会话/草稿。新目录审批后实际消费 other 工作区文件，而非原工作区 |
| 原生迟返回与 reload | 新文档等待旧 picker 排空；旧 picker 返回 late-target 后，新 scope 的工作区仍为空，最近目录没有该目标 |
| picker 打开时请求关窗 | 修复后父窗口保持到 picker 归还，迟目标不落记录，随后父窗口关闭；另一窗口继续 completed |
| idle、active/waiting 关闭及应用退出 | idle 窗口正常关闭；最终应用同时持有 active 与 waiting，正常退出 0，独立 Node 进程核验终态/全部租约 |
| 恢复 | 正常退出留下的 waiting 在新 PID 保持 Query、产生新 Run；真实点击批准后消费文件，completed 且 lease released |

Windows 隔离 HOME 最初缺少 Desktop/Documents，系统选择器显示“位置不可用”；创建本次临时 HOME 的真实系统目录后继续操作，未改变生产 picker 默认目录或安全策略。全局鼠标注入未作为成功证据，最终使用真实原生控件及窗口鼠标消息完成选择；不是预写 workspaces.json、remember() 或假 picker 回调，也不声称人工硬件/读屏认证。

| 持久证据 | Query | Run / 结果 |
| --- | --- | --- |
| 桌面应用退出后恢复，PID 6976 → 30852 | `c0e17851-2efc-40f4-8f74-28bd2722c017` | `e7d1ec5a-88ac-4df1-94c1-24ed7a430a6a` → `08a8361a-ad46-49eb-ae38-16a08339a596`，completed / lease released |
| 最终应用退出的 active | `2a8992da-f958-457c-84c3-d5557dd27daa` | `71b71db3-b8b5-4c94-b1a0-fd6858707b85`，interrupted / lease released |
| 最终应用退出的 waiting | `d7ab3f64-30dd-4ac3-8fff-14dc739abdb8` | `df51872e-0c69-4661-8943-a3a5ce526c9e`，waiting / lease released |
| 原生父窗口关闭时的另一窗口 | `b901b249-2043-4843-ba0a-3b357eef127d` | completed / lease released，未受其他窗口关闭影响 |

最终 Electron PID 30852 正常退出 0；独立进程检查本轮 19 个检查点全部 owner_id 为空，late-target 未记录。此前发现遗留 picker 的轮次在取消真实原生对话框后也正常退出 0，不把那一轮未归还 picker 时的等待写成已通过。

### 8.4 CLI 消费、边界与清理

另以临时非测试框架驱动运行当前 CLI 产物：真实 DPAPI、本地 SDK/HTTP、无插件对话、文件 EOF waiting=3、新进程显式批准和持久核验均通过。PID 11856 → 22232，Query `986e0cac-875a-48f3-8fdb-6d20469b1662`，Run `fd1e5968-dc3a-48df-ab02-529f3c2d5158` → `52d729f1-fd08-437b-9307-5ef8b213e388`，completed、lease released，3 次本地模型请求。该交互驱动使用受控 stdin/raw 标记，不冒充新增 ConPTY 认证。

未调用远程模型厂商、迁移用户数据库或修改持久格式；未完成 C～E、PPT/Skill/子 Agent 接入、ASAR/安装器总认证或事件容量有界建设。关闭等待原生用户操作不是强制取消系统对话框的承诺。

本轮脚本、原生截图、隔离 HOME/配置密文/数据库/工作区、CLI 数据、源码验证副本及缓存已清理；先解除第三方依赖 junction，再删除本轮临时目录，未删除借用的 node_modules。所有本轮 Electron、本地服务/CLI 进程已退出，浏览器托管句柄已释放；未清理其他人的构建、数据或进程。

收口文档核验：4 份文档 UTF-8 有效、代码围栏配对，93 处本地链接目标存在、57 处锚点可解析；B0～B6 的 7 项完成，M4 A/B 已勾选、C/D/E 的 3 项仍未勾选。确认本轮临时目录已不存在，借用的 TypeScript/Vitest 依赖仍存在；未检查外部站点。
