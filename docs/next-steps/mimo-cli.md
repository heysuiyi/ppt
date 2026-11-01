# 前序已完成切片：MiMo 与 CLI

[返回计划目录](README.md) · [项目整体规划](../project-plan.md)

以下为历史记录，不构成本轮实施验收。

## 前序已完成切片：MiMo 与 CLI

状态：MiMo 原生接入已实现并完成本地协议、真实 Electron 设置组件/开发入口及小范围实际 CN 验收；完整方案与分层证据见 [mimo-token-plan-cn 具体实施方案](../mimo-token-plan-cn.md#11-实施与验收记录2026-10-31)。未切换生产聊天或迁移 PPT 能力、生产会话；已有自定义连接不自动升级。

1. `src/models/` 原生 provider：固定 CN 连接、发现、generate/stream、有序内容/函数调用、私有 output 重放、取消及关闭；52 项真实 SDK/本地 HTTP/SSE 回归通过。
2. 连接预设、发现选择、模型级 `reasoningEffort`、签发 adapter/effort 与生产受理前保护贯通；真实 Electron 设置组件经管理 IPC/safeStorage 验证本地与实际 CN 发现、保存及重开。
3. 开发宿主显式路由 MiMo，模型/tools 借用 Logger；真实 Electron 本地入口覆盖 EOF waiting、审批、新进程恢复、拒绝/取消、预算/强度变更拒绝与租约释放。
4. 实际 CN 仅验收 `mimo-v2.6-flash` / `high`：普通问答、流式取消、文件工具等待后新进程恢复与取消；`/models` 返回 6 项，ASR/TTS 明确未支持。Pro 与其他 effort 的远程行为未验收。
5. 审核发现的三项 Bug 已修复：旧配置不按 URL 隐式升级原生 MiMo，宿主保留安全模型错误分类，MiMo 预算上限不影响其他厂商。修复与本地/CLI 验证证据见[审核后修复](../mimo-token-plan-cn.md#115-审核后修复)；本轮未切换 UI 或移除旧 Gateway。
6. 新执行链已删除 Gateway 桥接工厂及兼容执行、日志包装和归档开关；仅支持显式原生适配器，未接入配置在解析凭据前以 `MODEL_ADAPTER_UNSUPPORTED` 拒绝。开发宿主与 Electron 集成的文件/审批/恢复场景迁到原生 SDK/本地 SSE，旧生产链路保持独立；本次证据见[删除 Gateway 兼容路径](../mimo-token-plan-cn.md#116-删除-gateway-兼容路径)。
7. 历史切片曾新增 `--list-models`，以管理快照展示已保存模型及本地状态；当时类型检查、7 个文件 Biome、189 个文件/1587 项回归及 2 个 Electron 集成通过。该启动参数及命令示例已由下一项交互入口取代，保留模型可用性投影供向导复用。
8. CLI 参数收敛为无参数循环、`--prompt` 单任务和帮助。无可用默认模型时按厂商/连接 → 明文 Key → 模型引导配置，复用现有加密凭据与模型发现，保存 `cli.defaultModelId` 后继续原任务；非 TTY 缺配置明确失败。循环支持 `/model`、`/new`、`/resume`、`/tools`，配置变更新建会话，恢复按连接指纹匹配原配置，保留现有 v2 绑定。真实 Electron/safeStorage 到本地 HTTP/SSE 已覆盖首次向导、重启复用、EOF waiting、批准/拒绝/取消、预算/强度变更拒绝；独立运行烟测额外观察到一次发现、三次模型执行、两轮历史恢复及原 prompt 仅执行一次。实际 Node 启动器帮助和非交互缺配置退出均已运行。类型检查、17 个代码文件 Biome 和全量 191 个文件/1605 项回归通过，2 项按既有条件跳过。本轮未增加远程厂商调用或 UI/PPT 迁移。
9. CLI 工作区权限统一为两种工具模式下 `read/glob/grep` 自动允许、已启用的 `write/edit` 逐次审批；未安装工具和工作区外访问仍拒绝，路径/UTF-8/大小/版本校验不变。已有 v2 绑定和待决交互格式不变，旧只读待决仍需匹配回答一次。真实 Electron/safeStorage 到本地 HTTP/SSE 覆盖自动读取、写入 EOF waiting、新进程批准/拒绝/取消和租约释放；独立烟测实际执行 glob→grep→read，零次只读审批，写入批准前无文件、批准后内容匹配随机校验码。类型检查与 4 个文件/33 项相关回归通过；本轮不调用远程厂商、不更改生产 UI 或旧 Agent 授权策略。

本次权限切片补充验证：全量回归为 191 个文件、1608 项通过，2 项按既有条件跳过；5 个受影响代码文件通过 Biome，实际 Node 启动器帮助显示新权限。临时烟测文件、数据库、工作区和构建目录已清理。

范围、具名接口、文件落点、请求与流式映射、重放载荷及恢复兼容性仍以[完整实施方案](../mimo-token-plan-cn.md)为准。后续业务切片不由本轮自动授权；M1 公开面整轮收敛不是此次前置条件。[logs/tools 设计与验收](logs-tools.md)保留原第 1–11 节的设计和历史证据，不扩大本次迁移范围。

