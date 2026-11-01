# mimo-token-plan-cn 具体实施方案

状态：前序已实现 P1–P3，并完成 P4 的小范围实际 CN 验收。第 1–9 节保留实施设计与原始基线，第 11 节保留原生 MiMo 接入当时的结果与未验收边界；随后实现已迁入单个 `@agent-harness/models` 包，当前四入口、调用方迁移及本地验收见[模型包实施记录](next-steps/models-package.md#12-实施与验收记录)。本轮抽包没有新增远程验收，生产聊天、PPT 能力及生产会话未切换或迁移。持续约束见 [AGENTS.md](../AGENTS.md)，路线见 [项目整体规划](project-plan.md)，当前入口见 [下一步计划](next-steps/README.md)。

## 1. 已确定范围

本轮正常接入 `mimo-token-plan-cn`，承接 Coding + PPT 的总体方向，但不迁移 PPT 插件、生产聊天或生产会话数据。只接中国连接与 Responses 协议，不同时实现 Chat Completions、Anthropic 或其他区域。

| 项目 | 决定 |
| --- | --- |
| 连接标识 / 内核 providerId | `mimo-token-plan-cn` |
| Base URL | `https://token-plan-cn.xiaomimimo.com/v1` |
| 执行接口 | `POST /responses` |
| 模型获取 | `GET /models`，使用同一连接与凭据 |
| 认证 | 复用 OpenAI SDK 的 Bearer 认证；凭据经现有 agent-configuration 解析 |
| 思考强度 | 默认（不发送字段）或 `none/minimal/low/medium/high/xhigh/max/ultra`，按请求值原样传递 |
| 初始执行能力 | 文本、厂商返回的推理内容、函数工具、非流式与流式、取消、用量和恢复 |
| 文件与日志 | 使用已实现的 tools / logs；模型适配器不自己读写工作区 |

不做套餐用途判断、额外用途拦截、思考档位合并或档位同效提示；不自行把 high 改成 low、删除已选择的档位或将选择改写成提示词。仍正常校验协议取值、地址、鉴权、错误和恢复兼容性。

初始不接入图像/音视频、厂商内置搜索、custom/freeform 工具、自动重试、付费降级、额度面板或多厂商框架。适配器初始 images=false，遇到图像明确拒绝，不替换为占位文本。总体方向包含 PPT，不等于本轮已经安装 PPT 能力。

## 2. 官方协议依据与证据边界

- [Token Plan 快速接入](https://mimo.mi.com/docs/zh-CN/tokenplan/Token%20Plan/quick-access)：套餐地址与专属凭据。
- [Token Plan Codex 配置](https://mimo.mi.com/docs/zh-CN/tokenplan/integration/codex-configuration)：Token Plan 的 Responses 路径及 Bearer 使用示例。
- [Responses API](https://mimo.mi.com/docs/zh-CN/api/chat/responses)：input、reasoning.effort、函数工具、SSE、状态与用量；不依赖 previous_response_id、background 或 context_management。
- [列出模型](https://mimo.mi.com/docs/zh-CN/api/model/list-models)及[原始接口文档](https://mimo.mi.com/static/docs/api/model/list-models.md)：GET /models 的 data 数组、id、object、owned_by，以及 Bearer / api-key 认证。
- [错误码](https://mimo.mi.com/docs/zh-CN/api/guidance/error-codes)：认证、访问、限流/额度及服务错误。

设计按这些接口正常实现。通用 API 示例不是套餐连接的实测收据；设计阶段未调用 Token Plan，当前实际 CN /models、Responses、流式及恢复证据见第 11 节，没有换到普通 API。官方 Codex 元数据含其专属工具和提示词，不整体导入，也不覆盖本项目 Agent 定义。

## 3. 当前代码缺口

本节为首次接入前的历史基线；当前原生执行边界及后续兼容路径删除见第 11 节，不表示以下缺口仍全部存在。

| 已有位置 | 已有事实 | 本轮处理 |
| --- | --- | --- |
| `src/agent/model/model-contract.ts` | 已有 ModelClientFactory、ModelClient、ModelSelection.reasoningEffort、增量、完成响应和私有 replayState | 明确为模型适配器支持的协议路径，复用而不重写 Loop；只补通用调用诊断上下文 |
| `src/shared/agent-settings.ts`、`src/shared/model-catalog.ts` | 配置有 model ID、API 模式等，但无 reasoningEffort，也无新连接 kind | 增加新连接标识及模型级 reasoningEffort，完整贯通保存与读取 |
| `src/main/agent-configuration/` | 已有加密凭据、绑定 endpoint、已签发计划和模型发现 | 复用管理边界；在签发计划和发现分派中明确适配器身份，不另建 Key 仓库 |
| `configured-model-factory.ts` | 当前无论模型都桥接旧 AgentGateway，selection 为 configured-gateway，流式能力为 false | 原厂商路径保留；新连接明确进入原生 MiMo 模块，不套旧 Gateway |
| `gateway/openai-responses.ts` | 目前固定 reasoning medium，并聚合 output_text、重排思考/工具内容 | 不作为新适配器默认实现，不复制其有损聚合与固定档位 |
| `create-agent-host.ts` | 已装配 tools，但尚未传入新 Logger | 在新执行宿主中拥有 Logs，给模型和 tools 传入借用 Logger，最后关闭 Logs |
| `ModelManagement.tsx`、`modelCatalog.ts` | 有厂商预设、获取模型和模型高级设置 | 只扩展设置页的连接与强度字段，不切换生产聊天 |
| 生产 `agent:submit` | 目前加载计划后进入旧受理和 Gateway | 识别尚未支持的原生适配器，在受理和写会话前明确拒绝，不能静默走旧 Gateway |

## 4. 模块和公开接口

### 4.1 所有权与依赖

新增 `src/models/`，只提供本轮已确定的连接，不建设服务发现、全局容器或插件框架。SDK、请求转换、流式装配、重放、错误分类和模型发现由模块拥有；配置、凭据来源、Agent 定义和授权由宿主拥有。

建议落点：

| 文件 | 职责 |
| --- | --- |
| `src/models/mimo-token-plan-cn-contract.ts` | 具名选项、发现结果、provider 接口、合法 effort 和固定连接常量；纯协议/元数据，无 SDK 初始化 |
| `src/models/mimo-token-plan-cn.ts` | createMimoTokenPlanCN 功能入口，只发布受支持的完整能力 |
| `src/models/internal/mimo-responses.ts` | 请求/最终响应映射与 SDK 调用 |
| `src/models/internal/mimo-stream.ts` | 流事件装配、稳定位置映射、终结校验 |
| `src/models/internal/mimo-replay.ts` | 版本化私有重放与兼容性验证 |
| `src/models/internal/mimo-errors.ts` | 安全错误分类，不返回 SDK 原始对象 |

内部文件按实际实现复杂度拆分，不能为凑目录造空壳。不新增 index.ts。新模块不得依赖 main、agent-configuration 内部、旧 Agent、Renderer、PPT 或 Electron；使用现有 OpenAI SDK，不再写一套 HTTP/SSE 解析框架。模型协议与 JSON 类型仅从明确支持的 Agent 协议路径导入，不导入 protocol-utils、Registry 或 Loop。

### 4.2 公开形状

已实现的具名公开声明如下；实际协议以 `src/models/mimo-token-plan-cn-contract.ts` 为准：

```ts
import type {
  ModelClientFactory,
} from "../src/agent/model/model-contract";
import type { Disposable } from "../src/agent/protocol-values";
import type { Logger } from "../src/logs/log-contract";

export type MimoReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export interface MimoTokenPlanCNOptions {
  readonly apiKey: string;
  readonly connectionFingerprint: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly logger?: Logger;
}

export interface MimoRemoteModel {
  readonly id: string;
  readonly displayName?: string;
  readonly supported: boolean;
  readonly unsupportedReason?: string;
}

export interface MimoTokenPlanCN extends ModelClientFactory, Disposable {
  listModels(signal: AbortSignal): Promise<readonly MimoRemoteModel[]>;
}

export declare function createMimoTokenPlanCN(
  options: MimoTokenPlanCNOptions,
): MimoTokenPlanCN;
```

实际源文件的相对导入按其目录调整，类型名称和职责保持一致。Base URL 固定为本连接常量，不通过临时参数提供普通 API、其他集群或任意 endpoint 的回退。SDK maxRetries=0，超时来自显式选项；maxOutputTokens 合法范围 1–131072，timeoutMs 为正有限值，apiKey 非空，配置错误在创建时明确拒绝。

- factory.create 使用 `ModelSelection { providerId: "mimo-token-plan-cn", modelId: <远程模型 ID>, reasoningEffort? }`。宿主解析保存的模型配置 ID，不能混为远程 ID；当前 CLI 从 `cli.defaultModelId` 或厂商优先向导取得配置 ID，不再要求 `--model`。
- 模块校验 providerId 和 effort；绑定客户端复制选择，运行中不跟随 UI 变化。未提供 effort 时不加 reasoning 字段，明确设置则发送对应字符串。
- listModels 返回发现结果，不直接改保存配置，不默认挑选或启用模型。对 ID 做长度、去重和数量边界校验，返回上限 2000；空列表作为空结果，不伪造成功候选。
- 模块可内聚小型能力元数据以区分当前支持的对话模型与 ASR/TTS；不把 /models 中每个条目都当成可执行对话模型，不维护“套餐额度/用途”白名单。未知模型 ID 可以保留在发现结果中，缺少适配能力信息时明确显示未支持，不能凭名称猜能力。
- ModelBinding.dispose 只取消/排空本次绑定拥有的请求，不关闭其他绑定或借用的 Logger。provider.dispose 停止新建、取消并排空所属请求与绑定、释放 SDK/凭据引用；不承诺抹除 JavaScript 内存中的所有密钥副本。

## 5. 配置、模型获取与思考强度

### 5.1 持久配置

复用 agent-settings.json 和 credentials.v2.json，不新建独立 MiMo 配置文件，不迁移生产会话库：

1. VendorKind / schema / 设置页预设增加 `mimo-token-plan-cn`。protocol 仍为 openai，模型 API 模式固定 responses，预设地址固定 CN Base URL；该预设不展示切协议/区域的控件。
2. ModelCatalogEntry、模型 schema、ManagedModel、模型草稿和 AgentModelSettings/Selection 增加可选 reasoningEffort。缺省表示默认，持久化时省略；不保存空字符串或自造 default 字符串。
3. MiMo 的强度下拉包含默认与全部合法 effort；保存、重新打开、启用切换、从远程 ID 创建模型、flatten 和配置解析都不得丢失字段。其他厂商不因这次新增字段被统一套用 MiMo 的档位集合。
4. MiMo 连接与非 responses 的组合、未知 effort 在配置边界明确拒绝；原生 provider 创建时校验 maxOutputTokens 为 1–131072，不等到 SDK 请求才失败。共享预算只做通用数值校验，不能因存在 MiMo 连接就限制其他厂商，即使该连接已启用。现有旧配置无新增字段时继续可读，不批量改写用户配置。
5. 现有环境凭据策略不增加全局 MIMO_API_KEY 自动兜底；本连接使用现有连接绑定的已保存凭据，不把另一厂商的环境 Key 发到 CN。Key 前缀不代替服务端鉴权，也不据前缀自动换地址。

建议把合法 effort 和连接元数据放在 models 的纯 contract 文件，供配置校验和 Renderer 使用；该文件不反向依赖 shared，不携带 SDK 或 Node 代码。node tsconfig 包含 models 全部，web tsconfig 只包含需要的纯 contract 依赖。实际构建核验 Renderer 不引入执行实现，而不是用源码字符串测试导入次数。

### 5.2 明确路由，不猜测厂商

在 `ExecutionPlan` 与 `ResolvedRunConfiguration` 使用可选的具名 `modelAdapter`，当前原生值为 `mimo-token-plan-cn`。未声明的旧配置仍可供旧生产入口使用，但不再被新宿主接受；不新增兼容别名。

loadExecutionPlan 根据已保存 vendor.kind 固化 modelAdapter 和 reasoningEffort，resolveRuntime 只接受同一运行时签发的原计划对象并返回对应配置。前端不能通过执行请求临时指定 adapter、endpoint、Key 或自造恢复快照。实际公开字段变更前须检查全部引用与签名消费方。

新宿主只按签发的 modelAdapter 创建已接入的原生 factory。未声明或未接入的适配器在解析凭据前以 MODEL_ADAPTER_UNSUPPORTED 拒绝；不再存在 configured-gateway 兼容执行，也不靠 model.includes("mimo") 或 URL 子串判断。

### 5.3 模型获取端到端

- 保留管理公开 API `management.listRemoteModels()` 和现有 IPC；前端选“已保存厂商”时只发 vendorId，Main 决定凭据和地址。
- 草稿发现请求增加可选 modelAdapter；MiMo 预设由设置页传入已知标识，Main 校验其 protocol/baseURL 一致。未保存草稿仍按现有协议显式提交临时 Key，Main 不回传或持久化该 Key。
- management 内部的发现分派在 MiMo 路径调用同一 models 模块的 listModels，避免执行和发现各写一套 MiMo transport。发现使用短生命周期 provider，finally dispose；原有 OpenAI/Anthropic 发现保持原样。
- 返回结果映射为已有 RemoteModelInfo。用户勾选后才保存模型，保留稳定配置 ID、显示名和 effort；选择查询不得修改默认模型或未经选择自动启用所有条目。
- 默认/缓存目录不能冒充当前连接成功返回；错误明确展示，保留已有草稿，不悄悄改打普通 API 或填入静态列表。手工添加是明确入口，不是失败后的假发现结果。
- 同一地址用于 list 与 execute。接口地址在设计上确定为 CN /models；真实连接返回什么仍需实测，不能用通用 API 文档代替验收。

### 5.4 最小设置 UI 与生产边界

现有 ModelManagement 只新增连接预设、获取模型及模型级 effort；不增加聊天工作台或重新做配置管理。在真实界面验收添加、发现、选择、保存、重开和修改强度。

因为生产 agent:submit 仍进入旧 Gateway，须在 loadExecutionPlan 后、acceptAgentRequest 前检查 modelAdapter。若选择原生 MiMo，明确提示当前生产聊天尚未消费该执行适配，不创建会话或启动旧 Gateway。现有厂商保持原行为；这是维护真实边界，不是切换生产入口。设置中可以保存配置供独立开发入口使用，不能把设置可选等同于生产聊天已接入。

## 6. Responses 请求与最终响应映射

### 6.1 请求

| 通用输入 | MiMo Responses |
| --- | --- |
| system / user 消息 | 按规范顺序构成 input 中的消息项；不额外注入 MiMo 身份提示词，不把多条 system 有损合并 |
| assistant 历史 | 有匹配 replayState 时使用其中保存的有序原始 output 项；避免再次从可见文本重复生成同一历史 |
| tool-result | function_call_output，call_id 匹配原工具调用；按原顺序保留文本，错误标识由适配投影表达，不丢弃工具失败结果 |
| 工具声明 | type=function、name、description、parameters；strict=false，并继续依赖已有本地输入校验，避免强制厂商 strict 子集改变可选字段语义 |
| selection.reasoningEffort | 明确提供时 reasoning.effort 原样发送；缺省省略 |
| request.maxOutputTokens | max_output_tokens；未提供时使用 provider 创建选项的预算 |
| signal | 与绑定/模块关闭信号组合，传入 SDK，覆盖连接、读取流和最终结算 |

只发送已选协议需要的字段。tool_choice=auto；不发送 previous_response_id、background、context_management、固定 summary=auto，亦不添加 Chat 的 thinking 参数。请求使用完整规范历史，不依赖服务端保留会话。

### 6.2 最终响应

- 严格按 response.output 顺序遍历，不使用 output_text 聚合后再重排。message 中每个 output_text 片段、可公开 reasoning 文本片段、function_call 分别映射到规范内容数组。
- function_call.call_id 映射为 callId；不能用 output item 的 id 代替。arguments 最终必须解析成 JSON 对象，且所有调用 ID 唯一。参数残缺、重复 ID、缺失函数名或不支持的工具项使本次模型步失败，不能产生占位调用去执行。
- completed 且存在合法函数调用映射为 tool-calls；completed 且无调用映射为 stop。max_output_tokens 截断映射 length；内容拦截、失败或其他非成功状态报安全错误或 other，沿用内核失败处理，不自动续写或重试。
- usage.input_tokens/output_tokens 映射已有 ModelUsage；reasoning tokens 是 output 的明细，不能再加一次。缓存等详细计数不伪造成套餐 Credits，余额/费用面板不在本轮。
- 公开推理内容与私有 replayState 分开。只映射协议明确提供的文本，不推导或补造思考；空 summary 不等于允许丢弃原始 reasoning 项。

## 7. 流式状态与重放恢复

### 7.1 稳定位置与权威完成

同一投影器用于 generate 和 stream 的最终响应。stream 以 SDK 原始事件为输入，按 output_index + content_index/item_id 管理项，区分 reasoning、message 文本和函数调用：

1. 新项/片段出现时按规范顺序分配本地 content index，随后该片段的 delta 始终使用同一位置；多个工具参数只按自己的 item 追加。
2. 若较早输出项结构尚未确定，先缓冲后面的增量，不能用到达顺序猜最终位置；最终响应的规范内容数组必须与已发送位置一致，不以丢弃或重排位置掩盖差异。
3. 函数参数增量只是观察数据；在最终响应解析和校验成功前，不调用 tools，不把半个 JSON 当结果。
4. 只在流确认正常结算、权威 response.completed 与最终响应验证通过后，产出恰好一个 ModelStreamEvent.completed。某个 output_item.done 不能代替整次响应完成。
5. response.incomplete、失败事件、取消、突然 EOF 或 SDK final response 失败，不补造成功完成；完成后若出现协议上不允许的数据要拒绝。不能把 SDK 意外终止收集到的增量提交成完整历史。
6. 不依赖 SDK 自动聚合私有扩展字段的假设；对照终态 output 做无损结算，结构不一致时明确失败。SDK 官方支持的原始流/聚合能力优先复用，不重写 SSE 分帧器。

### 7.2 重放载荷

使用已有 ModelAssistantMessage.replayState，不新增一套 UI 历史：

- providerId=`mimo-token-plan-cn`；modelId 为远程模型；format=`mimo-token-plan-cn/responses-output`，version=1。
- data 保存有序的、经过结构校验的原始 Responses output 项、对应规范内容校验信息、连接摘要与请求 effort（缺省也保持缺省）。保留精确字符串与厂商必需字段，不 trim、摘要化、拼接或用 JSON.stringify(parsed arguments) 替代原字符串。
- 不把 SDK 完整 response、请求头、apiKey、错误对象或连接运行对象塞进 data。未知且不可安全重放的项明确拒绝，不声称已经支持任意新 output 类型。
- 后续请求中 assistant 历史有 replayState 时，先校验 provider/model/format/version/连接/effort，以及它与该消息规范内容的一致性，再重放原 output；有状态却不匹配就拒绝，不能静默退回可见文本。
- 没有私有状态的纯文本 assistant 可按规范消息直接映射；含 reasoning 或需要原厂商状态的历史不能靠 UI 文本重建。首次请求没有 assistant 私有历史是正常情况。
- 审批等待、重启恢复使用持久化的原工具调用、assistant replayState 和新 Run；不重新请求模型生成一次旧调用，也不自动重做已 dispatched 的影响。

### 7.3 宿主兼容性

复用 HostSessionBinding.schemaVersion=2 的 model（已有可选 reasoningEffort）和 connectionFingerprint，不为字段已能表达的变化增加数据库迁移。原生 selection 使用新的 providerId，自然不能把旧 configured-gateway 会话当成新适配会话恢复。

MiMo 路径摘要包含固定连接、适配器与重放版本、vendor/configuration ID、远程模型、effort 的值或缺省状态、输出预算。保持现有工作区、工具模式、定义/插件版本、步数预算的校验。Key 不进入摘要；同一连接正常轮换 Key 不视为换连接。变更模型、适配器、有效强度或执行版本时，明确拒绝不兼容恢复，不能跟随设置页当前值偷偷改变。

## 8. 日志、错误和关闭

### 8.1 日志归属

- 开发入口/宿主拥有一个 NodeLogs，模型 provider 和 createTools 只借用 Logger。关闭顺序为 application/Agent 排空 → provider 关闭 → stores 关闭 → Logs 最后关闭，初始化失败也按已取得资源逆序回收。
- 模型记录 request.started/completed/failed/cancelled 等诊断元数据：providerId、modelId、所选 effort、请求标识、耗时、状态、分类 code 和计数。不得记录 input、output、思考正文、工具参数/结果、Key 或 replayState。
- 现有 ModelClient 没有 Run/request 上下文。本轮在公开协议增加具名 ModelCallContext（identity、requestId、step），generate/stream 增加第三个可选 context 参数；executeModelTurn 在实际请求边界传入。它只供关联诊断，不进入 messages、SDK body 或检查点，独立消费者可以不传。
- 同步迁移 configured-model-factory 等包装器以传递通用 context，不更改其厂商执行行为。新增可选上下文不是让模型端口接受完整宿主、Logger 管理对象或业务状态。
- 新 MiMo 适配器据 context 绑定 Agent/Thread/Query/Run/requestId/step；SDK 返回的服务请求标识只记录为独立安全字段，不覆盖本地 requestId。tools 继续使用自己的调用上下文。
- logs 的敏感键遮蔽继续生效，文本兜底补充 tp-/ttp- 凭据形态；增加隐私回归，不靠前缀判定凭据有效或切换服务。

### 8.2 失败和重试

模块提供具名 MimoModelError/稳定 code，覆盖配置、模型能力、认证、访问、限流或额度、超时、网络、流不完整、截断、无效响应与重放不兼容。公开消息不拼接 SDK 原文；终端不直接序列化 SDK 异常。

configured-model-factory 在 provider 创建、模型绑定、generate 和 stream 的实际异步迭代边界，将已脱敏的 MimoModelError 转成通用 AgentError，保留安全 code/message 到运行结果和失败检查点。独立 provider 的错误类型不变；内核不识别厂商类型，也不信任任意对象自带的 code/message。

429 在缺少可靠服务错误标识时只报告“限流或额度受限”，不猜为单一原因。401、403、402、421、5xx 等按协议分类。应用层与 SDK 不自动重试、不换连接、不切普通按量 API；Node Fetch 按 HTTP 规范可能内部重传 421，该限制见第 11 节。用户取消保留现有 cancelled，应用/绑定关闭仍按 interrupted 的既有语义处理，不用统一 failed 覆盖取消。

## 9. 实施切片与改动落点

切片按真实依赖推进；每片不以编译空壳作为完成。导出符号改动前检查引用，并同步迁移其实际消费者；不做整轮 M1 或全仓改名。

| 顺序 | 主要落点 | 必须交付 | 验收后才能进入下一片的条件 |
| --- | --- | --- | --- |
| P1：原生 provider | models 公共入口与内部实现；agent/model 通用协议；node 构建包含路径 | 独立创建、模型获取、generate/stream、effort、工具映射、replayState、取消与关闭；不是只有 SDK 调用壳 | 实际 SDK 到自建本地 HTTP/SSE 的消费者烟测通过，含工具参数分片、思考重放和故障 |
| P2：配置与设置 | shared/model-catalog、agent-settings、agent、agent-configuration；Main 配置 runtime/management/discovery；Renderer modelCatalog/ModelManagement/useSettingsController 的实际消费路径 | 新预设、发现、选择、强度持久化、签发 adapter/effort、原计划解析、旧生产受理前保护 | 真实设置界面保存/重开通过，原厂商不受影响；合法配置经公开管理到签发计划不丢字段 |
| P3：开发宿主闭环 | configured-model-factory、create-agent-host、development-runner/command 的必要部分；tools Logger 注入；logs 凭据遮蔽 | 按已保存配置进入原生 MiMo（原 `--model` 参数已由 CLI 默认模型/向导替代）；关联日志、授权与关闭；保留旧配置路径，拒绝新 profile 回落 | 实际 Electron 入口使用本地 HTTP 测试服务完成工具、EOF waiting、重启恢复、拒绝与取消，并核验检查点/租约 |
| P4：真实 CN 验收与文档 | 现有入口、临时工作区、现有凭据、相关文档 | /models、无工具问答、思考+工具闭环、等待后新进程恢复、取消；记录精确模型与场景 | 事先说明 API 用量并使用已授权配置；实际 CN 结果通过后才写厂商验收完成 |

P2 的管理验证需使用真实 Electron safeStorage 能力时，按现有集成设施运行，不引入 Node 假解密。草稿/模型列表 UI 不等于生产聊天切换；不在本轮增加聊天页或 PPT UI 迁移。

### 9.1 回归与烟测清单

- 新增模型消费者回归建议为 `tests/mimo-token-plan-cn.test.ts`：真实 SDK 到自建服务，核对请求路径/认证/effort、规范顺序、工具 ID 与参数、重放、终态及错误，避免只断言 mock 回显。
- 更新已有 `agent-configuration`、`model-catalog`、`model-management`、`general-agent-host`、`general-agent-host-binding`、开发宿主与 CLI 集成测试的受影响契约；文件是否改动由实际引用决定，不预先改遍无关测试。
- 不同 effort 值均验证请求保留原值；默认验证字段缺省，不检测所谓实际“强度差异”，不合并档位。未知值在调用前拒绝且不发请求。
- 发现验证正常/空/重复/非法 ID/认证失败/超时，失败不换域名或填静态结果；保存和重新打开后 model ID、配置 ID、effort 都正确。
- 流式验证多个工具交错参数、reasoning 与文本多个片段、缺少整体完成、重复完成、数据在完成后到达、取消和异常 EOF；已展示增量不能变成错误的持久成功。
- 临时工作区包含随机校验码和真实文本文件，审批前不读取，批准后使用真实结果；写入后对照磁盘，拒绝/取消不泄漏内容，日志失败不抹去 applied。
- EOF 保留 waiting 后以新进程、新 runId 继续原 Query；校验已保存调用、完整重放、最终检查点和租约释放。恢复遇到已 dispatched 无结果时仍为 unknown，不重做影响。
- 地址、adapter、远程模型、effort 或输出预算变化拒绝恢复；同连接 Key 轮换可继续，密钥不出现在绑定/检查点/公开诊断。
- Settings 的新 profile 若被旧生产 agent:submit 选中，应在会话受理前拒绝；老 profile 的运行与发现行为回归不变。

### 9.2 命令与证据层次

实现时运行相关回归、`npm run typecheck`、本次修改文件的 `npx biome check`、`npm test` 和必要构建。设置 UI 变更必须在实际页面交互验证；开发入口变更必须跑 `tests/general-agent-development-cli.integration.test.ts` 及真实入口，不以 --help 成功替代执行。

明确分开受控模型、本地真实 SDK/HTTP、真实 Token Plan 三类证据。远程验收不是当前设计任务的授权调用；未来执行前说明模型、场景与用量，使用现有凭据，不复制或打印 Key，不自动换厂商。/models 和代表性 high 可先小范围验收，其余 effort 的参数映射由本地请求证据覆盖，不为证明同一映射扩大远程调用。

每个切片只清理自己创建的进程、工作区、测试会话和临时构建；不删除共享配置、历史日志、生产数据库或其他人的记录。通过后同步 README、当前计划与整体规划中的实际状态；没有运行的模型/界面/恢复场景不得写成已验收。

## 10. 完成标准

- [x] 独立 MiMo 模块不依赖旧 Gateway、Electron、应用配置或业务领域，并通过公开入口真实执行。
- [x] CN /models 可从管理界面获取，选择保存后能供独立开发宿主使用；失败明确，无隐藏替代。
- [x] 思考强度从设置、保存、签发、selection 到 reasoning.effort 全链路保留，默认不发送字段，不增加档位特殊处理。
- [x] 非流式、真实流式、有序文本/推理/函数调用和用量映射正确；失败、截断和取消不被提交为成功。
- [x] 私有 output 重放完整，工具审批和跨进程恢复保持 Query、新 Run、原调用与副作用不变量。
- [x] provider、binding、宿主和 Logs 的所有权与关闭顺序有实际证据，tp-/ttp- 凭据不进入诊断。
- [x] 旧生产聊天未切换，尚未消费原生 profile 的入口受理前拒绝，现有其他厂商保持原行为。
- [x] 设置 UI、独立开发入口、本地协议和实际 CN 验收分别报告结果与限制，相关文档更新，临时数据清理。

以上完成标记表示本轮确定范围的实现与下面列明的验证，不扩大为全部模型、远程档位或生产 UI 的验收。

## 11. 实施与验收记录（2026-10-31）

### 11.1 实现落点

- `src/models/mimo-token-plan-cn.ts` 与纯 contract 提供完整创建/发现/绑定/关闭入口；内部内聚 Responses 映射、无损重放、流式稳定位置和安全错误。固定 CN 地址，不提供任意 endpoint 参数。
- `ModelClient.generate/stream` 的第三个可选 `ModelCallContext` 由真实模型调用边界传入，只供日志关联。配置模型包装器同步转发，不改旧 Gateway 的执行语义。
- shared 配置、管理与签发计划、模型发现和设置组件保留 adapter/effort；MiMo 不借用其他连接的环境凭据，不自动挑选发现模型，不落入旧 Gateway fallback。旧生产提交在受理/会话写入前拒绝。
- `prepareConfiguredModel` 根据签发 adapter 选择原生 provider，远程 model ID 与配置 ID 分离；原生恢复摘要覆盖适配器/重放版本、连接、配置/厂商、远程模型、effort 与输出预算。同连接 Key 不进入摘要。
- 开发宿主拥有 NodeLogs，向模型/tools 借用 Logger，按 application → provider → stores → Logs 关闭；诊断位于开发数据根的 `agent-development-logs`，不迁移旧日志管理。

### 11.2 本地协议与入口证据

- `tests/mimo-token-plan-cn.test.ts`：52 项通过，真实 OpenAI SDK 到自建 HTTP/SSE；覆盖默认/8 档 effort、固定路径/Bearer、规范顺序、多个工具交错参数、公开推理与私有扩展字段、精确重放、内容一致性、未知能力、畸形发现、认证/访问/额度/服务错误、超时/网络、异常 EOF、缺失/重复完成、完成后数据、截断、取消与所有权排空。测试只在 fetch 边界转发固定 CN URL，不开放生产 endpoint。
- `tests/mimo-development-cli.integration.test.ts`：真实 Electron、真实 safeStorage、真实管理 API、SDK/HTTP/SSE 和实际 `development-runner`。EOF 保留 waiting；新进程批准后读取审批之后写入的随机校验码；同 Query 使用新 Run。拒绝/取消无文件内容，effort/预算变化在模型请求前拒绝恢复；同连接加密凭据轮换后仍可恢复，后续 HTTP 使用新 Key。终态检查点及租约释放有直接核验。
- 同一入口回归读取真实 JSONL，核验模型 request/step/Query 与工具 callId 关联，凭据、私有推理和文件校验码均不进入日志。旧 `general-agent-development-cli.integration.test.ts` 单独通过。
- `npm run typecheck`、`npm run build` 通过；本次 36 个受支持代码/配置文件通过 Biome 检查。`npm test`：189 个文件通过，1533 项通过、2 项按现有条件跳过；不包含 integration 文件。

### 11.3 实际设置组件与真实 CN

- 在隔离 Electron 窗口加载实际 `ModelManagement` 组件，使用实际管理 IPC、预加载 API 与 safeStorage；临时页面只负责挂载与回调，不替换组件、管理模块或 SDK。未把该证据称为整个生产 Settings/聊天工作台的切换。
- 本地 HTTP 发现验证：固定只读 CN 地址，无协议/区域切换，未知能力禁选；Flash 勾选、high 保存/重开、追加 Pro 保留 Flash 配置 ID/effort、启用切换、默认省略字段均通过，已观察截图。
- 同一实际组件再访问真实 CN `/models`，返回 `mimo-v2.5-asr`、`mimo-v2.5-tts`、`mimo-v2.5-tts-voiceclone`、`mimo-v2.5-tts-voicedesign`、`mimo-v2.6-flash`、`mimo-v2.6-pro`；四个语音条目禁选。勾选 Pro 保存并重开，Flash 的 high 与配置 ID 保留，Pro 缺省 effort。
- 真实推理只调用 `mimo-v2.6-flash` / `high`：非流式返回精确 `MIMO_CN_OK`（input=19、output=20）；真实 stream 观察增量后取消，没有 completed。实际宿主文件调用先落 waiting 并释放租约；审批后新 Electron 进程完成，同 Query/新 Run 返回随机文件校验码，原始工具/推理 output 重放成功，终态 completed 与租约释放已核验。另一次审批取消落 cancelled 并释放租约。
- 使用现有 CN 连接经公开 `runtime.loadExecutionPlan/resolveRuntime` 解析凭据，未打印 Key。首次隔离 userData 下解密被真实 safeStorage 拒绝，随后使用原连接所属的真实 Electron userData 解析；临时开发配置只保存加密凭据，源 `agent-settings.json` 对照不变，未修改已有 custom 连接类型。真实宿主诊断共 7 条，6 条模型日志带请求关联，未含校验码或凭据形态。

### 11.4 已知边界

- 无应用层或 SDK 重试（`maxRetries=0`），无域名/区域/按量 API 回退。Node Fetch/Undici 按 WHATWG Fetch 规则可能对 421 内部重新建连重传，不能承诺底层 HTTP 从不重传。回归区分一次 SDK fetch 与两次底层 HTTP 421，并单独验证 SDK 边界的安全错误分类；未为绕过标准行为新增 transport 框架。
- 已知对话能力元数据还包含官方文档列出的 `mimo-v2.6-pro-ultraspeed`，但本次实际 `/models` 未返回该项。Pro、ultraspeed 与除 high 外其他 effort 的远程执行未验收；全部合法 effort 的原值传递由本地请求证据覆盖。
- 真实远程恢复通过宿主公开创建/运行/恢复入口验收；真实开发 CLI 的 EOF/管道输入、拒绝/取消及跨进程机制由本地 HTTP 集成覆盖，不混称为完整真实远程 CLI 验收。写入/编辑业务没有另做本次远程调用，现有五工具回归保持通过。
- 生产聊天/PPT/生产会话与旧 Gateway 未迁移。原有 custom 连接在旧生产入口仍按原 kind 路由，在新开发宿主则明确拒绝；需在设置中选择已接入的原生 MiMo 预设，不能仅凭 URL 或模型名称隐式升级。
- 本次临时窗口、Vite 服务、HTTP 服务、脚本、独立构建、加密开发配置、SQLite 和工作区均已清理；未删除共享数据库、源配置或旧日志。

### 11.5 审核后修复

- 旧 v1/v2 浏览器模型目录迁移排除原生 MiMo 的 URL 自动推断，Chat 与 Responses 连接都保持 custom；显式保存的原生预设保持原身份。
- 宿主错误转换覆盖创建、绑定、非流式与真实流式执行。新增本地 HTTP 401/429 回归直接核验公开运行结果、失败检查点和租约释放；不暴露 SDK 原文或凭据。无效预算与不支持模型在 HTTP 请求前被安全拒绝。
- 移除共享设置中 MiMo 专属的全局预算上限；管理回归覆盖空、禁用和启用的 MiMo 连接与其他厂商共存，预算保存、重开与其他模型配置解析不受影响。实际执行 MiMo 仍使用 provider 原有预算校验。
- 临时烟测调用实际 initializeAgentSettings，desktopApi 管理边界受控并使用真实设置 Schema：旧 Chat/Responses 均初始化成功，保留 custom 和配置 ID。真实 SDK 到本地 HTTP 的宿主烟测确认 AUTHENTICATION 贯通，超限 MiMo 预算在请求前拒绝；临时构建、服务和数据已清理。
- 本次验证：npm run typecheck 通过；7 个受影响代码文件通过 Biome；npm test 为 189 个文件、1541 项通过，2 项按现有条件跳过，其中 MiMo 回归为 57 项。mimo-development-cli 与 general-agent-development-cli 两个实际 Electron 集成通过。
- 本次未调用远程模型，未切换生产 UI、移除旧 Gateway 或扩展宿主状态管理；不扩大第 11.3 节的实际 CN 验收范围。

### 11.6 删除 Gateway 兼容路径

- 删除 `src/main/agent-host/gateway-model-factory.ts`，以及 configured-model-factory 中的旧 Gateway 创建、消息/重放桥接、日志上下文包装和兼容模型生命周期；开发 runner 不再设置旧 Gateway IO 归档开关。
- 原生准备入口在签发计划检查后、resolveRuntime 之前拒绝不支持的配置。包括相同 CN URL/模型名的 custom Responses、Chat 和 Anthropic 配置，均不解析凭据、不发 HTTP，不隐式升级或回退。
- 删除只覆盖已移除桥接实现的网络测试，保留通用 SQLite/CAS/租约行为测试。开发宿主的既有文件读写、搜索、逐次审批、拒绝、模型/工作区绑定、密钥轮换、关闭中断与恢复场景迁到原生 MiMo SDK/本地 HTTP/SSE。
- 两个 Electron 集成使用测试专用入口，在加载真实 development-runner 前安装固定 CN 到 loopback 的失败关闭转发。保留真实 safeStorage、EOF waiting、新进程批准与私有 output 重放验证；general CLI 集成不再通过 Node 启动器的实际 stdin 管道运行，覆盖的是 runner 的 ready/input/end IPC。实际 Node 启动器另运行 agent:dev -- --help，只证明构建、加载和帮助退出，不将其称为完整管道验收。
- 独立宿主烟测确认：不支持配置在凭据解析前拒绝；原生文件调用落 waiting，重建宿主后以同 Query/新 Run 批准完成，最终检查点 completed、待决状态清空且租约释放。
- 本次验证：npm run typecheck 通过，9 个受影响代码文件通过 Biome；npm test 为 189 个文件、1585 项通过，2 项按现有条件跳过。两个真实 Electron 集成通过，实际 Node 启动器帮助烟测正常退出；临时宿主、工作区、HTTP 服务和构建目录已清理。
- 本轮不切换生产 UI，不删除旧生产 Agent/Gateway，不迁移其历史会话；也不增加其他厂商适配器或调用远程模型。
