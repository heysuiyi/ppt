# Agent Harness

[English](./README.en.md) · [文档索引](./docs/README.md) · [Docs (EN)](./docs/README.en.md)

![Electron](https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Vitest](https://img.shields.io/badge/Vitest-3.2-6E9F18?logo=vitest&logoColor=white)
![Local First](https://img.shields.io/badge/local--first-desktop-111827)

本项目正在从演示文稿应用演进为通用 Agent Harness：提供模型中立执行、工具与插件装配、授权、规范历史及恢复能力。通用内核为 `@agent-harness/core`，诊断日志为独立的 `@agent-harness/logs`；PPT 是后续按公开协议接入的可选业务能力，不是内核定位。

## 现有 Electron/PPT 宿主

现有生产 UI 与旧 Agent 仍是本地优先的演示文稿工作台，尚未切换到新 Harness。下方界面、PPT 功能与使用说明描述这一保留宿主，不代表通用内核已经完成生产接入。宿主的产品名、appId、`.agent-ppt` 数据目录和 `AGENT_PPT_DATA_DIR` 暂时保持兼容。

该宿主适合这些场景：

- 从零生成一套汇报、方案、课程或产品介绍 PPT（SVG-native 整页作者路径）
- 在已有稿件上追加页面、改写文案或统一风格（经聊天中的 Agent / Skill，如 `ppt-beautify`）
- 用本地项目文件追踪 Brief、大纲、分镜、设计规格、导出记录和对话过程
- 研究“AI 如何可靠地参与文档编辑”，包括工具调用、审批、风险控制和视觉质检

## 界面一览

三栏工作台：左侧管理会话与项目文件，中间查看 Agent 过程与审批，右侧实时预览幻灯片。Agent 生成的演示可直接进入放映，预览与导出共用同一套 SVG 视觉源；设置台可管理模型、搜索与联网、提交与审批、用量与费用等。下方样张为默认界面与 Agent 产出示例。

输入框右下角的模型名称同时是思考设置入口：点击先打开思考强度卡片，点击卡片中的模型名称进入模型列表，选中后返回思考卡片而不关闭浮层。滑块使用模型支持的离散档位；“默认”沿用模型配置及现有网关默认值。覆盖值按模型在当前页面内保留，仅用于后续请求，不修改厂商配置，重载页面后重置。模型页按 Esc 返回思考页，再按 Esc 关闭；点击浮层外部直接关闭全部层级。不支持调节的模型显示说明，仍可进入模型列表。当前调节限于已识别的 OpenAI Responses 推理模型，不代表所有兼容端点均已验收；原生 MiMo 仍未接入生产聊天。

<table>
  <tr>
    <td width="50%"><img src="./images/首页.png" alt="工作台" /><br/><sub>三栏工作台</sub></td>
    <td width="50%"><img src="./images/设置.png" alt="设置：用量与费用" /><br/><sub>设置：用量与费用</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="./images/放映.png" alt="放映示例：结构化页面" /><br/><sub>放映示例：结构化页面</sub></td>
    <td width="50%"><img src="./images/放映-暗.png" alt="放映示例：深色创意封面" /><br/><sub>放映示例：深色创意封面</sub></td>
  </tr>
</table>

## 工作台主题定制

工作台外观与幻灯片 DesignSystem **分离**：在 `~/.agent-ppt/themes/<名>/theme.css` 放置主题包即可换肤，不改变 SVG 纸面与 PPTX 导出。下方为内置 Catnip 定制主题的宣传示意（非默认外观）。

<p align="center">
  <img src="./images/猫娘定制版.png" alt="Catnip 工作台主题宣传图" width="100%" />
</p>

<p align="center"><sub>Catnip：文件夹 CSS 主题示例 · 详见 <a href="./docs/user-manual/css-themes.md">CSS 主题指南</a></sub></p>

## 为什么不一样

**不是固定阶段机，而是模型驱动的工具协作。**

Runtime 向模型提供当前 workspace 事实、可用 Skill 和动态工具。复杂创建任务可以按需经可选上游 Skill（brief / outline / storyboard / research；无专用工具，用 WriteFile 写文件）再锁定 `design/design-spec.json` 与 `slides/page-plan.json` 并写作逐页 SVG；局部编辑、审查或导出可以直接走短路径。只有缺少关键约束、发生高风险变更或用户明确要求比较方案时才暂停交互。

新建整套 PPT 或批量创建页面时，Agent 默认依据受众、主题和交付场景自主选择 Design System 与逐页构图意图，经 `PreviewSvgPage` → `SubmitSvgDeck` 合并为一个 proposal；不会在内容草稿后要求用户再选“标准排版”或“创意装饰”。用户明确只要内容草稿时除外。

**不是让模型直接改文件，而是让模型提交结构化命令。**

所有真实幻灯片修改都会进入 `CommitGate`：先做 schema 校验、沙箱执行、diff 摘要和风险评估，再自动应用或请求用户确认。你能看到模型想改什么，也能拒绝它。

**产品作者路径是 SVG-native：整页 SVG 即预览与导出的共同视觉事实源。**

每一页以经过校验的 `1280 × 720` SVG 作为视觉作者源；预览器与 PPTX 导出消费同一份 markup。导出采用混合策略：去文字后的 SVG 作为底图，标题与正文提升为可编辑文字框；图表与装饰仍留在底图中，不拆成原生 shape/chart。`design-spec` / DesignSystem 锁定整套语气，但不替代页面 SVG。

**不是只保留最终结果，而是保留制作过程。**

本地 workspace 会按任务产生 `brief.md`、`outline.md`、`slides/storyboard.json`、`design/design-spec.json`、`slides/page-plan.json`、`slides/svg/*.svg`、`deck/snapshot.json` 等 artifact；History、checkpoint、transcript 和导出记录由各自的持久化服务维护，便于复盘、调试和继续迭代。

## 工作流一览

```mermaid
flowchart LR
  A["用户需求"] --> B["读取当前事实与动态能力"]
  B --> C{"模型选择安全路径"}
  C -->|复杂创建| D["可选 Brief / Outline / Storyboard"]
  C -->|轻量任务| E["直接编辑 / 审查 / 导出"]
  D --> F["design-spec + page-plan + 逐页 SVG"]
  E --> G["工具结果"]
  F --> I["SubmitSvgDeck → CommitGate → 必要时审批"]
  G --> H{"需要修改 Presentation？"}
  H -->|是| I
  H -->|否| J["直接交付观察或导出结果"]
  I --> K["实时预览 / 放映 / PPTX"]
  J --> K
```

## SVG-native 整套生成

新建或重做整套演示文稿时，Agent 可以使用 SVG-native 流程，把每一页完整设计为一份 `1280 × 720` SVG。标题、正文、背景、图表、图片、页码和装饰都由 SVG 自身提供，预览器和导出器不会再补一套可能不一致的视觉样式。

工作区中的关键文件：

- `design/design-spec.json`：沟通契约与 Design System 锁定文件
- `slides/page-plan.json`：页面顺序、文案和逐页叙事意图
- `slides/svg/P01.svg` 等：完整页面视觉源
- `deck/snapshot.json`：用户已经确认并应用的 Presentation 快照

提交链路如下：

```mermaid
flowchart LR
  A["编写完整 SVG 页面"] --> B["PreviewSvgPage 逐页渲染校验"]
  B --> C["SubmitSvgDeck 核对设计锁与页面计划"]
  C --> D["生成独立 Command Proposal"]
  D --> E["CommitGate 沙箱执行与安全校验"]
  E --> F{"是否需要用户审批"}
  F -->|是| G["审批卡：确认或拒绝"]
  F -->|否| H["原子应用命令"]
  G -->|确认| H
  G -->|拒绝| I["保留当前 Presentation"]
  H --> J["刷新镜像与 deck snapshot"]
  J --> K["使用同一 SVG 预览和导出 PPTX"]
```

这里有三个不同的完成状态：

| 状态 | 含义 |
|---|---|
| SVG 工作文件完成 | 页面源文件已经生成，但尚未改变当前幻灯片 |
| Proposal 已生成 | 替换命令已通过预览和安全校验，正在等待审批 |
| Presentation 已应用 | 命令已经由 `CommandBus` 原子执行，并写入 deck snapshot |

`SubmitSvgDeck` 返回成功只表示 Proposal 已建立，不等于幻灯片已经替换。需要审批时，只有用户在当前提案卡点击确认、应用返回成功，并且右侧镜像重新读取权威 Presentation 后，新的 SVG 页面才算真正生效。

每次 Agent Run 产生的 Proposal 都有独立审批卡。同一对话线程连续生成多套方案时，后一个提案不会继承前一个提案的“已应用”状态。对于旧版本曾错误复用审批卡的会话，应用重新加载时会检测审批动作与提案 Run 不一致的记录，并把该卡恢复为待审核，避免把未执行的替换误报为已完成。

## 你能在应用里做什么

- 用居中的 AI 输入框新建对话，输入自然语言需求开始生成
- 在左侧切换 Agent 工作区、浏览项目文件、搜索历史会话
- 在聊天流里审阅 Brief、大纲、一体化内容与视觉方案，以及必要的工具审批卡
- 查看 Agent 的任务计划、阶段进度、工具调用和子任务执行痕迹
- 在统一的过程区查看思考与工具记录：展开后直接阅读思考正文；手动开合选择不会被后续运行事件覆盖，收起再展开会保留长内容的阅读状态。整轮耗时在消息级展示，团队详情直接列出执行记录。
- 阅读支持表格、任务列表、引用和脚注的 Markdown 回复；新回复以轻微墨迹渐清效果逐步显示，历史消息直接呈现，传输结束后仍会完整显示已接收内容
- 尊重系统“减少动态效果”设置，后台页面暂停逐步显示；文本保持可选择，导出链接可直接打开对应文件夹，回复的视觉收尾不会延长 Agent 的忙碌状态
- 流式结束或过程记录补齐时保持正文实例和版式，不清空重播；切换团队详情后返回主会话继续原来的显示进度
- 上翻立即暂停自动跟随，内容增长和折叠时按阅读锚点补偿位置；通过“回到最新”或主动滚到底部恢复跟随，视口和输入区尺寸变化也会同步贴底
- 打开右侧 PPT 镜像：选页、放映、导出、全屏
- 在 Settings 配置模型（OpenAI / Anthropic 兼容端点）、运行参数、提交与审批策略
- 在 **Settings -> 搜索与联网** 配置 Tavily，让 Agent 可做联网调研
- 在 **Settings -> 用量与费用** 查看 Token、预估费用、任务成功率与按模型分摊
- 在演示偏好中查看/选择本地 Design System 预设（不影响 Agent 写入的 `design-spec`）
- 使用斜杠菜单插入**提示词模板**（只填入输入框，不会直接改 deck）

## 示例指令

```text
帮我做一份 8 页的产品发布会演示，面向企业客户，语气专业但有冲击力。
```

```text
把第 3 页改成左右对比结构，左边讲现状痛点，右边讲我们的解决方案。
```

```text
将整套演示统一成商务蔚蓝主题，并检查文字是否溢出。
```

```text
导出当前演示文稿为 PPTX。
```

## 快速开始

```powershell
npm.cmd install
npm.cmd run dev
```

启动后，在桌面应用里打开 **Settings -> 模型**，配置模型供应商、API Key、端点、超时、输出上限和 fallback 模型。

模型与搜索 API Key 由 `@agent-harness/configuration` 托管，Main 的桌面适配由 Electron `safeStorage` 的正常后端提供保护，仍保存在原应用数据目录。Renderer 的持久化设置、`localStorage` 和 Agent run IPC 不含 Secret；Renderer 只在录入时短暂持有 Key，通过配置管理命令明确执行保留、替换或清除，不能读取已保存明文。Linux 的 `basic_text` 后端保持 `degraded` 标记。旧版 v1 `localStorage` 明文 Key 不自动导入，升级后需重新录入并建议轮换。桌面开发环境继续支持 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`TAVILY_API_KEY` fallback，只发往官方或显式绑定的端点；携带凭据的远程端点必须使用 HTTPS，仅 loopback 开发服务可用 HTTP，见 [.env.example](./.env.example)。CLI 则使用独立数据根和 Windows DPAPI，不自动导入桌面凭据。

如需让 Agent 联网调研，请在 **Settings -> 搜索与联网** 填写 Tavily API Key。开发环境也可设置 `TAVILY_API_KEY`；搜索结果会以标题、URL 和摘要返回给主 Agent 及任务图 teammate。

用量与费用可在 **Settings -> 用量与费用** 查看；数据保存在本机应用数据目录。

## 常用命令

```powershell
npm.cmd run dev
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run preview
```

平台打包：

```powershell
npm.cmd run build:win
npm.cmd run build:mac
npm.cmd run build:linux
```

## 技术栈

- Electron + electron-vite
- React 19 + TypeScript
- OpenAI SDK + Anthropic SDK
- pptxgenjs
- Zustand + Zod
- Vitest

## 架构要点

```text
Renderer UI
  ChatWorkspace / PPTMirror / SettingsConsole
        |
        v
Preload IPC boundary
        |
        v
Main process
  Agent runtime -> Gateway -> OpenAI / Anthropic
  Tool registry -> Core tools + Skills
  CommitGate -> CommandBus -> Presentation snapshot
  ProjectFileService -> project artifacts and snapshots
  Conversation DB / Runtime stores -> history, checkpoints, transcripts
        |
        v
PPTX exporter (hybrid: SVG background + editable text)
```

关键模块：

- `app/renderer/`：React 工作台、聊天流、实时 PPT 镜像、设置台；`app/renderer/src/App.tsx` 直接承载公共布局与工作台/设置页切换
  - 布局由容器分配空间：根节点限定窗口高度，主体通过 Flex/Grid 伸展；栏宽由 `useWorkbenchLayout` 的 CSS 变量统一控制，并通过 `ResizeObserver` 按实际容器尺寸适配。内部面板独立滚动，局部响应式使用容器查询；窗口缩小时不会覆盖用户保存的预览宽度。SVG 预览保持 16:9，作者坐标仍为 1280×720。
  - 面板尺寸拖拽统一使用 `app/renderer/src/components/ResizeHandle.tsx`：受控 `value/min/max/onValueChange`，`axis` 选择左右或上下拖动，`direction` 决定增减方向。组件统一管理 idle/hover/dragging/disabled、指针捕获、全局光标和清理；支持方向键（10px）、Home/End。取消保留最后尺寸，禁用、失焦、失去捕获、卸载或边界变化时结束拖拽；尺寸约束和持久化仍由布局层负责。
- `packages/harness/`：私有 npm workspace 包 `@agent-harness/core@0.1.0`，Node >=24、ESM-only；独立生成 JS 与声明，运行时仅依赖 Zod。普通消费方使用包的精确子路径，不直接引用源码或私有 dist 文件；未接入生产 UI，现有 `app/main/agent/` 继续运行。
  - `src/agent/application/agent-application.ts`：公开 `@agent-harness/core/application/agent-application` 的 `createAgentApplication()`；内部默认工厂安装插件、绑定模型、就绪后发布实例，失败回滚。应用关闭先拒绝新创建、打断并排空执行，再释放拥有的资源；调用方不直接使用默认工厂。以下子目录均位于 `src/agent/` 内，不代表可导入路径。
  - `scope/`：Application → Agent → Run 的资源所有权、逆序释放与注册句柄；借用的宿主服务不随 Agent 关闭。
  - `runtime/`：单实例单激活的 `run/resume`、独立事件观察通道、Query 检查点协调，以及模型步/工具步。新请求只接收用户消息，不强制转换为业务 Task；Step 在提交边界更新快照。
  - `model/`：模型中立消息、能力声明、私有重放状态、按 provider ID 注册的模型工厂；增加厂商不在循环中新增分支。
  - `tools/`：注册、输入/输出校验、宿主强制授权、审批与续传；业务依赖由插件闭包捕获，业务结果、模型内容、展示投影分别持久化。
  - `session/`：历史条件追加与幂等批次收据、版本化检查点、写租约、世代围栏和显式接管；`extensions/`：插件安装、模型/工具/提示词贡献及作用域清理。
- `cli/host/`：真实 Node 宿主，拥有配置选择、模型准备、SQLite、能力装配、会话目录与关闭；不依赖 Electron、app 或根 src。
  - `createSqliteAgentStores(filePath)` 持久保存规范历史、稳定批次收据、检查点和租约；CLI 使用自己的 `sessions.sqlite`，不迁移桌面库。Node 运行要求 >=24。
  - `createAgentHost()` 绑定规范工作目录、工具模式、模型连接摘要、执行定义、插件版本和步数预算；`prepareConfiguredModel()` 只接受配置模块签发且已接入的原生适配器，不回退旧 Gateway。无插件、只读和读写均为真实运行配置。
- `cli/terminal/`：单输入 owner、Composer/选择器、流式临时 viewport、安全工具摘要、TUI/print/JSONL；终端展示记录不是规范历史。`cli/main.ts` 是生产与开发共同的 Node 入口。
- `app/preload/`、`app/shared/ipc.ts`：桌面 IPC 桥接与协议；文件能力通过 tools 包消费，其余共享/领域代码按职责归属，不将整个原 `src/` 视为 Electron 应用。
- `packages/models/`：私有单包 `@agent-harness/models@0.1.0`，厂商是包内模块，不一厂商一包。`models` 子路径的 `createModelProvider(options, signal)` 按 adapterId 懒加载实现；`model-profiles` 提供浏览器安全资料，`model-contract` 提供公共类型，`model-errors` 提供统一安全错误。已实现 `mimo-token-plan-cn`、`openai-chat-completions`、`openai-responses`、`anthropic-messages`，统一支持生成、流式、工具、发现与私有重放；后三者可配置 baseURL，MiMo 保留固定 CN 地址及已知型号白名单。能力资料表示协议支持，不保证远端任意型号可用。模型执行协议与注册仍由 Core 拥有，凭据来源/配置/连接指纹仍由宿主拥有。
  - `npm run build:models` 构建模型包及其 workspace 前置，`npm run verify:models-package` 在仓库外离线安装真实 tarball，执行真实 SDK 到本地 HTTP/SSE、声明与错误边界验收。资料入口不加载 SDK 或 Node 工厂；提供方关闭不关闭借用 Logger。旧 `src/models` 工厂与错误类已删除，无兼容路径，生产旧 Gateway 与其 SDK 依赖仍保留。
- `packages/tools/`：私有 `@agent-harness/tools@0.1.0`，Node >=24、ESM-only。`tools` 入口提供 `createTools({ workspaceRoot, mode }, logger?)` 与严格的 `prepareWorkspaceRoot()`；`tools-contract`、`tools-errors` 是浏览器安全的类型/错误入口。默认只读，读写模式再安装 write/edit，插件不自行授权；schema、单工具工厂、Workspace、路径与提交机制保持私有。
  - `read` 按 UTF-16 单元分页（默认最多 4000 单元），后续窗口必须携带 `expectedVersion`；完整观察同一文件版本后才能替换或编辑。`write` 显式区分 `create` 与带版本的 `replace`，`edit` 使用精确文本匹配。读取记录按安装隔离，重启丢失记录后要求重新读取。
  - `glob` 支持 `*`、`**`、`?`；`grep` 只做字面量逐行搜索，不执行正则或 Shell。遍历、文件字节数、搜索总字节数与结果都有上限，未完成扫描明确报告 `truncated`，二进制/过大文件明确列为跳过；搜索不授予修改资格。
  - `atomic-files` 为宿主提供 JSON/text 原子 I/O，`workspace-files` 保留旧 WorkspaceFileService 及必要类型。它们是受信任 Node 代码的低层功能，不是模型工具：readJsonFile 及旧服务读取可能创建目录、加锁和恢复写入；新只读工具不走这条恢复路径。新修改撤销 observation，旧服务修改更新 receipt；安全原语/锁/错误身份只有一份，预算不全局施加给旧消费者。旧 `src/tools` 已删除，无别名；旧 PPT 工具协议和业务提交未切换。
  - `npm run build:tools` 构建包及前置；`npm run verify:tools-package` 用仓库外真实 tarball 离线安装验证声明和实际文件行为。插件身份仍为 `tools/1`，不因 npm 包名变化修改旧 waiting 的审批、绑定或磁盘恢复格式。
  - 可用 `createTools(options, logs.getLogger("tools"))` 注入窄 Logger；省略时不创建日志实例。执行日志关联当前 Agent/Thread/Query/Run 与工具调用 ID，只记录工具名、状态、影响、耗时和分类错误码，不采集路径、正文、搜索词或编辑载荷；审批未通过时不记录“已执行”。开发宿主已注入 Logger；工具释放不关闭借用的日志系统。
- `packages/logs/`：私有 workspace 包 `@agent-harness/logs@0.1.0`，Node >=24、ESM-only、无运行依赖，与 Harness 并列且互不依赖。通过 `@agent-harness/logs/logs` 的 `createLogs()` 创建通用实例，通过 `@agent-harness/logs/node-logs` 的 `createNodeLogs()` 使用 stderr、按日 JSONL、近期环形缓冲与管理；窄协议由 `@agent-harness/logs/log-contract` 提供，不导出内部路径。尚未替换旧 logger、Harness 埋点或现有日志面板。
  - Logger 只负责记录与绑定上下文；输出配置、清理与关闭归宿主。记录先做有界快照和凭据遮蔽再分发，单个输出失败不阻止其他输出，日志不能替代规范历史或检查点。
  - 文件写入显式根下的 `<instanceId>/diagnostic-YYYY-MM-DD.jsonl`，日期使用 UTC；保留与清理仅处理当前实例的托管旧日文件，不读写旧日志、应用设置或 Gateway 归档。
  - `npm run build:packages` 顺序构建 Core、logs、models、tools 与 configuration；桌面 dev 等待五包首次 emit 并持续监听。`npm run verify:logs-package` 验证日志 tarball 的独立消费；日志包不拥有配置持久化或全局实例。
- `app/main/agent/`：Agent runtime、工具注册、模型网关、审批门禁、子任务
- `packages/configuration/`：私有 `@agent-harness/configuration`，内聚配置协议、管理、计划签发、默认存储和窄凭据保护端口；以精确子路径消费，不公开 Store 或解密接口。
  - Renderer 只消费纯协议及管理 IPC；`app/main/agent-configuration/` 只保留桌面组合、safeStorage 保护适配与 IPC。厂商保存完成后才发布已提交状态；原桌面浏览器迁移行为保持。
  - 运行请求按 `modelId` 选模，`resolveRuntime(plan)` 只能接收同一运行时签发的原对象；凭据和原生 SDK 不进入 Core 或 renderer。已保存连接的发现只接收 vendorId，草稿发现需要临时 Key。
  - Windows Node 保护使用 CurrentUser DPAPI，固定脚本与私有管道，不将秘密放入 argv、环境或明文临时文件。Node 密文使用显式方案/版本，拒绝跨后端解释；桌面原 v2 存储与迁移行为保持。
  - 完整配置变更跨进程串行，避免两个 CLI 的 read-modify-write 丢失连接；不承诺设置与凭据两个文件具备原子事务。缺失配置的纯读取不创建目录或锁。
- `src/design-system/`：DesignSystemV2 schema、预设与解析
- `src/shared/`：尚未进一步归属的演示文稿、命令、配置与会话契约；桌面 IPC 协议已归 `app/shared/ipc.ts`，不将该目录视为可任意复用的公共包。
- `app/main/project/`：本地项目沙箱、产物读写、diff 和依赖状态
- `app/main/storage/`：SQLite 数据访问层，按数据对象目录内聚（如 `session/`、`checkpoint/`、`ppt-job/`），目录内按需放置 DO、DTO、Mapper。
  - `init(connection)` 集中管理表、索引、连接配置和已有检查点字段迁移，可重复调用且保留数据。
  - `createStorage(filePath)` 创建并初始化单个连接，装配所有 Mapper，提供同步 `transaction()` 和 `close()`；业务不接触原始连接或 SQL。借用同一 Storage 的业务仓库不关闭它。
  - Mapper 负责参数化 SQL、记录映射、具名检索和条件写入；运行状态、租约接管、幂等解释、产物关联校验、失效传播及恢复规则仍由业务服务负责。
  - 会话与 PPT 生命周期共享连接和嵌套 SAVEPOINT；数据库提交成功后才发布内存状态、通知及工作区镜像。JSON 配置、项目文件和文件型 Blob 存储保持原有实现，未为闲置的 `blobs` 表新增 CRUD。
- `app/main/deck/`：缩略图、导出历史、PPTX 导出服务
- `skills/`：核心创建 `ppt-workflow` → `ppt-design` → `ppt-design-layout` → `ppt-build`；短路径 `ppt-edit` / `ppt-beautify` / `ppt-review` / `ppt-export`；可选上游 Skill（`ppt-brief` / `ppt-outline` / `ppt-storyboard` / `ppt-research`）仅知识包，经 ReadFile/WriteFile 写入，非 lifecycle 硬锁
- `tests/`：Agent、导出、上下文压缩、工具审批和项目产物测试

### 通用 Agent 的生命周期约定

宿主显式装配 `AgentServices`（模型工厂、授权策略、历史和检查点），调用 `createAgentApplication(services)`，通过 `application.agents.create()` 提供定义、模型选择、步数预算和插件。业务工具在插件 `setup()` 中注册；内核只调用协议，不读取 Presentation、workspace 服务或厂商配置。关闭顺序为先 `application.close()`，再关闭宿主拥有的存储和连接。

需要固定 Thread 并校验宿主恢复边界时，从 `@agent-harness/core/session-host` 导入 `createSessionHost({ services, agent, threadId, binding })`：先等待 `binding.ensure()`，再从公开 Application 创建 Agent。定义、模型、插件和授权均显式提供；`plugins: []` 不依赖工作区或 Electron。SessionHost 只拥有自己的 Application，不关闭借用端口，`resume()` 不接受接管租约。当前 Node CLI 宿主负责普通对话/文件配置与固定权限环境，生产 PPT 链路仍保留旧执行链。

完整包子路径见 [M2-B 清单](docs/next-steps/m2-b-package-boundary.md#m2-b-独立包边界与实际消费)，当前名称与切换证据见[通用包身份修正](docs/next-steps/package-identities.md#通用包身份修正)。`PluginContext.scope` 只提供 `PluginScope.signal/own()`，不暴露内部资源树的创建与关闭；错误使用 `@agent-harness/core/protocol-errors` 的同一 `AgentError`，无损 JSON 快照与值比较由 `@agent-harness/core/protocol-values` 提供。`ToolCompletion` 是事件/存储公共数据，`ToolExecutor` 与执行管线仍为内部协议。没有根导出、通配导出、源码别名或旧包名兼容层。

`npm run check:agent-boundaries` 在包自身、node/web 三个 TypeScript 项目中校验源码与声明闭包、反向依赖、精确子路径及实际解析目标；只有指定行为测试可白盒导入同一 dist 实体。三斜线引用、继承和泛型条件类型的来源也参与检查。`typecheck` 和 `build` 自动包含该检查；它不是恶意插件沙箱。

安装依赖会建立 workspace 链接；`npm run build:harness` 可独立构建 Core。应用构建、测试及开发入口消费构建产物；`npm run dev` 等待首次成功 emit 并监听包源码与 Main 使用的 JS。`npm run verify:harness-package` 验证真实 tarball 的独立消费；`npm run test:integration:harness` 包含真实 Node CLI 的本地 HTTP/SSE 与 Windows DPAPI 场景，不代表远程厂商或生产 UI/PPT 验收。

- 同一 Agent 同时只接受一次 `run()` 或 `resume()`，不隐式排队。`handle.events` 仅供单消费者观察；不消费或退出事件流都不会取消执行。
- `waiting` 会保存交互和续传数据，结束本次 Run 并释放租约。回答只能匹配持久化交互，恢复必须提供新的 `runId`；不接收前端重建的执行快照。线程有未完成 Query 时，新请求不能越过它。
- 用户取消为 `cancelled`；实例/应用关闭为可恢复的 `interrupted`。已保存的等待保持为 `waiting`。取消不会撤销外部副作用。
- 历史与检查点不假设共享事务：先保存追加意图，再按稳定批次 ID 提交历史。崩溃后先对账；工具已派发或回答已消费、但没有持久结果时记为 `unknown`，不自动重做副作用。这不承诺外部操作恰好一次。
- 模型流必须有权威完成响应，临时增量不作为规范历史；截断、缺失完成响应、存储失败不会被报告为成功。定义、插件或续传契约改变时必须升级相应版本。

新链路的回归入口为 `tests/base-tools.test.ts`、`tests/mimo-token-plan-cn.test.ts` 与 `tests/general-agent-*.test.ts`，覆盖真实文件、SQLite、原生 SDK 到本地 HTTP/SSE 的传输、生命周期、工具授权与恢复边界。远程厂商推理需要另外配置凭据；这些本地验证不代表已经完成远程 LLM 或生产 UI 的切换验证。

### 独立 UI 预览

```powershell
npm.cmd run ui:dev
npm.cmd run ui:build
npm.cmd run ui:typecheck
```

开发地址为 `http://127.0.0.1:5178/`。此入口不启动 Electron、不构建 Harness，也不替换生产桌面。当前提供 U0–U2 的明暗主题/Portal 样例及本地连接表单，可验证校验、失败保留、脏关闭和取消重开竞态。仅接受演示值 `demo-key`，不连接服务、不保存凭据；所有更改仅在内存中，刷新重置。构建与缓存位于 `.vite/ui-preview/`。范围与证据见 [UI 执行方案](docs/next-steps/ui-design-system.md#121-第一轮-u0u2-实施与验收)，U3–U5 尚未实施。

### 生产 Node CLI

需要 Node >=24。先构建一次，再直接运行生产入口；交互初始化需 Windows 安全终端与 CurrentUser DPAPI：

```powershell
npm.cmd run build:cli
npm.cmd run agent
npm.cmd --silent run agent -- --prompt "概括这个工作区" --output jsonl
npm.cmd run agent -- --prompt "普通对话" --tools none --print
npm.cmd run agent -- --thread "<threadId>" --resume "<queryId>"
```

`npm run agent:dev` 编译并运行同一套入口，使用独立开发数据根和临时 emit，不启动 Electron、不占用第二个 stdin owner，也不替换生产 `cli/dist`。`npm run build` 同时生成 CLI 与桌面产物。机器消费可直接调用 `node cli/dist/main.js`，或使用 `npm --silent run agent -- ...`，避免 npm 自身的命令 banner 混入 stdout。

没有默认模型时，交互入口选择连接 → 隐藏输入 Key → 发现并选择受支持模型 → 保存连接和 CLI 默认模型；安全输入/保护不可用则在收集秘密前失败。print、JSONL、一次性 prompt 不弹出配置或审批菜单，缺配置明确报错。向导可新建 MiMo、OpenAI Responses、OpenAI Chat Completions 兼容和 Anthropic Messages 连接，也可复用已保存连接；普通连接按 provider/openaiApiMode 选择新适配器，不回退旧 Gateway。OpenAI 默认地址带 `/v1`，Anthropic 默认地址为 `https://api.anthropic.com`，由 SDK 添加 `/v1/messages`。MiMo 仍固定 CN 地址，自定义连接不自动升级为 MiMo。“配置就绪”不是远程鉴权或额度成功证明。协议映射、官方来源与本地验收见[协议补齐记录](docs/next-steps/models-package.md#13-旧-gateway-协议接入新模型端口)。

| 命令 | 行为 |
| --- | --- |
| `/model`、Alt+M | 按厂商连接分组或搜索全部模型；标记当前项及本地就绪/不可用状态，同项不新建会话，更换需确认新绑定；面板提供添加/配置连接入口 |
| `/connect` | 已有默认模型也可重新打开厂商向导：添加连接或选择已有连接的模型，保存连接与 CLI 默认模型；当前会话须另行确认才切换 |
| `/new` | 明确确认后创建新会话 |
| `/resume` | 查询当前工作区的权威会话目录并恢复；原连接/定义/权限/预算不匹配则拒绝 |
| `/tools` | 选择无插件、只读或读写；确认后新建会话，不改变旧绑定 |
| `/tools-output`、Ctrl+O | 选择/展开安全工具元数据，status/effects 分列；不 dump 输入、结果或私有展示载荷 |
| `/help`、`/hotkeys`、`/status` | 查看帮助、按键及实际模型/能力/数据目录 |
| `/paste`、`/exit` | 显式多行后备；独立行 `/end` 提交，`//end` 为正文；退出保留 waiting |

交互是 inline TUI，不使用备用屏幕，不清空滚动历史；模型文本增量只进入临时 viewport，权威完成结果结算一次。Composer 支持多行、中文/emoji 字素编辑、Alt+Enter、整块 bracketed paste；运行中可以编辑但不能提交或排队。命令补全只接受候选，不顺便发送；Esc 先关闭局部 UI，Ctrl+C 清草稿或取消当前 Query，空草稿 Ctrl+D 正常退出。`NO_COLOR`/`--no-color` 只关颜色；无必要 TTY、TERM=dumb 或尺寸不足降级 plain。

页面将输入框、选择面板和底部状态分层；状态栏分别显示模型、本地配置状态、执行/切换活动及工作区/会话/工具信息。选择器显示位置与滚动提示，搜索或确认期间不提示可发送；取消保留原草稿和绑定。模型不可用项可查看原因但不能激活；“配置就绪”仅反映本地配置与凭据条件，不表示已联网、鉴权通过或额度充足。

模型面板借鉴 oh-my-pi 的厂商导航与模型列表：宽屏双栏，窄屏分步显示；按真实连接 ID 分组，同协议不同连接不会合并。`←`/`→` 或 Tab 切换厂商/模型焦点，`↑`/`↓` 选择，Enter 确认，Esc 返回或退出。只显示当前 CLI 已配置的模型，不把桌面配置自动导入，也不虚构未接入厂商或模型性能。连接向导完成保存后，即使取消当前会话的切换，新连接与默认模型设置仍会保留。

默认只读安装 read/glob/grep，并由宿主允许读取；读写再安装 write/edit，写入逐次要求明确选择与完整 interactionId。plain 回答格式为 `allow <interactionId>`、`reject <interactionId>`、`cancel <interactionId>`，`exit` 保留等待；未知载荷不能猜回答。工具继续校验工作区、路径、UTF-8、大小、完整读取与版本，审批不替代这些边界。

输出显式分离：交互 TUI；人类 print/plain（stdout 仅权威正文、stderr 进度/错误）；`--output jsonl`（stdout 只有 TerminalRecord v1，不含 delta、回显、菜单或 ANSI）。非 TTY 且无 prompt/resume 时，整段 stdin 到 EOF 是一份正文，斜杠不作命令；`--prompt` 不消费管道作为审批。

等待 EOF/保留退出为 **3**，恢复使用同一 Query、新 Run 和原权限环境；交互取消后留在会话。退出码：0 完成/正常退出，1 执行/持久化/输出/关闭失败，2 参数错误，130 确认的用户取消或显式中止，143 宿主终止，141 下游 EPIPE（没有更高错误时）。观察到 run.completed 不等于已清理成功；完成拒绝与关闭失败仍非 0，不能自动重试副作用。

生产数据默认 `~/.agent-harness/cli`，开发默认 `~/.agent-harness/cli-development`，显式 `AGENT_HARNESS_CLI_DATA_DIR` 可覆盖。配置、受保护凭据、`sessions.sqlite` 和 `logs/` 不与桌面共用；不会自动迁移或删除 `.agent-ppt` 的旧 CLI/桌面数据，也不提供旧入口兼容层。相同连接的密钥轮换可恢复，连接/权限环境变化必须新建会话；异常活跃租约不自动接管。

宿主按停止受理 → SessionHost 排空 → 模型 → 存储 → 日志关闭；模型和 tools 借用 Logger。诊断不记录模型正文、工具载荷或凭据。MiMo 不做应用层/SDK 重试；Node Fetch 仍可能按 HTTP 规范内部重传 421，不能承诺底层绝无重传。

定向验证：

```powershell
npm.cmd run test:integration:harness
npx.cmd vitest run tests/cli-terminal-controller.test.ts tests/cli-terminal-input.test.ts tests/cli-terminal-rendering.test.ts
```

Windows DPAPI、本地 SDK/HTTP、真实 ConPTY 与本轮 4 次 MiMo 远程请求的分层证据见 [CLI 实施记录](docs/next-steps/cli-terminal.md#84-生产直切实施与验收记录)。远程仅验收 `mimo-v2.6-flash` 的小范围普通对话与文件审批恢复，不泛化到全部型号/档位；生产聊天/PPT 未切换。

## 本地文件与隐私

Agent PPT 的默认运行方式是本地优先：

- 项目产物与 deck snapshot 保存在 workspace；History、checkpoint、transcript、用量统计和部分设置也可能保存在本机应用数据目录
- API Key 由 Main 的 Electron `safeStorage` 凭据存储托管，不保存在 Renderer `localStorage`，也不随 Agent run IPC 传递；开发环境变量 fallback 仍受支持
- 模型只能通过已注册工具和结构化命令影响演示文稿
- 高风险或不可自动应用的变更会要求用户审批

## 文档

- [docs/README.md](./docs/README.md)：文档索引
- [架构总览](./docs/architecture/overview.md)：现行分层、数据流与状态边界
- [工程能力地图](./docs/architecture/engineering-capabilities.md)：当前能力落点、成熟度与缺口
- [Query 与 Agent Loop](./docs/agent/query.md)：QueryParams、State、Workspace、事件和恢复
- [Tools 与文件操作](./docs/agent/tools.md)：动态能力、权限、Read/Write/Edit 契约
- [System Prompt 与 Context](./docs/agent/system-context.md)：Section Registry 与稳定/动态分区
- [Presentation 工作流](./docs/presentation/workflow.md)：Artifact、Proposal、CommitGate 与交付状态

## 当前状态

当前重点是通用 Harness 的模块边界与实际宿主消费：已独立通用执行和日志包，模型及工具能力继续按明确边界演进。现有 PPT 工作台保持运行，但不作为内核通用性的标准；生产切换、业务插件接入及尚未执行的可靠性计划分别验收，见项目规划。
