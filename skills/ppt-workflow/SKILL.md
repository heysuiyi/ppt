---
name: ppt-workflow
description: 以完整页面 SVG 为唯一视觉事实源，完成从沟通契约、设计锁定、逐页规划、P01 校验到整套提交的新建 PPT 工作流
when_to_use: 用户要从零新建、批量生成或一条龙完成整套 PPT 时
stages:
  - discover
  - author
  - design
---

# SVG-native 端到端工作流

## 与任务路径的关系

本技能描述**新建 deck** 时作者链的依赖关系，不是所有请求的固定机器。先看用户交付终点与（可选）`SetPptTaskAssessment` 路径推荐：只要大纲/内容、只审查、只导出不必穿过整条 SVG 作者链。已有有效的 design-spec / page-plan / 页面源按事实复用，只补缺口；不因加载了 workflow 就重做已完成工作。

## 权威来源

新建流程只认 `slides/svg/P<NN>.svg` 为页面视觉作者源。设计规格和逐页计划描述意图，不能在预览或提交时补出任何可见对象。图片可以作为 workspace 资源被 SVG 显式引用；除此之外，页面的背景、标题、正文、页码、图表、图示和装饰都必须已经存在于 SVG 中。

预览与提交必须消费同一份 SVG。页面视觉只来自作者 SVG；标题、页码、背景与品牌条等可见对象须画在 SVG 内。产品作者路径仅为 `PreviewSvgPage` → `SubmitSvgDeck`。

## 固定顺序（新建作者链）

顺序描述依赖关系，不是“一步一轮”。参数已知且互不依赖的调用应同批发出。

1. 若本 Query 尚未声明 PPT 工作，先调用一次 `BeginPptCapability({"capability":"create", ...})`。恢复同一 waiting-user Query 时沿用该 request；新的跨请求继续操作会获得新的 QueryId，但推进同一 PptJob。
2. 建立沟通契约：`audience`、`objective`、`desiredOutcome`、deck-wide `coreMessage`、`deliveryContext`、`afterUse`。只有缺少会改变内容事实或交付目标的信息时才询问。
3. 需要技能正文时，可同批 `LoadSkill("ppt-design")`（以及已知随后需要时的 `LoadSkill("ppt-design-layout")` / `LoadSkill("ppt-build")`），不要一技能一轮。应用 `ppt-design`：若 workspace 已有 `design/template-pack.json` 或 `template-policy` 为 `custom`，先 `ResolveProjectTemplate`（必要时同批 `GetDesignReference`），沿用 pack 的 designSystem/typography/chrome/assets，**不得另选 builtin 风格**；否则再按沟通信号解析模板。将结果写入 `design/design-spec.json`（`selection` → `resolvedTemplate`）。
4. 应用 `ppt-design-layout`，为每页冻结 `finalCopy`、`coreMessage`、`audienceMove`、`rhythm`、`layoutIntent` 和素材引用，按顺序写入 `slides/page-plan.json`。若 design-spec 已写完且 layout 技能正文已在上下文中，本步写入可与同批工具一起发出；阶段切换时用 1–2 句说明意图即可，不要为空话单独开一轮。
5. 应用 `ppt-build`。先用 `WriteFile` 只写 `slides/svg/P01.svg`；同一 assistant 响应中可紧随 `PreviewSvgPage({"path":"slides/svg/P01.svg"})`（写在前、预览在后）。当前锁契约仍要求 P01 先行；路径评估可将复杂页选为代表页，但不能在未修改预览凭据要求的前提下假定「跳过 P01 已生效」。
6. 查看 P01 PNG：若有越界、缺字、素材失败、视觉层级或 SVG 兼容问题，修改同一个文件并重新预览；P01 未通过前禁止生成 P02。看图校准是必要轮界；可简短说明校准结论，不要用“继续推进”类空洞套话填充。
7. P01 通过后，按可完整输出的规模分批写剩余 SVG（不同路径可并行）；页面多时先完成下一页或少量页面，不在一次响应中强求全套。不要每页重复读取已完整取得的 page-plan。
8. 每批页面写完后按页调用 `PreviewSvgPage`，确保每个新建或改动 SVG 的当前内容与素材都成功产出 PNG。任何修订都会使旧凭据失效，必须重新预览该页；未修改的成功页面无需重复预览。
9. 最后只调用一次 `SubmitSvgDeck`（`execution.batch=exclusive`，必须独批），显式传入 `"designSpecPath":"design/design-spec.json"`、`"pagePlanPath":"slides/page-plan.json"` 及有序 SVG 页面。`communication`、`designSystem`、每页 `id/path/narrative` 必须原样来自这两个锁文件；提交工具会重新读取并核对，再校验与内联 workspace 相对图片。任何锁漂移或页面失败都不视为完成。

## 轮次纪律

- 开场目标、用户决策与收尾交付须写正文；阶段切换或本轮将发出 tool_use 时，须先输出 1–2 句可见 Markdown 意图，再发本批工具——不要把意图只写在思考通道里。
- 禁止“继续推进 / 接着锁定 / 下一步我将…”类空洞套话，也不要逐条复述即将调用的工具名；不要为旁白把可同批的独立工具拆成多轮。
- 必要轮界主要是：capability 声明、依赖 skill 正文后的首次写入、P01 看图校准、预览失败后的修订、以及独批的 `SubmitSvgDeck`。

## 作者文件

- `design/design-spec.json`：沟通契约和 deck-wide 设计锁。
- `design/template-policy.json` / `design/template-pack.json`：项目模板策略与可执行参考模板 pack（若已应用）。
- `slides/page-plan.json`：有序逐页内容与构图意图。
- `slides/svg/P01.svg`、`P02.svg`……：唯一视觉作者源。
- `assets/**`：SVG 显式引用的本地图片或其他资源（含 `assets/template/**` 提取的 logo 等）。

设计规格和页面计划可以重建；一旦开始写 SVG，任何可见修改都必须直接修改对应 SVG，不能只改计划后期待提交工具代为更新。

## 协作边界

Lead 持有 design-spec / page-plan / 页面 SVG 的最终写入与 `SubmitSvgDeck`。多 Agent 仅用于用户明确要求时的独立辅助（资料整理、事实核对等）；见 `ppt-research` / `ppt-build` 的条件性协作说明。不要把同一页或同一锁文件交给多个作者。真实工具/权限限制不可被用户意图评估字段覆盖。

## 页面硬约束

- 画布固定为 `1280 × 720`，根节点使用 `viewBox="0 0 1280 720"`。
- SVG 必须是完整 `1280 × 720` 页面构图，不是局部片段。
- 禁止自动 chrome；若要标题、页码、章节标、品牌条或背景，必须在每页 SVG 中明确绘制。
- 禁止把全套内容默认做成等宽圆角卡片网格；卡片仅在语义确实需要分组时使用。
- 图片 `href` 使用 workspace 相对路径，例如 `assets/images/hero.jpg`；禁止远程 URL。提交时由 `SubmitSvgDeck` 内联同一字节。
- 除显式引用的本地图片外，SVG 自包含：不依赖外部 CSS、脚本或运行时布局。

## 完成条件

默认验收可用结果：用户要求已覆盖、事实与示例假设清楚区分、内容可读且无明显裁切重叠。以实际页面和工具结果为证据，不以遵循了多少流程评分。没有具体缺陷时停止润色；不要自行扩大页数、研究范围或设计复杂度。

只有在 P01 闸门通过、全部新建或改动 SVG 的当前版本均通过真实 PNG 门禁、页面与 `slides/page-plan.json` 一一对应、最终 `SubmitSvgDeck` 成功后，才能宣告新建 deck 完成。用户只要内容草稿时可以停在 `slides/page-plan.json`，但不得生成或提交占位页面。Proposal ready 与 Presentation applied、QualityReport 与 export completed 必须分别报告，不能互相替代。
