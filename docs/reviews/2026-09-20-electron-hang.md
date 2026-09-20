# 22:45 多 Agent 无响应核验

## 已确认事实

- 用户运行 `ea0f5ddb-0a2a-42ad-a8f7-1258dbdc080d` 的应用日志从 22:44:40 到 22:45:12；8 次模型请求启动，6 次完成，剩下主/子 Agent 两次请求没有完成记录。
- Windows Application 事件在 22:46:34 记录本项目 `node_modules/electron/dist/electron.exe` 的 AppHangB1（未响应）。报告 ID：`2552886a-9491-4916-bec7-5085d61a5344`。这是挂起证据，不是 OOM 或 JavaScript 异常的证明。
- 此次应用日志没有 renderer.process.gone、DataCloneError 或内存溢出证据；未完成响应没有网关归档，无法据此量出最后两次请求的思考长度。
- 子 Agent 的三次 web_search 均因 Tavily 未配置失败。这是已知配置失败，没有证据表明它直接导致 Electron 卡死。

## 本次修复

`useAgentActivityStream` 原先只对主 Agent 的 thinking-chunk 合并与限长。teammate-thinking-chunk 仍逐片段写 React 状态，且每个子 Agent 片段会触发主 Agent 缓冲刷新，削弱原有合并效果。

- 子 Agent 思考按 runId + activityId 缓冲，100ms 合并，每个 assignment 的实时展示最多 8000 字符加截断说明；完整网关响应不裁剪。
- 主、子思考交错不再互相强制刷新；工具和完成事件前刷新，保留同一任务内的事件顺序。
- 子任务在主任务结束后继续运行时，更新所属历史消息，不污染新任务；卸载时释放计时器。
- 新增窗口 unresponsive/responsive 日志。缓存 webContentsId，避免 closed 回调读取已销毁 webContents 而产生第二个异常。

这修复了可确认的流式展示遗漏，但未取得原始挂起线程栈，也未复现用户原始故障，不能认定这是唯一根因。主进程阻塞时，新增窗口事件日志也不保证能够及时写出。

## 验证

- 新增交错流、长度上限、工具顺序、主任务结束后更新、跨 session 隔离、卸载清理的回归场景；相关文件 6 项测试通过。
- `npm.cmd run build` 通过（含 typecheck）。`npm.cmd test`：165 文件通过，1123 测试通过、1 跳过。修改文件 Biome 与 diff 空白检查通过。
- 隔离用户目录，真实 Electron + Vite 开发渲染器 + localhost 模拟 Anthropic SSE；通过 UI 发送请求，由应用实际 spawn_teammate 执行。主、子各 1600 个片段，共各 128000 字符思考；两路请求均完成。随后展开执行记录、发送第二条用户消息并收到回复。
- 未记录 renderer.unresponsive、renderer.process.gone、页面异常或 DataCloneError；关闭应用记录 application.stopping，没有原先的 Object has been destroyed 异常。
- 证据目录：`logs/verify-teammate-hang/`，包含 requests.jsonl、app-logs/gateway、console.log、ui.txt、result.png。测试输出：`logs/hang-fix-tests.txt`、`logs/hang-fix-build.txt`。

这是流式展示及应用交互的模拟网关压力验证，不是真实模型生成质量验证，也不证明所有无响应原因已消除。
