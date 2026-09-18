# 本地日志与运行诊断

状态：Implemented。

Agent PPT 使用主进程结构化 JSONL 日志进行本地诊断。日志是运行状态的观察投影，
不参与 Query、工具执行、审批或持久化决策；日志写入失败不得改变业务控制流。

## 存储与管理

- 日志目录由设置页“打开目录”进入。开发运行（`npm.cmd run dev` / `preview`）写入项目根的 `logs/`；打包应用默认写入应用数据根的 `logs/`，避免安装目录不可写。`AGENT_LOG_DIR` 可显式覆盖，两类运行的设置、日记和 Gateway 档案共用同一日志根。
- 控制台与文件都保留原始 Unicode 中文，不再将中文强制转成 `\uXXXX`。JSON 字符串中的引号、换行和路径反斜线仍按 JSON 规则转义。
- Windows 开发启动器在启动 electron-vite / Electron 前设置控制台代码页 65001，供 Chromium 原生日志一并继承。外部终端或日志采集器仍需按 UTF-8 解码；无法设置代码页时会显示警告。原生 Chromium stderr 不经过应用 logger，缓存权限错误 `(0x5)` 本身不会因修复编码而消失。
- 日志按系统本地自然日写入 `agent-YYYY-MM-DD.log`；同日重启继续追加，跨日自动切换。
- 每天严格只有一个文件，不按大小分片且不压缩；默认保留最近 7 个自然日。
- Gateway I/O 全量档案写在 `logs/gateway/YYYY-MM-DD/<gatewayRequestId>.json`：每次
  模型请求/返回的 prepared request、content blocks、stopReason 与 usage。用于设计
  Skill 等路径的端对端核对；默认开启，`AGENT_GATEWAY_IO_LOG=false` 可关闭。
- 图片/二进制数据在 I/O 档案中被占位符替换，文本与 tool schema 保留原文。
- 旧版 `agent.log`、压缩轮转文件和历史元数据仍会计入状态，并可通过“清理日志”删除
  （含 `logs/gateway/`）。
- `timestamp` 使用带本地 UTC 偏移的 ISO 8601 格式，便于直接阅读且仍可精确解析。
- `AGENT_LOG_LEVEL=debug|info|warn|error` 可覆盖最低记录级别；设置页配置优先。
- `AGENT_LOG_FILE=false` 可关闭文件写入，仅保留控制台。
- `AGENT_LOG_DETAIL=full` 保留为显式兼容开关；默认内容策略仍由日志级别控制。

## 关联身份

一次前台请求通过下列字段关联：

| 字段 | 含义 |
|---|---|
| `sessionId` | UI 会话 |
| `runId` | 一次可持久化运行 |
| `threadId` | 可继续的 Agent 对话 |
| `queryId` | Runtime 内的一次 Query 生命周期 |
| `toolCallId` | Provider 产生的单次工具调用 |
| `gatewayRequestId` | 单次模型网关请求 |

主进程在 Agent 操作入口建立异步日志上下文；Query、模型请求、并行工具和后台任务继承
同一组身份。事件显式数据不能覆盖上下文中的权威关联字段。

## 事件约定

| 事件 | 级别 | 内容 |
|---|---|---|
| `agent.request.received` | Info | 请求入口、长度和 160 字符摘要 |
| `agent.request.detail` | Debug | 脱敏、限长后的请求正文 |
| `agent.query.started/completed` | Info | Query 启动模式、结果和耗时 |
| `agent.query.failed` | Error | Query 异常；取消使用 `interrupted` Info |
| `model.request.*` / `model.stream.*` | Info/Error | Provider、模型、用量边界和耗时 |
| `logs/gateway/**` 文件 | — | 每次模型往返的完整请求/返回载荷（非 JSONL 事件流） |
| `tool.call.requested` | Info | 工具身份、参数结构和短摘要 |
| `tool.execution.started/finished` | Info/Warn | 执行状态和耗时 |
| `tool.result.delivered` | Info | 结果块数量、文本长度、图片数量和短摘要 |
| `tool.call.input/output` | Debug | 脱敏、限长后的工具参数和结果 |
| `teammate.tool.started/finished` | Info/Warn | 队友、任务、工具和结果状态 |
| `runtime.audit.persist-failed` | Warn | 审计事件无法持久化，但运行继续 |

## 内容与隐私

- Info 面向默认链路排查，只记录请求摘要和最多 512 字符的工具摘要。
- Debug 预览上限为 8 KiB，并限制对象深度、数组项目数和对象键数量。
- API Key、Authorization、密码、Secret、Token 和 Bearer 内容在序列化时脱敏。
- Base64、图片和可识别的二进制字段不写原文，只记录被省略的字符数量。
- Error 会保留名称、消息、堆栈和错误码，但同样执行凭据脱敏。
- 日志仅写本机，不进行远程遥测或上传；代码中不保留硬编码调试上报端点，Renderer CSP 也不为调试上报保留网络例外。
