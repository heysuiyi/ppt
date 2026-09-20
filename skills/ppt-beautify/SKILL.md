---
name: ppt-beautify
description: 直接编辑 SVG 作者源以优化构图、排印、图表、图片和跨页一致性，并用同源预览验证
when_to_use: SVG-native deck 已生成，需要视觉美化、排版修复、内容精简、统一风格或单页润色时
stages:
  - style
---

# SVG 美化与增强

## 目标

在不重建整套 deck 的前提下，直接改善目标页的完整 SVG。所有视觉修改都写回其 `visualSource.sourcePath`。

默认保留事实、页面职责和未涉及页面。只有用户明确要求改写或压缩内容时才改变 `finalCopy`，并同步 `slides/page-plan.json`。

## 执行

1. 若本 Query 尚未声明 PPT 工作，先调用一次 `BeginPptCapability({"capability":"restyle", ...})`。
2. 用 `ListSlides` 获取完整有序页面清单及每页 `svgSourcePath`、`svgSha256`。
3. 目标是当前页时用 `ReadCurrentSlide` 确认 `visualSource.sourcePath`；其他页使用 `ListSlides.svgSourcePath`。再用 `ReadFile` 分页读取完整 SVG，沿 `nextOffset` 和同一 `expected_version` 续读到 `hasMore=false`。
4. 对照 `design/design-spec.json` 与 `slides/page-plan.json` 判断问题来自当前页还是 deck-wide 设计语言。
5. 直接修改 SVG 中的文字、几何、图表、图片、分组、渐变、裁切和装饰。用 `WriteFile` 将完整 SVG 写回原路径。
6. 对每个新增或修改页调用 `PreviewSvgPage` 并查看真实 PNG；有具体的越界、溢出、重叠、图片失败或层级问题时修源并重新预览。未修改且 hash 与当前已提交页面一致的作者源可以直接复用。
7. 全部修改页通过后，调用一次 `SubmitSvgDeck`，提交所有有序页面。未修改页也必须包含在提交列表中，以保持完整 deck。参数显式使用 `"designSpecPath":"design/design-spec.json"` 与 `"pagePlanPath":"slides/page-plan.json"`，并让 `communication`、`designSystem`、每页 `id/path/narrative` 与锁文件完全一致。

## 美化判断

### 构图

- 先恢复 `coreMessage` 的主焦点，再调整阅读顺序、尺度、对齐和留白。
- `anchor` 保持单一强锚点；`dense` 提升扫描性；`breathing` 不重新填满。
- 重排是对完整 SVG 的页面级重构，不是把内容换进另一个壳。
- 卡片用于确有语义边界的实体；只在重复结构妨碍表达时调整，不为版式数量强行变化。

### 排印与文案

- 保持设计规格中的字体角色与语义色；正文对背景对比度至少 4.5:1。
- 优先通过宽度、层级、换行和构图解决溢出，不靠无限缩小字号。
- 未授权改写时保持文字、数字、日期、链接、专名和来源不变。
- 用户要求精简时，先保存所有事实 token，再同步页面计划的 `finalCopy`。

### 图表、表格与图片

- 只根据明确数据修改或重绘图表；不得从叙述性文字臆造数值。
- 表格、图表与关键数字应成为真实 SVG 结构和文本，而非模板占位。
- 图片使用 workspace 相对 `href`，由 `SubmitSvgDeck` 内联；禁止远程 URL、绝对路径和空图片框。
- 裁切必须保留主体，caption 与图片形成明确关联。
- 精确标题、数字和数据标签保持 SVG 文本，不烘焙进图片。

## Deck-wide 换肤

用户要求整套换肤时：

1. 先更新 `design/design-spec.json` 的唯一设计锁。
2. 逐页读取并修改每个完整 SVG，使几何、字体、色彩、纹理、图片处理和节奏共同体现新风格。
3. 先用一页代表性页面完成 `PreviewSvgPage` 校准，再批量推进。
4. 分批完成剩余页并检查各页当前 PNG 后，按上述锁文件参数一次 `SubmitSvgDeck`；未再修改的通过页不重复渲染。

只改设计规格而不改 SVG 不会改变可见结果。

## 验证与停止

以修改前后的实际页面验证用户要求的改善，例如标题层级、可读性或指定品牌风格，而不是逐项追求所有设计维度最优。事实保留、指定问题解决、当前 PNG 无明显裁切重叠且提交成功后停止。没有具体缺陷时不继续装饰性修改；工具无法渲染或提交时说明阻塞，不宣称完成。

## 边界

- 视觉修改只写回 SVG 作者源，再经 `PreviewSvgPage` → `SubmitSvgDeck` 提交。
- 不让预览、提交或导出工具添加标题、页码、背景或其他自动 chrome。
- 用户只要求审查时不要擅自修改；先按 `ppt-review` 输出问题。
