# 模型包：单包多厂商适配计划

[返回计划目录](README.md) · [项目整体规划](../project-plan.md)

状态：P1–P6 的原 MiMo 包抽取已实施并完成本地验收，证据见第 12 节；后续已补齐旧 Gateway 三种协议，当前支持与分层证据见第 13 节。第 1–11 节保留首轮方案，不将并行 M3-A 工作计入模型包交付。

## 1. 目标与决策

建立一个私有 workspace 包 `@agent-harness/models@0.1.0`，目录为 `packages/models/`。它内聚多厂商模型适配的公共创建面、必要协议、能力资料和具体实现，不按厂商建立独立包。

首轮迁移现有 MiMo Token Plan CN，实现单包结构及统一调用面；后续厂商以包内适配器模块加入。首轮只支持 MiMo 是实现事实，不代表设计只允许 MiMo；不能加入空的 OpenAI/Anthropic/DeepSeek 适配器或提前暴露未实现 ID。

关键决策：

- 一个模型包、一个受控创建入口，厂商是内部模块，不是发布单元。
- 执行消息、模型客户端、绑定和注册端口继续归 `@agent-harness/core/model/model-contract`，不复制或迁走。
- 模型包拥有适配器创建、能力描述、发现能力、SDK 转换及安全错误；宿主拥有凭据来源、已签发配置、连接身份和执行预算。
- 浏览器安全的能力资料与 Node/SDK 创建链分开导出。
- 不新增 IoC 容器、服务定位器、动态插件扫描、可变全局注册表、第二个 Gateway 或备用模型回退。

## 2. 已核实的当前边界

| 当前代码 | 当前事实 | 计划处理 |
| --- | --- | --- |
| `src/models/mimo-token-plan-cn.ts` | 提供 MiMo 创建、发现、绑定、generate/stream、取消与关闭；内部使用 OpenAI SDK | 迁入包内 MiMo provider，由统一创建入口选择 |
| `src/models/mimo-token-plan-cn-contract.ts` | 混合常量、支持型号、思考强度、创建选项及提供方接口 | 拆分到包公共类型、纯能力资料与私有 MiMo 实现 |
| `src/models/internal/mimo-*.ts` | 请求/响应投影、流式、私有重放及 SDK 错误分类 | 保持算法和协议，迁入 MiMo 私有目录 |
| `configured-model-factory.ts` | 使用原签发计划解析凭据，计算连接指纹，固定模型选择/步数，转换安全错误 | 保留宿主职责；改消费统一模型创建及错误入口 |
| `agent-configuration/internal/model-discovery.ts` | 原生 MiMo 走适配器；旧 OpenAI/Anthropic-compatible 发现另有实现 | 只迁移原生适配器分支；旧发现链保留，不把它们冒充已实现的新适配器 |
| `src/shared/`、renderer 的模型目录及管理组件 | 直接消费 MiMo 常量、能力与思考强度 | 改消费纯能力资料，不能导入 SDK 创建入口 |
| Core `ModelRegistry` | 已按 `ModelSelection.providerId` 注册与选择 `ModelClientFactory` | 保持唯一运行时模型注册机制，包内不复制 |

不能只迁移开发宿主：配置管理、运行配置、发现、shared schema、renderer 和测试夹具都是现有调用方。

## 3. 模块职责与依赖方向

依赖方向：宿主 → models → Core 模型端口 / logs 窄协议 / SDK。Core 不依赖 models；models 不依赖应用、Electron、PPT、SQLite、shared 配置或 UI。

| 所有者 | 职责 |
| --- | --- |
| Core | `ModelSelection`、消息/内容、请求/响应、能力、私有重放容器、客户端/绑定/工厂/注册端口，以及 Loop 的通用执行语义 |
| models | 内建适配器身份与选项、创建与关闭、可选发现、能力资料、厂商 SDK 转换、私有重放解释和安全错误 |
| 应用宿主 | 凭据解密和轮换、配置持久化与原计划对象、模型选择、连接指纹、Query 步数预算、授权和公开错误投影 |
| logs | 通用诊断记录；models 只借用 Logger，不创建或关闭日志系统 |

`createModelProvider()` 的分派是“按适配器配置创建一个实例”；Core 的注册是“执行时按 providerId 取得绑定”。二者不是两套注册表。工厂使用明确的静态分支，不提供运行时 register/unregister。

单包意味着统一版本与依赖闭包：新增厂商 SDK 会增加包的安装体积，这是接受的代价。通过精确入口和按所选适配器加载 SDK，避免浏览器或未选厂商承担运行时加载成本；不以此重新拆回一厂商一包。

## 4. 文件落点与完整公开面

```text
packages/models/
  package.json
  tsconfig.json
  build.mjs
  src/
    models.ts
    model-contract.ts
    model-profiles.ts
    model-errors.ts
    internal/
      create-provider.ts
      profile-catalog.ts
    providers/
      mimo-token-plan-cn/
        provider.ts
        profile.ts
        errors.ts
        responses.ts
        stream.ts
```

公开入口只做契约声明和必要导出，默认创建及资料装配留在模块内部。第一轮 manifest 只允许下列四个精确子路径；没有根导出、通配、`index.ts`、源码别名或厂商独立包。

| 子路径 | 对外内容 | 平台约束 |
| --- | --- | --- |
| `@agent-harness/models/models` | `createModelProvider(options, signal)` | Node 创建入口；只加载选中的真实适配器 |
| `@agent-harness/models/model-contract` | 具名创建选项、适配器 ID、提供方与发现结果等类型 | 仅依赖 Core/logs 的公开类型，无 SDK/Node 类型泄漏 |
| `@agent-harness/models/model-profiles` | `getModelProfile(adapterId)`、`getModelSupport(adapterId, modelId)` 及其具名类型 | 纯资料与判断；不读取凭据、不联网、不创建 SDK、不进入 Node 实现闭包 |
| `@agent-harness/models/model-errors` | `ModelProviderError` 与具名错误码类型 | 安全公共错误，不暴露 SDK 异常 |

`providers/*`、请求构造、流投影和 SDK 对象不对外导出。将来新增厂商扩展内部模块、选项联合及资料分派，不增加厂商 workspace 或强迫调用方导入厂商工厂。

## 5. 统一创建与扩展协议

以下为计划接口，不是已经存在的 API：

```ts
export interface ModelProviderConnectionOptions {
  readonly connectionFingerprint: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly logger?: Logger;
}

export interface MimoTokenPlanCNOptions extends ModelProviderConnectionOptions {
  readonly adapterId: "mimo-token-plan-cn";
  readonly apiKey: string;
}

// 当前只有已实现的 MiMo；以后加入已实现适配器的具名选项联合。
export type ModelProviderOptions = MimoTokenPlanCNOptions;
export type ModelAdapterId = ModelProviderOptions["adapterId"];

export interface DiscoveredModel {
  readonly id: string;
  readonly displayName?: string;
  readonly supported: boolean;
  readonly unsupportedReason?: string;
}

export interface ModelDiscovery {
  listModels(signal: AbortSignal): Promise<readonly DiscoveredModel[]>;
}

export interface ModelProvider extends ModelClientFactory, Disposable {
  readonly adapterId: ModelAdapterId;
  readonly discovery?: ModelDiscovery;
}

export function createModelProvider(
  options: ModelProviderOptions,
  signal: AbortSignal,
): Promise<ModelProvider>;
```

这里的 `ModelClientFactory`、`Disposable` 和 `Logger` 分别直接引用 Core 与 logs 公开协议，不再定义另一套消息或生命周期。

### 5.1 为什么使用判别联合

公共配置不采用 `provider: string + Record<string, unknown>`，也不把所有厂商强塞进 OpenAI 的 apiKey/baseURL 形状。共享字段表达调用策略，认证字段及连接限制由适配器自己的具名选项承担。当前 MiMo 仍固定 CN 地址，不开放任意 endpoint。

新增厂商时才扩展联合和运行时校验；未实现 ID 即使经 JS/JSON 绕过类型检查，也必须显式拒绝。不能通过模型名称、URL 包含关系或底层 SDK 名字猜适配器。

### 5.2 创建、加载与取消

工厂采用异步签名，按已验证 adapterId 的明确分支，以字面量 `import()` 加载所选适配器。不是动态插件发现，不接受用户拼出的模块路径；没有重试、缓存实例或后台队列。

在第一次 await 前固定经过校验的原始值及借用 Logger 引用，避免调用方在加载期间改动 options。创建前、加载后及发布前检查 signal；创建不能发起发现、推理或预热请求。若已经取得实例但创建被取消或发布失败，必须等待 dispose 后拒绝，不泄漏晚到资源。

宿主在 await 返回后先把 provider 纳入自己的失败清理范围，再检查取消或执行后续步骤。创建 signal 不自动变成提供方永续取消信号；发布后的资源归拥有者管理，请求/绑定继续使用各自信号。

### 5.3 发现是可选能力，不是假成功

MiMo 的 `listModels()` 迁入 `provider.discovery.listModels()`。未来不能列举模型的适配器不提供 discovery；调用方明确报告“该适配器不支持发现”，不能返回空数组伪装远程列表为空。真实发现到的未知型号仍保留且明确 unsupported。

### 5.4 纯能力资料不等于远程可用性

`getModelProfile()` 对未知 adapterId 返回 undefined。资料包含适配器 ID、展示名称、连接协议、已知连接限制及适配器上限；不得包含 Key、应用 vendorId 或实例状态。

`getModelSupport()` 对已知适配器返回具名支持结果：supported/unsupportedReason、复用 Core 的 `ModelCapabilities`、允许的 reasoningEfforts 及必要预算限制；未知适配器返回 undefined。MiMo 保持现有型号与思考档位，不把单一白名单机制强加给未来所有厂商。

这些判断表示本地适配器支持范围，不证明远程模型存在、账户有额度或套餐可用。列表接口返回的 supported 含义必须与同一适配器资料一致。资料入口不能导入 Node 工厂，即使只为“复用一个常量”。

资料协议的最小具名形状如下；`protocol` 只描述传输，不用于推断适配器或选工厂。endpoint 可选，以免把未来所有认证/连接形式都限制为固定 HTTP URL：

```ts
export type ModelEndpointPolicy =
  | { readonly kind: "fixed"; readonly url: string }
  | { readonly kind: "configurable"; readonly defaultURL?: string };

export interface ModelAdapterProfile {
  readonly adapterId: ModelAdapterId;
  readonly displayName: string;
  readonly protocol: string;
  readonly endpoint?: ModelEndpointPolicy;
  readonly maxOutputTokens?: number;
}

export type ModelSupport =
  | { readonly supported: false; readonly unsupportedReason: string }
  | {
      readonly supported: true;
      readonly capabilities: ModelCapabilities;
      readonly reasoningEfforts: readonly string[];
      readonly maxOutputTokens?: number;
    };

export function getModelProfile(adapterId: string): ModelAdapterProfile | undefined;
export function getModelSupport(
  adapterId: string,
  modelId: string,
): ModelSupport | undefined;
```

## 6. 错误、身份与持久化不变量

### 6.1 一个模型包公共错误边界

对外使用唯一 `ModelProviderError`，包含已审查的 code、message 及可用时的 adapterId。初始错误码保留现有 MiMo 分类，并为创建边界增加明确的 `ADAPTER_UNSUPPORTED`；不改既有执行错误码及 MiMo 已有安全消息。未知适配器错误不得回显任意原始 options。

SDK 异常到安全错误的分类留在具体适配器；不保存 SDK error、原始响应、头、cause 或凭据。消息只能来自受控的静态映射；`instanceof` 本身不是任意字符串已脱敏的证明。

现有公开 `MimoModelError` 和 `mimoAgentError()` 调用方迁移为公共错误及通用转换，旧公开类/别名删除；内部仅保留有真实分类职责的 MiMo 错误逻辑，不新增空壳继承。宿主统一把已识别安全错误映射到 AgentError，未知异常仍隐藏。新增厂商不再增加一套宿主 instanceof 分支。

### 6.2 四种身份不能混用

- 应用 vendorId/configuredModelId：配置与凭据管理身份，留在宿主。
- adapterId/modelAdapter：本次选择的原生适配器；MiMo 仍为 `mimo-token-plan-cn`。
- Core `ModelSelection.providerId`：执行路由身份，MiMo 仍使用上述值，不改成 `openai`。
- transport protocol / SDK：传输实现选择，使用 OpenAI SDK 不代表 providerId 属于 OpenAI。

### 6.3 必须保持的内容

- `mimo-token-plan-cn`、固定 CN URL、现有支持型号及思考强度词汇。
- 宿主连接指纹的字段、规范顺序与实际输出；仅改常量来源不能改变旧指纹。
- `mimo-token-plan-cn/responses-output`、私有重放版本与数据含义。
- 有序工具调用及其结果、模型可见消息和权威完成响应结算。
- SDK maxRetries=0、当前超时/取消/截断/缺失完成响应的处理，不扩大 SDK 调试或正文日志。
- v2 binding、检查点版本、数据库结构、定义/插件版本及旧 Electron 数据位置。

公开工厂/错误 API 的切换必须完整迁移，但不构成上述持久化协议变更；若实施确实需要改变重放含义，必须另行设计版本与迁移，不能混入搬包。

## 7. 宿主与所有调用方迁移

| 调用方 | 迁移内容 | 保持的边界 |
| --- | --- | --- |
| `src/main/agent-host/configured-model-factory.ts` | 统一创建、类型、资料与安全错误；支持判断在凭据解析前完成 | 原签发计划对象、凭据解析、连接指纹、固定 selection、步数预算与资源所有权留在宿主 |
| `src/main/agent-configuration/internal/model-discovery.ts` | 原生分支使用同一创建入口与 discovery，finally 关闭 | 保留旧 compatible 发现分支，不迁移旧 Gateway/厂商 SDK 全部逻辑 |
| `agent-configuration/management.ts`、`runtime.ts`、`types.ts` | 迁移资料来源与已实现适配器 ID 类型 | 不扩大已签发/已实现 ID 范围；不将配置包改为依赖 models 私有文件 |
| `agent-host/development-command.ts`、`development-setup.ts` | 使用纯资料判断已支持型号、连接和思考强度 | 向导、CLI 命令、未知项拒绝和安全展示语义保持 |
| `src/shared/agent-configuration.ts`、`agent-settings.ts` | schema 使用已实现资料，不再引用 src/models | 不持久化完整提供方配置；原设置与凭据格式不变 |
| `src/renderer/src/modelCatalog.ts`、`components/ModelManagement.tsx` | 仅消费 model-profiles 和必要类型 | SDK、Key 和 Node 创建入口不能进入 renderer；现有思考强度保存/重开保持 |
| `tests/mimo-token-plan-cn.test.ts` 等模型/配置/UI/发现行为测试 | 改用公共创建、资料与错误，覆盖真实协议与能力结果 | 不重钉源码路径、构造器名称或简单转发；已有仅实现措辞/转发的测试删除而非换名重钉 |
| `tests/fixtures/general-agent-configuration-seed.ts`、`mimo-development-entry.ts` | 纯资料和统一入口来源 | 固定生产 endpoint，仅测试入口控制本地传输；不把测试入口或假响应装进包 |
| node/web tsconfig、Vitest、构建监听与 Electron 文件集 | 消费第三个包的 emitted JS/声明；删除 src/models 直接 include | 沿用现有 workspace 构建/监听机制，不再造一套启动器 |

还需迁移 `agent-configuration-contract`、`agent-configuration`、`development-setup`、`general-agent-development-host`、`model-management`、`remote-models` 等现有测试中的导入与 mock 边界。尤其不能仅把 `remote-models` 的旧工厂 mock 改名后当成真实 SDK 验收。

切换后删除原 `src/models/` 模型实现和旧路径，不保留厂商工厂兼容出口。旧生产 Agent 的 Gateway、发现实现和正文归档不属于本轮删除范围。

## 8. 后续新增厂商的固定步骤

1. 在同一个 models 包内增加真实适配器模块及纯资料，完成自己的请求、响应、流式、错误和重放规则。
2. 在公共选项联合、纯资料分派和内部创建分支中登记已实现 ID；没有公开动态注册 API。
3. 实现 Core 的模型端口；有发现才提供 discovery，不以空流、假结果或降级替代缺失能力。
4. 如宿主启用该适配器，再增加对应配置 schema、凭据解析和预设；只新增包实现不自动取得宿主权限或改造旧用户连接。
5. 迁移/新增其真实 SDK 到本地 HTTP/SSE 回归，证明该适配器真实契约。远程验收按已测型号单列。

允许包内部不同 SDK、不同认证字段与不同私有重放格式；不允许复制完整模型包、改 Loop、靠 modelId/URL 猜能力，或为了复用而强制所有请求走 OpenAI 格式。

## 9. 构建、发行与依赖门禁

- Node >=24、私有 ESM-only、独立 NodeNext JS/声明构建，内部相对导入显式 `.js`，prepack 构建，files 只包含 dist 与必要清单。
- 初始正式依赖为同版本 Core/logs 与现有 OpenAI SDK；TypeScript 和 Node 类型为开发依赖。只在声明中引用的工作区包也必须正确声明，不能依赖根目录偶然 hoist。后续 SDK 加入同一包依赖，不拆厂商包。根应用的 OpenAI/Anthropic SDK 若仍被旧 Gateway 或 compatible 发现消费，继续保留对应依赖，不能因原生 MiMo 搬包一并删除。
- 根目录增加 models workspace 和依赖、build/verify 命令及锁文件；扩展现有 `build:packages`、`workspace-build.mjs`、Main 产物监听与精确发行文件集。
- 增加模型包解析门禁并接入现有 typecheck/build：只允许四个公开入口；普通消费者不得相对导入源码、dist 或 providers；Core 不得反向依赖 models。
- 对 model-contract、model-profiles、model-errors 的源码、JS、声明闭包做平台检查；renderer/shared 不得解析到 SDK 或 Node 创建链。检查类型导入、三斜线引用、别名和明确的动态加载目标，不用 import 次数或源码字符串代替边界。
- SDK 错误和私有重放不能出现在公共声明；真实 tarball 不能依赖 src、Vite alias、tsx 或仓库 node_modules 链接。独立消费安装 models/Core/logs 的真实 tarball 及完整运行依赖闭包，不靠外部网络补包。

## 10. 实施顺序与验收门槛

| 顺序 | 实施内容 | 本步完成门槛 |
| --- | --- | --- |
| P1 | 在改动前建立现有包名下的 MiMo waiting 基线，记录绑定、重放、Query/Run 和租约；确认所有调用方 | 有可由新进程恢复的真实权威记录，不用手写快照冒充旧数据 |
| P2 | 建立单个 models 包，统一类型/错误/资料/创建及 MiMo 私有实现 | 四个真实入口可消费，工厂只支持已实现 ID；没有第二个注册中心或厂商空壳 |
| P3 | 一次迁移配置、发现、宿主、shared、renderer、测试及夹具，删除旧路径 | 所有调用方使用受控产物，资料不带入 SDK，旧错误/工厂路径无别名 |
| P4 | 接入第三个 workspace 的构建、监听、门禁和 Electron 发行 | 从正常入口可构建/启动，边界正反例阻止私有绕过、平台污染与反向依赖 |
| P5 | 原生 Node/SDK 本地 HTTP/SSE、UI 实际设置面、旧 waiting 新进程恢复 | 发现及思考强度保存/重开、工具消费、流式结算和审批恢复保持，绑定指纹/重放不被搬包改变 |
| P6 | 真实 tarball 仓库外安装和实际 Electron ASAR 消费 | 四入口及完整依赖闭包真实存在；新工厂产生的错误与公开类同一身份；无源码/链接回退；随后清理本轮临时资源并记录证据 |

必须运行的行为矩阵：

- 创建未知适配器和能力不支持的型号明确拒绝；宿主不为未知适配器解析凭据。
- 有效 MiMo 发现、未知远端型号、空远端列表及缺少发现能力的明确拒绝，不混淆这些状态。
- create/generate/stream 的输入与输出、ordered tools、reasoning 和私有重放；仅 completed 提交权威响应，截断/缺失完成不能成功。
- 配置快照、懒加载期间取消、晚到实例回收、独立 bindings、提供方关闭排空、借用 Logger 不关闭。
- 安全错误与 SDK 日志隔离；已知 MiMo 分类/消息保留，未知异常不外泄。
- MiMo 的固定 CN 地址与无业务重试保持；本地 HTTP/SDK 证据不等同远程厂商模型验收。
- NodeNext 运行侧及 Bundler/DOM 资料侧声明消费，`skipLibCheck: false`，资料侧 `types: []`；资料实际浏览器消费与生产 renderer 构建不得包含 Node/SDK 创建链。
- SDK 的真实 `/models` 与 Responses 本地传输、真实 Electron 设置管理/safeStorage 及 CLI EOF waiting/new-process resume；旧基线最终 completed、Query 不变/Run 更新、租约释放。

沿用现有模型/配置/工具/CLI 集成回归，更新因公共契约切换而失效的行为测试。新增永久测试只用于未知适配器、缺失发现、创建取消/晚到资源等新增且不确定的边界；不为搬目录、四个导出或简单转发新增快照测试。不将普通关闭等机制单独扩大为整个 M3 可靠性项目。

当前唯一真实适配器支持 discovery；缺失 discovery 的消费侧拒绝可用窄端口夹具验证，但不能把该夹具登记为内建适配器或计入厂商支持清单。第二厂商的 SDK、认证及重放扩展性必须等真实实现后另行验收。

## 11. 非目标与交付判定

不同时实现第二厂商、不迁移旧 Gateway 全部适配器、不改变旧配置身份/凭据数据、不引入远程遥测/自动重试/备用模型/并行工具，不切生产 PPT 聊天，不删除未迁移的旧生产代码。

交付成立必须同时满足：一个多厂商定位的真实包、统一创建与资料/错误边界、所有现有 MiMo 调用方切换、纯资料平台隔离、真实独立安装和宿主消费、旧会话恢复。只有目录搬迁或一个厂商工厂转发文件不算完成。

这份计划未验证未来任何第二厂商实现。后续通过本包新增真实适配器证明扩展，不用假 provider、占位出口或扩大本轮远程用量来宣称“已支持多厂商”。

## 12. 实施与验收记录

### 12.1 实际落地

- 新增单个私有 `@agent-harness/models@0.1.0` workspace，位于 `packages/models/`；仅公开 `models`、`model-contract`、`model-profiles`、`model-errors` 四个子路径。厂商实现位于包内私有目录，不公开厂商工厂或动态注册 API。
- `createModelProvider(options, signal)` 在异步加载前校验并快照选项，只按已实现 adapterId 懒加载。公共端口包含可选 discovery、Core 模型工厂与关闭契约；取消创建与未发布实例回收已有行为覆盖。统一错误不携带 SDK 异常、cause 或凭据。
- MiMo 原生 Responses、发现、流式、工具、推理内容、错误分类与版本化私有重放迁入私有实现。保留 provider ID、固定 CN URL、模型/重放版本和连接身份；不新增业务重试、备用模型或厂商占位。
- 配置/发现、已签发计划的宿主绑定、CLI/向导、shared schema、renderer 资料与设置、原有测试和夹具全部迁移到公共入口。删除 `src/models/` 的原实现、旧工厂和旧错误类，无别名或源码回退。旧 OpenAI/Anthropic-compatible 发现及生产 Gateway 仍保留其原依赖，不冒充新包适配器。
- 扩展原有三包构建顺序、首次 emit 等待和开发监听，接入模型解析门禁、Vitest 产物消费、node/web 项目及 Electron 精确发行文件集。Core 与 logs 不反向依赖 models；renderer/shared 只使用纯资料和类型。

### 12.2 实际执行证据

| 检查或实际入口 | 观察到的结果 |
| --- | --- |
| `npm run build` | 三包独立构建、Core/logs/models 解析门禁、node/web 类型检查及 Main/preload/renderer 生产构建通过 |
| `npm test` | 193 个文件通过；1648 项通过、2 项既有跳过 |
| `npm run test:integration:harness` | 两项真实 Electron CLI 集成通过，分别覆盖受控执行和 SDK 到本地传输；不是远程厂商验收 |
| `npm run agent:dev -- --help` | 实际 Node 启动器与独立 Electron 入口构建/启动并正常退出，帮助与现有向导/命令保持 |
| 本轮受支持文件 `biome check` | 45 个文件通过，无剩余诊断 |
| 模型边界隔离矩阵 | 16 项正反例通过：公开运行/类型与标准库、源码/dist/厂商/旧路径绕过、浏览器工厂、源码 SDK/JS Node/声明 Node 污染、纯入口工厂、反向依赖、非字面量加载及路径别名 |
| 三包真实 watch | Core/logs/models 全部首次 emit 后发布；修改临时模型模块后增量 emit，原生 Node 实际加载更新后的 JS，随后关闭监听并删除探针 |
| `node scripts/verify-models-package.mjs` | 仓库外无链接、独立缓存、离线且禁安装脚本地安装真实 Core/logs/models tarball 与完整运行依赖；实际闭包为三包、OpenAI 6.42.0 和 Zod 4.4.3 |
| 独立安装后的声明与运行 | NodeNext/Bundler 的 DOM `types: []`、`skipLibCheck: false` 消费通过，另有 Node 工厂声明消费；固定生产 URL 经仅验收用 fetch 路由到本地，真实 SDK 完成 20 次 HTTP 请求，覆盖发现/generate/stream、ordered tools/replay、安全错误身份、未知适配器/型号、创建快照/取消、截断/缺完成拒绝、关闭排空、独立绑定及借用 Logger 不关闭；无 SDK console 输出 |
| 实际生产 Electron 设置页 | 从 `out/main`、真实 preload 和 renderer 启动，未 mock 设置 IPC；只用合成凭据到本地 `/models`，发现三个已知型号并禁用未知项，展示全部八档思考强度，保存 `high` 后重开及重启新 Electron 进程仍为 `high` |
| 实际凭据与重启发现 | 验证独立 home、配置根和 Electron profile；Windows safeStorage 可用，凭据文件无合成 Key 明文；新进程不重填 Key，仍能解密已存凭据并再次通过真实 SDK 发现。两次发现均验证实际 Bearer，两个进程均正常退出，无强杀回退 |
| 迁移前 waiting → 新包恢复 | 修改前封存原 MiMo 源码入口并用真实 Electron/SDK 到本地 SSE 建立权威 v2 waiting。切换后 EOF 保留 pending，新进程恢复同一 Query/新 Run；绑定原文不变，消费真实读取随机码与私有重放，批准写入后文件匹配，最终 completed 且租约释放 |
| 实际 Windows 解包发行 | `electron-builder --dir --win` 使用本机 Electron 43.8.6，禁签名及原生依赖重建；从仓库外由真实发行可执行文件的 Node 模式原生解析 ASAR 内四入口、惰性适配器和 SDK，完成本地真实发现/generate、私有重放、公共错误身份及私有路径拒绝 |

独立包验证使用现有 TypeScript 编译器；只有 Node 工厂的编译侧使用仓库 `@types/node`，运行时无仓库依赖解析、源码别名或链接回退。SDK 可选 `ws` 集成未安装，依赖闭包存在同名多版本冲突会明确失败，不声称覆盖任意安装拓扑。

隔离 UI/旧会话使用本轮自建目录与合成凭据，没有检查或修改用户原配置和生产数据库。验收程序释放并清理自身数据、缓存、进程和监听；本轮临时脚本及解包目录已移除，正常 `dist`/`out` 构建产物保留。

### 12.3 明确限制

- 原包抽取轮次只验收 MiMo；后续三协议实现与本地验证见第 13 节，不将原有 Electron/ASAR 或远程证据泛化到新增适配器。
- 本轮模型流量全部为真实 SDK 到本地 HTTP/SSE，不新增远程厂商用量。前序 Flash/high 的远程证据及 SDK 421 内部重传限制仍见 [MiMo 实施记录](../mimo-token-plan-cn.md)，不因搬包扩大型号或档位结论。
- 旧 waiting 基线来自迁移前封存源码，不等同完整旧发行二进制。实际 UI 证据来自生产构建产物；ASAR 证据为真实解包可执行文件的 Node 模式模型执行，不是安装后全套 UI 验收。未验证签名、安装器或其他操作系统。
- 生产聊天/PPT 仍使用旧链；配置和凭据源继续归宿主，模型注册与执行协议继续归 Core，借用 Logger 不转移所有权。模型包没有推进 M3-B–E，亦不替代并行 M3-A 的独立记录。

## 13. 旧 Gateway 协议接入新模型端口

### 13.1 当前实现与路由

| adapterId / Core providerId | 传输端点 | 私有重放与能力边界 |
| --- | --- | --- |
| `mimo-token-plan-cn` | 固定 CN Token Plan `/responses` | 既有型号白名单、八档 effort、重放格式和连接指纹保持不变 |
| `openai-chat-completions` | 可配置 baseURL + `/chat/completions` | 保存 assistant wire message 与 `reasoning_content`；图像工具结果在完成全部 tool 消息后投影为 user 图像输入；已识别推理族支持保守的 low/medium/high |
| `openai-responses` | 可配置 baseURL + `/responses` | `store:false`、包含 `reasoning.encrypted_content`，按原顺序重放 output；effort 支持协议词汇至 max，具体型号是否接受由远端决定 |
| `anthropic-messages` | 可配置 baseURL + SDK `/v1/messages` | 保留 thinking 签名、redacted thinking 和工具块；支持返回推理的展示与重放，不发送统一 thinking 配置，任何 effort 覆盖明确拒绝 |

新增适配器接受语法有效的自定义模型 ID；能力资料不保证远端模型存在、支持图像/工具或账号有额度。OpenAI 默认 baseURL 为 `https://api.openai.com/v1`，Anthropic 为 `https://api.anthropic.com`。四个适配器均提供 discovery，配置模块已有的兼容发现路径继续保留，不在本次变更中迁移其分页/规范化语义。

`prepareConfiguredModel()` 对普通已签发计划，从解析后的 provider/openaiApiMode 选择新适配器；CLI 列表和向导使用相同路由。MiMo 仍只能由专用配置身份选中，自定义 URL 相同也不升级。连接指纹纳入适配器和实际地址；轮换密钥不改变身份，协议/地址变化拒绝复用旧会话。生产桌面 UI、旧 Agent/Gateway 和持久数据未切换或删除。

共同不变量：SDK 无自动重试；全操作超时与取消；provider/binding 关闭排空暂停消费者的网络泵；权威完成响应而非临时增量进入历史；缺失终止、无效 JSON 和截断工具不能被提交为成功。重放验证提供方、模型、连接、effort 和可见内容，禁止跨连接或编辑后伪造私有历史。

Anthropic SDK 的默认 SSE JSON 错误分支会直接写全局 console，绕过 logLevel/logger。适配器保留真实 SDK HTTP 与公开 rawEvents 分帧，仅在本地安全解码 JSON 并分类 SSE error；畸形正文不进入诊断，不全局改写 console。

### 13.2 官方依据

- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)：消息、图像、工具、finish_reason 与 token 参数。
- [OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create) 与[流式事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)：output 项、函数结果、权威终态和有序增量。
- [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning)：加密推理重放、型号相关 effort 和 max_output_tokens 截断。
- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)：工具续传保留 `reasoning_content`。
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)、[流式事件](https://platform.claude.com/docs/en/build-with-claude/streaming)与[thinking 重放](https://platform.claude.com/docs/en/build-with-claude/thinking#preserving-thinking-blocks)：system、图像、tool_result、签名增量及 `message_stop`。

### 13.3 实际验证与限制

- 八个定向文件、173 项回归通过：新增三协议、真实配置/凭据绑定与连接变更、向导保存，以及既有 MiMo/宿主。传输使用实际 SDK 到本地 HTTP/SSE；覆盖工具续传、序列化重放、图像、有序流、畸形终态、错误隐私、超时、取消和关闭排空。
- 实际 `node cli/dist/main.js` 三个独立进程，使用 Windows CurrentUser DPAPI 保存/解密合成凭据；分别经 `/v1/responses`、`/v1/chat/completions`、`/v1/messages` 返回对应答案，JSONL 和进程退出均为 completed/0，共三次本地请求、零远程请求。
- `npm run build:cli`、`npm run typecheck` 通过，包含所有模块/CLI 边界和 node/web/CLI 类型检查。资料及公开声明不携带 SDK 或 Node 类型。
- `node scripts/verify-models-package.mjs` 通过：仓库外离线安装完整真实 tarball 闭包，包含 Anthropic 0.104.1/OpenAI 6.42.0；四种选项的 NodeNext/Bundler DOM 声明消费通过，无 Node/SDK 类型泄漏。其运行用例仍是 MiMo 的 20 次本地 HTTP/SSE，不冒充新增三协议的独立安装远程验收。
- 实际 PTY 中观察到四种新建连接菜单，进入普通 OpenAI 连接的默认 baseURL 输入及 `[hidden]` API Key 输入；未输入凭据，取消后退出码 0。完整保存/解密/执行由上面的回归与独立 CLI 进程验证。
- 全量 `npm test`：201 个文件通过、1 个文件失败；1822 项通过、3 项跳过、2 项失败。失败均在本次未修改的 `tests/gateway-io-log.test.ts`：旧文件锁清理的 removedFiles 为 2 而预期 1，以及旧 root lock 下新请求写入返回 undefined。未通过放宽断言或修改并行旧日志工作来掩盖失败。
- 首次并行校验中，构建清理 dist 与测试/CLI/边界扫描发生冲突；随后顺序构建和消费通过。Anthropic 畸形 JSON 用例捕获到 SDK 原始 console 泄漏后修复，未降低隐私断言。
- 本次没有远程 OpenAI/Anthropic/DeepSeek 验收，没有新增适配器的 Electron/ASAR 或其他操作系统验收；不能借用前序 MiMo 的远程证据。

