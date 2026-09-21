# PPT 核心与内置插件

状态：Implemented（内置插件第一版）。最后核对：2026-09-21。

## 目标与范围

将 PPT 能力拆成可在 Node 调用的核心，以及由桌面宿主显式装配的可信内置插件。
现有产品默认启用 PPT，用户界面、项目文件和审批行为保持原有语义。
本轮不包含安装/卸载界面、动态 UI 扩展、插件市场、热更新、独立 npm 发布或 MCP 服务。
插件接口是应用内的组合边界，不是执行第三方代码的安全沙箱。

实施按四步完成：抽取核心 → 分离工具与运行装配 → 迁出领域状态和文件规则 → 回归验证。

## 代码归属

| 边界 | 入口与职责 |
|---|---|
| PPT Core | `src/ppt/core/index.ts`：Presentation/DesignSystem 契约、SVG 校验、DeckValidationService、DeckExportService、PPTX postflight |
| PPT 插件 | `src/main/plugins/ppt/index.ts`：`createPptToolRegistry`、`createPptRuntime`、`createPptPlugin` |
| PPT 领域实现 | 插件的 `tools/`、`prompts/`、`task/`、`design/`、`gate/`、`service.ts` |
| Electron 预览 | 插件的 `adapters/electron-thumbnail-service.ts`；独立核心不加载 Electron |
| 宿主 | `src/main/agent/`：Gateway、Query、运行资源、通用工具、权限、History/checkpoint、队友 |
| 持久化与 UI | 宿主提供现有 Presentation lifecycle、数据库、IPC 和 Renderer 适配；插件消费明确传入的生命周期桥接 |
| Skills | `skills/ppt-*` 继续作为应用资源打包，由宿主扫描并传入插件；通用加载器保留原始 advisory metadata，PPT 插件解释 stage/推荐规则 |

核心的递归本地依赖只进入 `src/ppt/`、`src/shared/` 和 `src/design-system/`，
不依赖 Main、Renderer、IPC、Agent logger 或数据库。日志通过导出服务的构造参数注入；
独立调用默认使用 console，桌面宿主继续提供结构化日志适配。

## 使用入口

独立校验与导出（仓库内 TypeScript 路径别名）：

```ts
import { DeckExportService, DeckValidationService } from "@ppt/core";

const validation = new DeckValidationService().validate(presentation);
const result = await new DeckExportService().exportDeck({
  presentation,
  options: {},
  filePath: outputPath,
});
```

导出服务仍执行快照校验、临时文件写入和 PPTX postflight 后的最终提交。
低层 `ppt-exporter.ts` 是核心内部实现；调用方优先使用 `DeckExportService`。
这些入口可直接测试和调用，尚未做成单独发布的软件包。

当前应用使用内置 PPT 插件：

```ts
import { createPptRuntime, createPptToolRegistry } from "@main/plugins/ppt";

const runtime = createPptRuntime(
  createPptToolRegistry(), gateway, skills, database, resolvePptLifecycle,
);
await runtime.run({
  threadId,
  request,
  workspaceRoot,
  presentationSnapshot,
});
```

插件入口需要真实 Presentation 快照，缺少时在获取运行资源之前拒绝。
生产装配由 `src/main/index.ts` 提供 `resolvePptLifecycle`，连接现有持久化服务。

不装配 PPT 的运行入口：

```ts
import { AgentRuntime } from "@main/agent/runtime/agent-runtime";
import { AgentRunFactory } from "@main/agent/runtime/agent-run-factory";
import { createHostToolRegistry } from "@main/agent/tools/host-tools";

const runtime = new AgentRuntime(new AgentRunFactory(createHostToolRegistry(), gateway));
await runtime.run({ threadId, request, workspaceRoot });
```

该入口不注册 PPT 工具、不注入 PPT 指令、不创建空 Presentation/PptJob。
通用聊天、文件读写、AskUser 和运行持久化可独立使用。这里的启用/禁用由宿主装配决定，
不是现有桌面界面中的用户开关。

## 扩展契约与安全边界

- `AgentRuntime` 只依赖运行工厂接口，不构造 PPT 场景实现。
- `RuntimePlugin` 贡献输入校验、每次运行的领域状态、上下文、Prompt、Prompt revision
  和会话清理。领域状态通过 `checkpoint()` 保存既有业务字段；宿主掌握运行身份、
  lease、状态、消息配对、恢复和终态提交。
- `ToolDefinition.validateContext` 对解析后的真实工具执行领域检查，包括 deferred
  委托目标。PPT capability 规则在插件，宿主权限管线仍不可绕过。
- 通用文件工具通过 `WorkspaceFilePolicy` 执行写前内容校验和 artifact 观察。
  PPT 注册的文件工具绑定 PPT 策略；队友从发起方继承策略。文件 sandbox、read receipt、
  冲突检测、原子替换始终由宿主实现。
- 工具的 `mapResultToProgress` 贡献只读 UI 事件；投影失败会被记录，不改变工具提交事实。
  页面预览事件的结构仍与既有 Renderer 兼容。
- 通用 Skills 扫描、加载不导入 PPT 实现。PPT 技能推荐、队友 SVG 指令由插件注入。
- Query completed、Proposal ready、Presentation applied、Export completed 仍是四个事实。
  CommitGate 的领域校验与风险规则归 PPT 插件，审批交互和最终持久化仍由宿主适配。

为保留已有 UI/持久化协议，本轮没有泛化所有共享类型。`ToolContext`/运行选项仍保留
可选 PPT 类型字段，checkpoint 的 `baseRevision`、`pptTaskPlan` 名称不变；普通运行
不写这两个字段。`command_proposal` 结果协议也保留。该接口目前用于一个可信内置领域
插件，不承诺第三方插件 ABI 或多个领域插件的合并策略。

## 验证

`tests/ppt-plugin-boundaries.test.ts` 覆盖：普通聊天与落盘、无 PPT 文件操作、工具隔离、
缺少 PPT 快照时拒绝、任务规划更新 Prompt/恢复、主 Agent 与队友锁文件校验、
公开核心入口真实导出，以及核心依赖图约束。

既有 SVG 锁文件、审批与跨 Query 生命周期、恢复、并发和导出 golden 测试保留原断言，
仅将装配/导入入口改为新边界。最终验收包括 `npm.cmd run typecheck`、`npm.cmd test`、
`npm.cmd run lint` 和 `npm.cmd run build`。

最终结果：typecheck 与 build 通过；166 个测试文件全部通过，1130 个用例通过，
1 个既有用例跳过。全仓库 lint 未通过：394 个格式错误均位于未修改文件，主要是
Windows checkout 的 CRLF 与 Biome 格式要求不一致（例如 `biome.json`、`tsconfig.json`）。
本轮改动文件的 Biome 检查无错误，保留 3 条已有未使用 import 警告；未扩大范围格式化全仓库。

2026-09-21 手动 smoke：隐藏 Electron 窗口渲染六页 golden deck，均得到 640×360 PNG；
导出的六页 PPTX 通过结构 postflight，并抽查预览图。临时证据位于
`.tmp/ppt-plugin-smoke/`，不进入版本库。这不是 PowerPoint/Office 打开后的视觉验收。
环境没有 OPENAI_API_KEY、ANTHROPIC_API_KEY 或 MODEL，未运行真实模型网关联调。

## 下一阶段

按实际接入需求选择：外部 Agent 宿主使用时添加 CLI/MCP 适配，独立发布时建立包构建与
版本契约，桌面可安装插件产品则再设计 UI 扩展和生命周期管理。它们复用本轮核心，
不另建一份 PPT 生成或导出实现。
