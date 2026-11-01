# 通用包身份修正

[返回计划目录](README.md) · [项目整体规划](../project-plan.md)

## 通用包身份修正

项目定位是通用 Harness，PPT 仅为保留宿主与可选业务方向。新模块不再以 PPT 命名；这次只修正包身份、消费与发行路径，不借改名重写执行或迁移数据。

| 当前身份 | 目录 | 说明 |
| --- | --- | --- |
| `agent-harness` | 根 workspace | 私有项目元数据；保留现有 Electron 组合与构建 |
| `@agent-harness/core@0.1.0` | `packages/harness/` | 通用执行及 SessionHost，原 12 个公开子路径不变 |
| `@agent-harness/logs@0.1.0` | `packages/logs/` | 通用诊断日志，原 3 个公开子路径不变 |

源码、测试、独立安装消费者、门禁、锁文件及 ASAR 发行路径统一迁移。旧包根及旧子路径不再可加载，不提供 alias、转发包或源码回退。`core` 是现有通用执行包的新名称，不是新增内核层；目录不为命名统一而搬迁。两个包仍为私有 workspace，此名称不代表 npm scope 已取得或已公开发布。

旧 Electron 宿主继续使用 `Agent PPT` 产品名、`com.agent-ppt.app`、`.agent-ppt` 数据位置及 `AGENT_PPT_DATA_DIR`；开发入口原有 Electron 身份也保持。provider/plugin ID、Query/Run 语义、v2 binding、检查点与私有重放版本均不变。M2-B 和日志抽取历史记录中的旧名不作为当前导入示例，公开子路径清单按上表新前缀消费。

### 本轮验收结果

| 检查/场景 | 实际观察 |
| --- | --- |
| 离线 workspace 安装 | 新增两个新名链接，移除两个旧名链接，锁文件记录新根名与包身份 |
| 两个真实 tarball 的仓库外安装 | Core 和 logs 原生 Node 行为、公开声明及私有路径拒绝通过；旧包根和旧公开/私有子路径均报 ERR_MODULE_NOT_FOUND，没有旧名别名 |
| Core 消费 | 无插件对话、Zod、审批 waiting/resume、拒绝无副作用、借用历史及统一 AgentError 身份通过 |
| logs 消费 | 安全快照/遮蔽、故障隔离、资源关闭和真实 Node 文件/近期记录/管理通过；通用声明项目无需 Node ambient types |
| `npm.cmd run build` | 两包独立构建、两项依赖门禁、node/web 类型检查与 Main/Preload/Renderer 生产构建通过 |
| `npm.cmd test` | 192 文件、1632 项通过，2 项既有跳过 |
| `npm.cmd run test:integration:harness` | 两项真实 Electron CLI 集成通过，无跳过；使用本地 SDK/HTTP/SSE，保留配置重开、等待恢复与拒绝/取消链路 |
| `npm.cmd run agent:dev -- --help` | 新根名构建两个包并启动实际 Electron 帮助成功，未启动生产 UI |
| Biome | 53 个相关代码/配置文件通过 |
| 实际 Windows unpacked | 根清单名为 agent-harness；两个新包的清单、公开 JS/声明均为 ASAR 实体，无包源码/构建文件/链接，归档无旧命名空间包 |
| 实际解包原生 ESM | Electron 43.1.0 / Node 24.18.0、仓库外 cwd，从 ASAR Main URL 原生解析新子路径；SessionHost 与 AgentError 同一身份，通用日志与文件日志内容/遮蔽通过，旧名无法解析，新包私有路径仍拒绝 |

解包烟测使用原生 `--experimental-import-meta-resolve` 指定父 URL，无自定义 loader 或源码回退；复用已安装 Electron，跳过原生依赖重建与签名，不等同于安装器、签名或生产 UI 验收。本轮没有远程模型调用、公开发布、数据迁移或新的可靠性功能。临时脚本、解包目录、仓库外安装目录和日志数据均已清理，子进程已退出；保留正常构建产物与两个可重复执行的 tarball 验收入口。


