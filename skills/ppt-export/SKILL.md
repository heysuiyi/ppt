---
name: ppt-export
description: 说明并预检 SVG-native deck 的产品导出流程；真实导出只由 Renderer 的导出入口触发
when_to_use: 用户询问如何导出、下载或生成最终 pptx 文件时
stages:
  - export
  - style
---

# 导出 SVG-native PPTX

## 目标

帮助用户确认 deck 已具备导出条件，并引导用户使用应用内的“导出”入口。真实导出由 Renderer 只提交 `sessionId + options`，Main 读取权威 Presentation、让用户选择目标路径，并创建 export capability、幂等副作用 claim 与 ExportArtifact revision。

## 前置检查

1. 用 `ListSlides` 取得已提交 deck 的完整有序页面清单。
2. 对每页确认：
   - `svgSourcePath` 与 `svgSha256` 存在，表示该页拥有已提交 SVG visual source；
   - 页面顺序与 `slides/page-plan.json` 一致；
   - 没有占位页或重复 `svgSourcePath`。
3. 若页面来源不完整、存在占位页或用户提到刚修改过作者文件，引导其先回到 SVG 预览/提交流程。
4. 若存在绑定当前 revision 的 QualityReport，核对阻断问题；用户要求正式核验或已有具体质量疑点时再使用 `ppt-review`。缺少独立报告不自动触发整套审查。review 只报告，需要修复时另开 edit/restyle capability。

## 工作流

1. 告知用户在应用的演示工作台点击“导出”，由系统弹出目标路径选择。
2. 不调用、搜索或发现 `ExportPptx`，也不通过 Agent 工具直接写导出文件。
3. 导出完成后，以 UI 中独立的 Export completed 事实和 PptJob 投影为准；不要把 Query completed 或 Proposal ready 表述为已经导出。
4. 任务路径若将导出标为交付终点，不要因 workspace 存在 page-svg 就推荐 edit；先确认当前已应用版本与未提交修改状态。

## 约束

- 导出是只读交付动作，不修改 SVG 作者源或 deck revision。
- Agent 不上传 Presentation 快照、不代替用户选择路径，也不绕过 Main 的权威读取与 side-effect claim。
- SVG 中显式引用的 workspace 相对图片必须由提交流程内联；导出阶段不重新下载远程资源。
- 不导出空 deck、占位页或 source/hash 不完整的 deck。
- 本技能只负责 PPTX；其他格式需要独立、明确的导出能力。
- 不要暗示「导出即完成审查」；审查与导出是不同交付终点。

## 衔接

通过证据是 UI 的 Export completed 与实际导出产物。仅完成预检时明确“可导出”；用户取消选择或导出失败时不声称文件已生成。没有导出结果可观察时说明尚未验证导出完成，不反复改稿试图补足证据。

标准链路：brief → design spec → page plan → SVG pages → `SubmitSvgDeck` →（可选）`ppt-review` 报告 → 用户在 UI 导出。路径推荐只组合能力，不替代 Export completed 事实。
