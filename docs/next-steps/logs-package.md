# 独立能力切片：日志包抽取

[返回计划目录](README.md) · [项目整体规划](../project-plan.md)

## 独立能力切片：日志包抽取

### 设计依据与范围

借鉴 [DeepSeek Harness 架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)与 [Cordis 的服务依赖和可逆资源效果](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md)：区分能力协议、默认提供者和消费者，明确依赖与资源归属，不照搬其容器、上下文查找、动态装卸或“Everything is a Plugin”。

DeepSeek 的 Session log 是权威会话事实，不等同于本项目诊断日志；其[固定历史提交的遥测设计](https://github.com/deepseek-ai/deepseek-harness/blob/ca5e67490e0ae650823abc6e2994d651eb6b63c4/docs/subsystems/telemetry.zh.md)说明观测导出与执行主干、权威记录分离，不能据此声称当前 master 仍有同一实现。本轮不引入遥测或 OTel，也不改变会话历史和恢复。参考 [Spring Boot 日志初始化](https://docs.spring.io/spring-boot/3.5/reference/features/logging.html)，日志基础设施由宿主初始化，不依赖 Agent/插件系统就绪。

### 实际结构与公开面

| 位置/入口 | 职责 |
| --- | --- |
| `packages/logs/src/` | 原日志实现整体迁入，只调整内部 ESM 相对导入，不改变运行、安全与文件格式 |
| `@agent-ppt/logs/log-contract` | 具名 Logger、记录、输出与管理协议；Node 选项仍为无平台类型依赖的结构类型 |
| `@agent-ppt/logs/logs` | `createLogs()` 通用默认装配；声明和运行闭包不依赖 Node |
| `@agent-ppt/logs/node-logs` | `createNodeLogs()` 的 stderr、实例目录 JSONL、近期记录、配置及清理管理 |
| `packages/logs/package.json`、`tsconfig.json`、`build.mjs` | 私有 `0.1.0`、Node >=24、ESM-only、无运行依赖；独立 JS/声明构建，tarball 只包含 dist 和必要清单 |

没有根导出、通配导出或旧源码兼容层；`internal/` 不开放，只有 `tests/log-safety.test.ts` 精确白盒消费同一 dist 的安全函数。宿主、models、tools 与测试已迁移；Harness 与日志包互不依赖。原日志源码路径已删除，没有两套实现。

Logger 仍为借用的窄能力，不可关闭系统或管理文件；宿主提供目录/配置、管理设置持久化，并在消费者排空后关闭日志实例。记录先进行现有安全快照和遮蔽，输出失败独立记录；保留同步受理和当前 Node 同步文件操作，不声称新增异步队列、无阻塞、跨实例治理或任意文本安全保证。规范历史、检查点、审批和工具副作用语义不变。

### 构建与依赖约束

- `npm run build:packages` 构建两个 workspace；应用构建、类型检查、测试及开发 CLI 在消费前构建。原专用构建助手收敛为 `scripts/workspace-build.mjs`，dev 等待两个首次成功 emit，Main 观察两个包的 JS 产物。
- `scripts/check-logs-boundaries.mjs` 基于 TypeScript 实际解析及 manifest 检查日志包、node/web 消费图；递归检查通用入口的源码、JS 和声明闭包，拒绝 Node 污染、包外依赖和相对路径/源码/私有产物绕过。包内非字面量动态加载被拒绝，无法推断任意消费者计算出的动态目标，不宣称恶意代码沙箱。
- `scripts/verify-logs-package.mjs` 验证真实 tarball 的仓库外离线安装、零运行依赖、无仓库链接、原生 Node 行为及声明消费。只有 Node 消费者显式借用编译工具侧的 Node 类型，通用 NodeNext/Bundler 消费者使用 `types: []` 与 `skipLibCheck: false`。
- Electron 使用显式发行文件集，将包清单与 dist JS/声明放入标准 node_modules 位置；排除 workspace 默认实体中的源码和构建文件，无 afterPack 补拷贝或源码回退。

### 实际验收与限制

| 检查/场景 | 本轮观察结果 |
| --- | --- |
| workspace 安装与独立编译 | 离线安装成功，两个包分别生成 JS 与声明；日志包无运行依赖 |
| 原日志及消费回归 | 5 个相关文件：114 项通过、1 项既有跳过；其中 logs、安全、Node 日志共 31 项通过 |
| 日志边界隔离矩阵 | 18 个场景通过：公共入口/类型查询、标准 lib 与包内 path 引用允许；源码、私有/相对 dist、别名绕过、包外依赖、Node/ambient 污染、越权白盒与运行依赖拒绝 |
| 实际仓库依赖门禁 | Harness 门禁和日志包/node/web 图均通过，保留原约束；日志门禁未跳过 external 声明 |
| tarball 独立消费 | 仓库外真实离线安装，关闭安装脚本，无链接/运行依赖；公共入口可解析，根及私有路径按 exports 拒绝 |
| 声明消费 | NodeNext Node 消费，以及 NodeNext/Bundler DOM 通用消费均通过；通用项目 `types: []`，全部 `skipLibCheck: false` |
| 原生 Node 行为 | 上下文/数据快照、凭据遮蔽、输出故障隔离、借用 Logger 无管理权限、输出仅关闭一次、文件/近期记录一致、设置/清理及关闭后边界通过 |
| 双包监听 | 两个首次 emit 后才就绪；实际新增临时日志模块，增量 emit 后原生 import 取得正确标记 |
| `npm.cmd run build` | 包构建、两套门禁、node/web 类型检查及 Main/Preload/Renderer 生产构建通过 |
| `npm.cmd test` | 192 文件、1632 项通过，2 项既有跳过；未新增锁定源码或简单转发的测试 |
| `npm.cmd run test:integration:harness` | 2 个真实 Electron CLI 集成通过、无跳过；本地 SDK/HTTP/SSE、配置重开、waiting/恢复、拒绝/取消链路保持 |
| `npm.cmd run agent:dev -- --help` | 实际双包构建、Node 启动器和 Electron 帮助成功，未启动生产 UI |
| Biome | 32 个相关代码/配置文件通过；门禁最终引用规则补充后两个脚本再次通过 |
| Windows unpacked/ASAR | electron-builder 生成真实产物，三个入口的 JS/声明及清单均为归档实体，没有日志源码、构建脚本或链接 |
| 实际解包运行 | Electron 43.1.0/Node 24.18.0、仓库外 cwd，以 ASAR Main URL 为父路径原生解析 bare ESM 并执行；通用输出、真实文件与近期记录一致、遮蔽、关闭后行为及私有导入拒绝通过 |

新增验收程序首轮错把 `clearFiles()` 当成删除当日文件，已改为实际创建旧日托管文件并验证只删除旧日、当前文件原文保持；未改变生产清理行为。临时 ASAR 程序的对象比较改为完整 JSON 内容，避免将安全记录的无原型对象与解析后的普通对象原型混为契约。新门禁在实际应用类型查询中暴露缺少 AST parent 的问题，已通过 compiler host 保留父节点修复；补验公共类型查询与引用指令正反例，不通过跳过类型节点解决。

ASAR 验收使用原生 `--experimental-import-meta-resolve` 指定父 URL，没有自定义 loader、源码回退或生产 UI 启动。打包复用已安装 Electron，未验证安装器、签名或重新构建原生依赖。没有调用远程模型、公开发布 npm、迁移旧日志、扩大日志采集或修改生产会话。

本轮临时监听/边界/ASAR 程序、探针、解包目录、独立安装目录与场景数据均已清理，子进程已退出。保留正常包/应用构建产物及可重复执行的日志门禁、tarball 验收入口。日志包抽取完成，不据此宣布 Harness 内核诊断接入、M3 通用组合验收或 M4 生产切换完成。


