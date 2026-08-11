# 端到端质量证据

> 文档类型：现行验证契约 + 本轮目标分层
> 最后核对：2026-08-12
> 事实来源：`tests/`、`src/main/ppt-exporter.ts`、`src/main/deck/`、`src/design-system/evaluation.ts`

本文回答：Agent PPT 的「端到端」要证明什么，以及各层分别用什么手段证明。
它不是 Runtime 不变量；行为事实仍以代码和测试为准。

`npm.cmd test` 全绿只证明协议与确定性编译正确，不证明真实模型、素材网络、
视觉保真或 Office 打开可用。这三件事互相独立，不能塞进一套又慢又脆的万能 E2E。

## 1. 要证明的三件事

| # | 真实性维度 | mock 单测证明不了什么 |
|---|---|---|
| 1 | Agent 闭环 | 真实模型 → 工具 → CommitGate → artifact 能否跑通 |
| 2 | 视觉保真 | SVG → PNG/HTML 是否长对了（`SlideThumbnailService` 依赖 Electron） |
| 3 | 导出可用 | PPTX 在 Office / WPS / Keynote 里能否正确打开 |

分层原则：贵的、脆的、要凭据的**不进**默认 `npm.cmd test`；沿用
`*.integration.test.ts` + `it.skipIf` 门控。

## 2. 分层总表

| 层 | 证明什么 | 状态 | 触发 | 入口 |
|---|---|---|---|---|
| 1 | 真实网关 Agent 闭环 | **Proposed** | nightly / 手动 | 扩展 `tests/agent-gateway.integration.test.ts` 范式；驱动 `AgentService.start()` |
| 2 | 确定性导出回归 | **Implemented** | 每个 PR（默认 `npm.cmd test`） | `tests/export-golden.test.ts` |
| 3 | Electron 视觉像素回归 | **Proposed** | PR 或 nightly | `SlideThumbnailService` golden PNG；非 Electron 的 vitest 不能渲 PNG |
| 4 | Office 兼容近似 | **Proposed** | nightly / 发版 | LibreOffice headless 转 PDF/PNG + 人工真机矩阵 |
| 5 | 工作台 UI smoke | **Proposed** | 发版 | Playwright 驱动 1–2 条主流程，不铺开 |

`src/design-system/evaluation.ts` 是离线启发式，**不是**产品门禁。可挂在 Layer 1
生成物上做分数漂移跟踪，不能单独当质量闸。

## 3. Layer 2（现行）

固定 golden deck → 真实 `DeckExportService`（校验 + `exportToPptx` + postflight）
→ 对比抬升层与 PPTX 包内容。

证明：

- 混合导出层（去文字背景 SVG + 抬升文本框几何/样式）相对 committed golden 未漂移；
- 产品导出路径写出合法 PPTX，且包内 SVG hash / 可编辑文本与抬升层一致；
- speaker notes 与「无可抬升文字」页的契约保持。

不证明：真实模型发挥、Electron 缩略图、Office 引擎渲染。

| 工件 | 路径 |
|---|---|
| 稳定 fixture | `tests/fixtures/export-golden-deck.ts` |
| 抬升层 golden | `tests/fixtures/export-golden-layers.json` |
| 回归测试 | `tests/export-golden.test.ts` |

更新 golden（仅在有意变更抬升/导出语义时）：

```powershell
$env:UPDATE_EXPORT_GOLDEN = "1"
npm.cmd test -- tests/export-golden.test.ts
```

审查 diff 后再提交 `export-golden-layers.json`。不要为了让测试变绿而盲更。

## 4. 其余层（Proposed）

**Layer 1**：真实 provider 驱动 `AgentService.start()`，临时 workspace + 固定 prompt。
只断言协议/文件/页数等确定性事实，不断言模型文案。`it.skipIf` + 凭据环境变量。

**Layer 3**：必须在 Electron 运行时截 PNG。vitest/jsdom 下
`SlideThumbnailService.captureSlide` 返回 `null`。像素 diff 带容差。

**Layer 4**：CI 可用 LibreOffice `soffice --headless --convert-to pdf` 近似抓
「整页 SVG 在异引擎里空白/错位」。真 PowerPoint / WPS / Keynote 仍为发版人工抽查。

**Layer 5**：输入 → 审批 Proposal → 导出，最多 1–2 条 smoke。

## 5. 与相邻文档

- 能力落点与验证矩阵：[工程能力地图](./engineering-capabilities.md)
- 分域评分（评价快照）：[系统能力评价](./capability-scorecard.md)
- 混合导出契约：[Visual Expression System](../presentation/visual-system.md) §6
