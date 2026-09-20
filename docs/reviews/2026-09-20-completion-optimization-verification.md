# 完成优先优化：实现与运行验证

## 实现

- System prompt 的工具索引只保留名称、风险、审批和执行约束；用途和参数交给原生 tools schema，避免重复。原生工具集合和权限校验保留。
- System 与 workflow/design/layout/build 技能明确可用完成标准：内容覆盖、事实/假设可辨、可读、无明显裁切重叠、当前版本预览与提交有效。没有具体缺陷时停止润色，不自行扩大页数或研究范围。
- 将“同批写完所有剩余页面”改成可完整输出的批次；每轮完成具体产物，不在思考里预演整套 SVG。首次任务评估不猜路线 ID。
- 对 reasoning-only + max_tokens 的响应，保持原预算，附加下一项具体行动指引，只重试一次；再次发生则明确失败。正常正文截断仍保留原有恢复逻辑。
- 前端思考流每 100ms 合并发布，每个 modelStep 的实时展示上限约 8,000 字符，后续文本、工具事件和结束前先刷新待发布内容。完整响应仍进入 Gateway 档案，实时展示不是完整审计记录。

## 运行验证：恢复与界面路径 PASS

参考用户提供的 verify Skill 和 CLI 验证示例，并使用 computer-use Skill 从真实窗口操作。启动项目的 Electron 开发实例，隔离 USERPROFILE、应用数据、日志和本地模拟网关；没有读取真实凭据或调用付费模型。验证对象是当前工作区，前一阶段改动已在恢复工作时包含于 HEAD `ffb456c`，本次没有创建提交。

本地网关在真实 Anthropic SSE 接口上，每个压力响应发送 1,200 个 thinking delta、共 75,600 字符，再返回 max_tokens。通过实际聊天输入框发送三条请求，经过 Renderer → IPC → Runtime → Gateway → SSE → Renderer 全链路。

| 界面动作 | 观察结果 | 证据 |
|---|---|---|
| 输入并发送长思考验证请求 | 第一轮耗尽后第二轮正常回答，界面显示“验证完成”，未崩溃 | `logs/verify-completion-2026-09-20/ui-success.txt`，对应 Gateway 档案 |
| 输入并发送连续无产出请求 | 两轮耗尽后明确显示“本次处理未完成”，没有继续放大预算或自动无限重试 | `ui-exhausted.txt`、应用 `agent.query.failed` |
| 失败后继续输入并发送新请求 | 正常收到回复，输入和对话仍可使用 | `ui-after-failure.txt`、第二条 `agent.query.completed` |

`requests.jsonl` 的 5 次实际 HTTP 请求均为 `max_tokens:16384`，第 2、4 次带恢复指引。原始压力响应完整保留 75,600 字符思考；验证过程中未出现 `renderer.process.gone`、React DataCloneError 或 `Performance.measure` 内存异常。证据目录为项目 `logs/verify-completion-2026-09-20/`，包含模拟网关启动脚本、真实应用日志、请求计数和界面可访问性记录；截图在本次对话的工具结果中。

新请求 system prompt 为 13,667 字符，恢复时 13,966 字符，仍携带 41 个原生工具。历史失败任务 system 为 32,788 字符；两次任务动态上下文略有差异，该比较说明实际请求已精简，不是严格同输入的性能对照。

## 静态和回归检查

- `npm.cmd run typecheck` 通过。
- `npm.cmd run build` 在前阶段通过；后续只修正测试契约和格式，没有新增行为更改。
- `npm.cmd test`：165 个文件通过，1121 项通过、1 项跳过。
- 相关 7 个文件 Biome 检查通过，`git diff --check` 通过。
- 旧 prompt 缓存测试原先要求在 system 中重复 description/参数；已调整为新契约，同时保留同名工具变化使缓存失效，以及风险和审批元数据断言。

## 限制与独立发现

- 模拟网关验证了恢复边界和界面承载路径，没有验证真实 deepseek-flash 是否更少思考或更快完成整套 PPT。Skill 的实际生成质量仍需同任务对照，不能用此 PASS 代替真实模型质量结论。
- 没有进行 heap profile，也不能断言已经定位或消除了历史崩溃的所有根因。
- 关闭隔离窗口时出现已有的 `Object has been destroyed`：窗口 closed 回调读取已销毁的 webContents。发生在三条验证完成后的退出阶段，不是思考流崩溃；本次仅记录，不扩大到窗口生命周期修复。
- 上一阶段中断的验证记录留在 `logs/verify-completion/`，不作为通过证据；本报告使用本次重新执行的独立目录。
