---
name: ppt-build
description: 根据锁定的设计规格和逐页计划，逐页编写完整 1280×720 SVG，经 P01 预览闸门后提交 SVG-native deck
when_to_use: 沟通契约、设计语言和每页最终文案均已锁定，需要生成并提交新建 PPT 时
stages:
  - author
  - design
---

# Deck 构建 — SVG-native Executor

## 目标

本技能必须运行在本 Query 已声明的 `create` capability 内；若尚未声明，先调用一次 `BeginPptCapability`。

读取 `design/design-spec.json` 与 `slides/page-plan.json`，把每页直接写成 `slides/svg/P<NN>.svg`。SVG 是页面的唯一视觉事实源；预览和提交都读取这些原文件。

## 开始前

默认目标是完成可用演示，不是穷尽设计可能性。沿用已经确定的文案和视觉语言，发现具体缺陷才修订；不要在思考中先模拟所有剩余页面的 SVG。每轮应落下一份完整产物或一个可完整输出的小批次。

1. 用 `ReadFile` **一次**读取设计规格与完整页面计划（及当前页所引用的素材）；`hasMore=true` 时沿 `nextOffset` 和同一 `expected_version` 续读，直到取得完整文件。不要在后续每一页重复整文件读取。
2. 确认设计规格已经锁定 `argumentMode`、`visualStyle`、`readingMode`、`imageLanguage`、颜色角色与字体角色。
3. 确认每页都有最终的 `finalCopy`、`coreMessage`、`audienceMove`、`rhythm`、`layoutIntent`。
4. 保持页面 id 与文件名一一对应：`P01` → `slides/svg/P01.svg`。
5. 若计划或素材仍不完整，先补齐作者文件；不要用占位 SVG 掩盖缺口。
6. 若 `layoutIntent` 仍是模板名或过于抽象，先用 `WriteFile` 修订 `slides/page-plan.json` 的自然语言意图，再写 SVG。
7. 若尚未加载 `ppt-build` 正文，可与其他已知需要的 `LoadSkill` 同批发出；不要为加载技能单独空转一轮。

## SVG 页面契约

每个文件必须满足：

- 根元素为 `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">`。
- 完整绘制背景、标题、正文、页码、图表、图示、图片框、品牌标记与装饰；不存在提交后再补的自动 chrome。
- 使用原生 SVG 几何、`<text>/<tspan>`、`<image>`、`<defs>`、渐变、clipPath 等可转换结构。禁止 `<script>`、`<foreignObject>`、外部 CSS、运行时脚本和远程 URL。
- 除本地图片外自包含。图片 `href` 必须是 workspace 相对路径，例如 `assets/images/market-map.png`；不得写绝对路径。`PreviewSvgPage` 与 `SubmitSvgDeck` 必须解析同一资源，最终由提交工具内联。
- 所有可见对象都位于 `viewBox` 内；避免靠浏览器默认字体、HTML 换行或未声明样式得到偶然效果。
- 文案以页面计划的 `finalCopy` 为准。不要为了塞入页面擅自删改事实；容量不够时重构构图或按计划拆页。

## 页面级构图

每页先落实 `coreMessage` 和 `audienceMove`，再按 `rhythm` 与 `layoutIntent` 组织焦点、阅读顺序、比例、留白和图文关系。不要从 layout 枚举中选壳，也不要复用固定坐标模板。`layoutIntent` 可以描述几何关系，但不要输出组件槽位、模板名或坐标参数。

对每页依次明确：

1. 主焦点：受众第一眼必须看到什么。
2. 阅读路径：横向、纵向、中心辐射、对照或流程如何与论点一致。
3. 空间比例：核心证据、解释、图片与留白各自占多少页面级面积。
4. 对齐与张力：使用哪些主轴、边界、规则线、重叠或裁切建立秩序。
5. 节奏兑现：
   - `anchor`：用章节命题、关键数字或核心视觉建立记忆点；需要单一强锚点。
   - `dense`：用清楚的网格、路径或证据层级承载近读信息；需要可扫描的证据结构。
   - `breathing`：用大图、单句、单一数字或留白制造转折；需要真正留白，不能重新塞成卡片网格。
6. 风格兑现：几何、字体、颜色、纹理、图片处理和留白必须共同体现 `visualStyle`，不能只换色。

同一 deck 保持设计语言一致，但页面轮廓、焦点位置、密度和图片关系应随论证变化。相似页面可以共享对齐逻辑，不能机械复制同一轮廓。

### 反卡片化

卡片只在确有独立实体、对比边界或交互隐喻时使用。以下不是默认构图：

- 三个等宽圆角矩形承载任意三点。
- 每页都使用相同的 2×2 容器。
- 把流程、架构、证据和大图都降级成卡片列表。
- 用装饰阴影代替信息层级。

优先考虑大字结论、裸文本、规则线、尺度对比、真实图表结构、路径关系、全幅图片和负空间。禁止把每页都做成三卡、四卡或 2×2 圆角容器。

## P01 闸门

1. 先只生成 P01。用一次 `WriteFile` 写完整 `slides/svg/P01.svg`，不要拆成多个临时片段。
2. 同一 assistant 响应中紧随调用 `PreviewSvgPage({"path":"slides/svg/P01.svg"})`（写在前、预览在后），让模型在下一轮直接查看真实 PNG。
3. 同时检查：SVG 合法性、资源可解析、文本未截断、对象未越界、对比度与层级、风格兑现、封面是否形成足够强的第一印象。
4. 失败时直接修订 P01 并重新预览。P01 未通过前不得批量生成其余页面。
5. P01 通过后，将它视为 deck-wide 视觉校准样本；其余页面继承设计语言，不复制其具体构图。

## 逐页生成

按 `slides/page-plan.json` 的顺序工作，但**降低轮次**：

1. 已在开始前完整读过 page-plan 时，不要每页再 `ReadFile` 整份计划。
2. 只为当前页设计完整构图；每次 `WriteFile` 只写一个 SVG 文件。
3. **P01 之外按可完整输出的规模分批写作者源**（不同路径可并行）。页面多或复杂时先写下一页或少量页面，再处理后续页；不要为减少轮次而要求一次写完。批次可直接预览，避免没有产物的旁白轮次。
4. 每批完成后按页调用 `PreviewSvgPage`，逐张查看真实 PNG；文字密集、图片裁剪或复杂图表页尤其仔细。已通过且未修改的页面无需重复预览。
5. 修复必须回写同一 SVG 并重新预览；禁止用提交阶段的 fallback 隐藏问题。
6. 阶段切换时可用 1–2 句说明意图；禁止“继续推进…”类空话与逐条复述工具名，不要为旁白拆开可同批的写入/预览。

## 最终提交

以实际 PNG 作为视觉证据：内容完整、假设标识清楚、文字可读、无明显裁切重叠且风格一致即可提交。缺少渲染或存在阻断缺陷时说明未完成；没有具体缺陷时停止装饰性优化。

提交前核对：

- 所有页面文件存在，编号连续并与页面计划顺序一致。
- 每页都是完整 1280×720 SVG，含自己的标题、页码和背景。
- 所有图片均为可读取的 workspace 相对路径，且没有远程依赖。
- 每个新建或改动页面的当前 SVG/素材哈希都有成功 PNG 预览，且没有仍未处理的阻断问题。
- deck 内至少有有意义的节奏变化，且没有全套卡片化。

只调用一次 `SubmitSvgDeck`，提交按顺序排列的 SVG 源文件及必要的 deck 元数据。参数必须显式包含 `"designSpecPath":"design/design-spec.json"` 和 `"pagePlanPath":"slides/page-plan.json"`；`communication` 原样使用设计规格的 `communicationContract`，`designSystem` 原样使用 `presentationDesignSystem`。每页提交项必须携带 page plan 中同序的 `id`、`path`，且 `narrative.role` 对应 `narrativeRole`，其余 narrative 字段也逐字来自 page plan。提交工具会重新读取两个锁文件并拒绝任何轴、页序、id、path 或 narrative 漂移。

若 `SubmitSvgDeck` 因 SVG 或素材错误拒绝提交，修复作者 SVG/素材后再次提交；不要把失败报告为完成。

作者源是完整页面 SVG；标题、页码、背景与品牌条等可见对象须画在 SVG 内；提交路径仅为 `SubmitSvgDeck`。已存在 SVG 的重排由 `ppt-edit` 或 `ppt-beautify` 直接修改作者源。

## 协作边界（条件性）

- **Lead（主 Agent）持有页面 SVG 作者权、P01 闸门、Preview 与 Submit。** 不要把逐页 `WriteFile` SVG、`PreviewSvgPage` 或 `SubmitSvgDeck` 拆给 teammate；一致性与看图校准在 Lead 上下文内更便宜，且锁文件不得多作者并发写。
- 默认 solo。仅当用户明确要求多 Agent 时，可安排**独立辅助**工作：素材清单核对、事实/口径对照 page-plan 的只读核验、跨页结构建议等。委派必须包含目标、输入引用及版本、只读或受限写入范围、交付格式与验收条件；Lead 读取实际结果后整合，不能只接受「已完成」消息。
- teammate 若无真实渲染图能力，其结论只能称为源码/事实核对，不能称为视觉验收。
- 用户要求多 Agent 但工具/权限不可用时：说明无法满足的部分，不静默改成 solo 并声称已满足；可先完成 Lead 已授权的作者工作。
