# M2-B：独立包边界与实际消费

[返回计划目录](README.md) · [项目整体规划](../project-plan.md)

## M2-B 独立包边界与实际消费

### 范围与结构

本轮在 M2-A 已有语义上建立独立包，不重新设计 Loop、SessionHost 或持久化。唯一 workspace 为私有 `@agent-ppt/harness@0.1.0`；Node >=24、ESM-only，独立 NodeNext 配置生成 `.js` 和 `.d.ts`，内部相对导入显式使用 `.js`。运行依赖仅 Zod；TypeScript 是包自身声明的开发依赖。没有根导出、通配导出、`index.ts`、源代码 aliases、兼容重导出或公开发布。

| 位置 | 实际职责 |
| --- | --- |
| `packages/harness/src/agent/` | 原通用协议和默认执行实现，保持资源、授权、历史和恢复语义 |
| `packages/harness/src/agent-host/session-host.ts` | 原通用 SessionHost，仍只借用模型、授权与存储端口 |
| `packages/harness/tsconfig.json`、`build.mjs` | 不继承应用 tsconfig；无隐式 ambient types，独立编译前清理旧 dist，避免残留模块混入发行物 |
| `packages/harness/package.json` | 私有 ESM 包身份、12 个精确子路径、JS/types 映射及 `files: ["dist"]` |
| `src/main/agent-host/` | 当前应用的配置、凭据、SQLite、日志和 Electron 组合根；不进入包 |
| `src/models/`、`src/tools/`、`src/logs/` | 仍为应用内模型、工具和日志能力，不随本轮建包 |

### 受支持的完整包入口

下列路径均以 `@agent-ppt/harness/` 为前缀，`types` 和 `import` 指向同一次编译的声明与 JS。默认工厂、DefaultAgent、Loop、工具管线、Registry 和资源树不在公开面。

| 精确子路径 | 职责 |
| --- | --- |
| `application/agent-application` | 创建与关闭 Application |
| `agent-contract` | Agent 执行、结果与生命周期协议 |
| `agent-factory` | Agent 创建配置协议，不公开默认工厂实现 |
| `protocol-values` | 无损协议值、快照与比较 |
| `protocol-errors` | 单一 AgentError 身份及安全错误投影 |
| `extensions/plugin-contract` | 插件贡献及窄作用域协议 |
| `model/model-contract` | 模型端口与规范消息 |
| `tools/tool-contract` | 工具定义、授权、结果与交互协议 |
| `session/session-contract` | 历史存储端口 |
| `session/checkpoint-contract` | 检查点、租约与恢复端口 |
| `session/session-events` | 执行观察事件 |
| `session-host` | 固定 Thread 的通用 SessionHost |

### 调用方、构建及约束

- 新宿主、models、tools 与普通消费测试全部使用精确包子路径；删除原源码路径，无双实现或 shim。基础工具、基础设施和事件流行为测试的精确白盒例外只指向同一 dist 实体；Vitest 使用同一模块图，避免 AgentError、Zod 和状态实例混用源码与产物。
- 根目录声明 workspace 与正式生产依赖，提交可跟踪的 npm 锁文件。`npm run build:harness` 独立构建；typecheck、应用构建、单测、两个 CLI 集成、开发 CLI 和 preview 在消费前构建包。
- `scripts/harness-build.mjs` 提供一次构建和开发监听；dev 等待首次成功 emit，再启动 Electron Vite。Main 观察包 JS 产物变化；这是开发构建监听，不是运行中动态插件装卸。
- `scripts/check-agent-boundaries.mjs` 从 manifest 派生唯一公开面，在包自身、应用 node/web 编译项目中验证实际解析目标、源码/声明协议闭包、平台独立性、反向依赖及原有三斜线/类型来源规则。阻止相对路径、别名和 src/dist 混用绕过；不把“声明是 external library”当成跳过检查的理由。
- `scripts/verify-harness-package.mjs` 创建真实 tarball，在系统临时目录离线安装并执行原生 Node 与声明消费者；不链接仓库 node_modules，不靠 tsx、测试 runner、Vite alias 或自定义加载器使其可运行。
- Electron 主进程保留包外部依赖。实际打包发现默认 workspace 收集会复制源码/构建脚本并裁剪声明，因此根 `build.files` 排除默认收集的 Harness，再用显式文件集将 manifest、dist JS 和声明置于标准 `node_modules/@agent-ppt/harness`。不做 afterPack 补拷贝，不修改包导入或回退到源码。

### 实际验收结果

| 检查/场景 | 本轮观察结果 |
| --- | --- |
| workspace 与独立构建 | 离线依赖安装成功；包独立生成 JS 与声明，根应用项目不再直接包含旧内核源码 |
| 边界正反例矩阵 | 34 个隔离场景通过，覆盖包/应用依赖、声明来源、精确白盒及绕过拒绝；前轮历史矩阵不与本轮重复计数 |
| `npm.cmd run typecheck` | 包构建、边界检查、node/web 类型检查均通过 |
| Biome | 最终本轮 81 个相关代码/配置文件通过，无未修复问题 |
| `npm.cmd test` | 192 个文件、1632 项通过，2 项按既有条件跳过 |
| `npm.cmd run test:integration:harness` | 现有两个真实 Electron CLI 集成文件均通过，无跳过；使用本地 HTTP/SSE，不访问远程模型 |
| `npm.cmd run build` 与 CLI help | Main/Preload/Renderer 生产构建成功；真实 Node 启动器启动 Electron 帮助成功 |
| tarball 仓库外安装 | 真实 tarball 和 Zod 离线安装；没有 workspace 链接、源码或 Electron/SDK/SQLite 运行依赖；所有公开入口可解析，根及私有路径按 exports 拒绝 |
| 声明消费 | NodeNext 与 Bundler/DOM 两个外部项目通过，均 `types: []`、`skipLibCheck: false` |
| 原生 Node 行为 | 无插件普通对话、Zod schema、审批 waiting→resume、拒绝/策略拒绝无副作用、先校验再授权、关闭后借用历史、统一错误身份及安全投影均通过 |
| 开发监听实际烟测 | 首次成功 emit 后添加临时模块，观察增量编译并由原生 import 消费正确标记；不据此声称已验证完整 UI 热重载 |
| 旧 v2 会话到包产物恢复 | 历史宿主 `2519fc9` 的原组合根/runner 加当前迁移内核源码生成 waiting；当前真实组合根在新进程实际加载包 dist，完成 EOF 保留及批准恢复；不是完整历史二进制验收 |
| 旧会话真实工具与存储 | 真实 Electron/safeStorage/SDK、本地一次发现及五次 SSE 请求；实际 glob→grep→read 学到随机码，write 等待批准前无文件，批准后文件匹配；v2 binding 517 字节原文未变、pending 原始 JSON 经再次 EOF 保留，Query 不变/Run 更新，最终 completed 且租约释放 |
| Windows unpacked/ASAR | electron-builder 使用已安装 Electron 43.1.0 生成实际 win-unpacked；包 manifest、24 个 JS/types 导出目标及 Zod 均为归档实体，无 Harness 源码或链接 |
| 解包运行时实际消费 | 使用解包 Agent PPT.exe 的 Node 模式、Electron 43.1.0/Node 24.18.0 和仓库外 cwd，以 ASAR Main URL 为父路径原生解析 bare ESM 子路径并 import；SessionHost/AgentError 身份及安全投影、Zod 解析和私有路径拒绝成功，无自定义 loader 或源码回退 |

tarball 的端口夹具具有幂等历史回执、修订 CAS 和租约围栏，但只存在于进程内；跨进程持久恢复证据来自上面的真实 SQLite/Electron 场景。解包验证使用 `--experimental-import-meta-resolve` 传入原生父 URL，未启动生产 UI；为隔离包闭包验证跳过重新下载 Electron、原生依赖重建与签名，不等同于安装器、签名或生产聊天验收。初版临时 ASAR 脚本使用 `/` 调用 Windows extractFile 误报清单缺失，改用平台路径后确认实体存在；没有为该夹具错误修改生产逻辑。

临时边界矩阵、旧版恢复与 ASAR/监听脚本、探针源码、解包目录及独立安装目录已清理；场景创建的子进程、工作区与数据库均已退出或移除。仅保留正常包/应用构建产物和可重复执行的 tarball 验收入口，没有访问或迁移生产会话。

结论：M2-A 通用装配和 M2-B 独立包门槛完成。M3 组合/可靠性验收与 M4 消费侧迁移仍是后续；没有改动 v2 binding、检查点 v1、待决载荷或数据库格式，没有调用远程模型，没有新增 IoC 容器、动态发现或业务插件迁移。

