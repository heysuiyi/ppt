---
name: ppt-review
description: 基于逐页 SVG 真渲染审查整套演示的硬性错误、设计兑现和跨页节奏；review capability 下只出报告，改稿须另开 authoring capability
when_to_use: SVG 页面生成、编辑或换肤后，导出前，或用户要求视觉审查时
stages:
  - style
  - export
---

# SVG-native Deck 视觉审查

## 前提

1. 若本 Query 尚未声明 PPT 工作，先调用一次 `BeginPptCapability({"capability":"review", ...})`。审查 Query 保持 `review` capability。
2. 用 `ListSlides` 取得完整有序页面及每页已提交的 `svgSourcePath`、`svgSha256`。
3. 当前页可用 `ReadCurrentSlide` 确认 `visualSource.sourcePath`；其他页使用 `ListSlides.svgSourcePath`。再用 `ReadFile` 分页读取完整 SVG，沿 `nextOffset` 和同一 `expected_version` 续读到 `hasMore=false`。
4. 对每个作者源调用 `PreviewSvgPage`，检查该文件的真实渲染。页面已提交时可用 `PreviewSlide` 对照当前 deck，但不能用已提交预览替代源文件审查。
5. 读取 `design/design-spec.json` 和 `slides/page-plan.json`，只用于核对设计与内容意图；它们不能补充 SVG 中缺失的可见对象。

没有逐页渲染结果时，不把 XML 结构或 hash 检查冒充视觉验收。若 `svgSourcePath`/`svgSha256` 缺失，或 `PreviewSvgPage` 返回的当前源 `sha256` 与已提交 `svgSha256` 不一致，先报告来源漂移并阻断导出判断。

审查顺序：硬性渲染错误 → 页面意图兑现 → 软性构图 → 跨页节奏与一致性。

## 模式选择（capability 契约）

**review capability 的交付终点是 QualityReport，不是改稿提交。**

| 用户意图 | 推荐行为 | 状态 |
|---|---|---|
| 只要报告 / 不要修改 | 只读审查 → `SubmitPptReview` | 可执行 |
| 审查并修复 | **不要**在 review 下改稿。可执行方案：新开 `BeginPptCapability({"capability":"edit"|"restyle"})`，inspect 阶段套用本检查表，修复后 `SubmitSvgDeck` | 可执行（本路径不产出 QualityReport） |
| 先正式报告，再改稿 | 本 Query 只 `SubmitPptReview`；改稿必须在**新的用户请求/Query** 中开启 authoring capability | 跨 Query 交接 |
| 同一 review Query 内修复并 `SubmitSvgDeck` | 不可执行 | unsupported |

约束依据：
1. `SubmitSvgDeck` 的 allowedCapabilities 仅为 `create` / `edit` / `restyle`，**不含 review**。
2. Orchestrator 按 QueryId 绑定 capability；同一 Query 再开其他 capability 会抛 `already opened a different PPT capability request`。

不要为补全路线而放宽 ACL。路径推荐把「author-with-inspect」标为可执行修复路径，把「review 下同 Query 提交 deck」标为 unsupported。

## 硬性规则：必须记录

| 规则 | 问题 | 报告中的修复方向 |
|---|---|---|
| H1 | SVG 不是完整 `1280×720` 页面或对象越过 viewBox | 修正根画布、重排或缩放 |
| H2 | 文本被裁切、出界或无法完整阅读 | 调整 SVG 换行、宽度、层级或页面构图 |
| H3 | 正文、标题或关键证据发生非语义重叠 | 打开间距或重构当前 SVG |
| H4 | 小字对比度 <4.5；24px+ 对比度 <3.0；复杂图片上文字无 scrim | 调整语义色、位置或 scrim |
| H5 | 页面计划要求的标题、页码、背景、来源或品牌锚点未在 SVG 中出现 | 直接恢复到作者 SVG |
| H6 | 图片为空、损坏、变形、错误裁切主体或 workspace 路径不可读 | 修复本地素材或 SVG 的 image/crop |
| H7 | `finalCopy`、核心证据、数据或明确素材在 SVG 中缺失 | 从 page plan 恢复，禁止运行时补齐 |
| H8 | SVG 使用远程 URL、绝对路径、脚本、`foreignObject` 或其他不支持依赖 | 本地化、移除或改写为受支持 SVG |
| H9 | 当前 workspace SVG hash 与已提交 `svgSha256` 不一致 | 重新预览并用整套 source 重新提交 |

deck-wide 颜色、字体或 visual style 问题标为系统级；修复建议是逐页改作者 SVG，不能只改设计规格并假设页面自动更新。

## 设计意图检查

逐页对照：

- `finalCopy` 和事实是否完整、准确。
- `coreMessage` 是否形成一个清楚的视觉主张。
- `audienceMove` 是否真的由页面表达出来
- `layoutIntent` 指定的焦点是否是视觉最突出的元素
- `rhythm` 是否兑现
  - anchor：有清晰单一锚点
  - dense：高密度但仍可扫描
  - breathing：留白充分、元素克制
- 选择的 visual style 是否不只是换色，而是体现在形状、边框、阴影、留白、字体、背景、图片处理与构图
- argument mode 是否体现在标题语气和页面推进方式

## 软性规则：明显不好才记

| 规则 | 触发 |
|---|---|
| S1 | 同一文本块行距过紧或过空 |
| S2 | 本应共线的元素偏移 >4px |
| S3 | 同行图形、图像或确有语义的卡片间距不均 |
| S4 | 视觉重心明显偏离 layoutIntent |
| S5 | 一页出现过多无语义 accent、阴影或装饰 |
| S6 | 图片与 caption 距离过大，或图片与论点无关 |
| S7 | breathing 页出现卡片网格或过量正文 |
| S8 | 同类页面无理由地改变字体、圆角、边框或色彩语义 |

软问题以克制记录；不为追求分数编造问题。review Query 本阶段不落盘修改。

## 跨页检查

- 一套 deck 只有一个 argument mode、visual style、color scheme、reading mode。
- 5 页以上至少两种 rhythm。
- 不连续 3 页使用相同轮廓、焦点位置、阅读方向与 rhythm。
- narrative / showcase 通常每 3–5 页有 breathing beat。
- anchor 页比例合理；不能每页都“重点”。
- 图片、图表和数字锚点分布服务叙事，不是平均撒满。
- 标题、页码、背景与品牌锚点在 SVG 内保持有意的一致性，不依赖自动 chrome。
- 全套不能退化成统一的三卡、四卡或 2×2 圆角网格。

## 协作边界（条件性）

- 默认由主 Agent 完成审查与报告。
- 用户明确要求多 Agent，且 teammate 具备**真实渲染结果**获取能力时，可委派独立视觉核对；只有源码读取能力时只能做源码/事实核对，不得声称完成视觉验收。
- 委派必须写清：目标、输入引用及版本（svg 路径/hash）、只读范围、交付 findings 格式、验收条件。Lead 读取实际结果后汇总；不能只接受「已完成」消息。
- Lead 负责最终 `SubmitPptReview`；teammate 不得提交 QualityReport，也不得在 review Query 内改 SVG。

## 输出

把以下内容整理为 `SubmitPptReview` 的结构化 `verdict / summary / overallScore / findings` 并提交；只有该 QualityReport 成功绑定当前 PresentationRevision，本次 review request 才完成。Markdown 可作为给用户的可读摘要，但不能代替结构化提交。

```markdown
## 审查摘要
- 视觉来源：N/N 页 `svgSourcePath` + `svgSha256` 有效
- 设计方向：argumentMode / visualStyle / readingMode / imageLanguage
- 节奏：anchor N / dense N / breathing N
- 严重：N | 设计偏差：N | 建议：N
- 修复授权：review capability 只出报告；待修复项需另开 edit/restyle

## 必须修复
1. [页码][规则] 证据 → 最小修复方向

## 设计偏差
1. [页码] plan 意图与实际呈现的差异

## 建议
1. ...

## 通过项
- ...
```

## 边界

- 审查基于 `PreviewSvgPage` 与作者 SVG/锁文件。
- 不因自动分数好看而覆盖真实视觉判断。
- review Query 不写 SVG、不调用 `SubmitSvgDeck`。
- 不把缺失标题、页码、背景或图表归因于“导出时会自动补”；SVG 页面本身必须完整。
- 用户只要报告时明确只读；用户要求修复时仍先出报告，再说明需另开 authoring capability。
