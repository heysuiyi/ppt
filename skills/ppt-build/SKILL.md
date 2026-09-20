---
name: ppt-build
description: 根据锁定的设计规格和逐页计划，逐页编写完整 1280×720 SVG，经 P01 预览闸门后提交 SVG-native deck
when_to_use: 沟通契约、设计语言和每页最终文案均已锁定，需要生成并提交新建 PPT 时
stages:
  - author
  - design
---

# 从页面计划生成 SVG

入口是 `WriteFile` → `PreviewSvgPage` → `SubmitSvgDeck`。证据是实际 PNG 与提交结果；规划文字和工具调用草稿不能证明页面已经生成。

## 准备

本 Query 使用 create capability，尚未声明时先 `BeginPptCapability`。完整读取 `design/design-spec.json` 与 `slides/page-plan.json`；`ReadFile` 分页时沿 nextOffset 和同一 expected_version 读到 hasMore=false。已完整取得且未变的文件无需每页重读。

设计锁与页面计划须满足各自契约。缺少最终文案、构图意图或所需素材时补齐对应文件，不用占位 SVG 掩盖。沿用既定设计，不重新比较整套方案。

## 执行

1. 先用 `WriteFile` 写完整 `slides/svg/P01.svg`，随后调用 `PreviewSvgPage`。写入在前、预览在后；运行时支持有序执行时可在同一响应发出。
2. 查看 P01 的真实 PNG，检查文字完整可读、画面边界、素材和用户要求的风格。修复已观察到的问题并重新预览。P01 通过前不生成 P02。
3. 按计划顺序写后续页；每次写一个完整 SVG，可将少量独立页面合成一批。只处理当前批次，不预演全套 SVG 后才执行。
4. 每批逐页 `PreviewSvgPage` 并看图。有具体缺陷才修；修改 SVG 或素材后重新预览受影响页面。未变且已通过的页面不重复预览。
5. 全部页面通过后，独批调用 `SubmitSvgDeck`。若被拒绝，根据返回错误修复，再补受影响预览后重提；没有修正不重复提交。

## SVG 契约

- 根节点为 `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">`。
- 页面完整绘制背景及计划要求的标题、正文、页码、图表、品牌等；不存在自动 chrome。
- 使用可转换的 SVG 几何、文本、图片、defs、渐变、clipPath；不使用 script、foreignObject、外部 CSS、运行时脚本或远程依赖。
- 图片 href 使用可读取的 workspace 相对路径；预览与提交消费同一资源，提交时内联。精确文字与数字保留为 SVG 文本。
- finalCopy 是文案依据，可以换行和排印，不擅自增删事实。容纳不下时先调整构图；需要改变用户指定页数时先取得方向。
- 构图服务 coreMessage、rhythm 和 layoutIntent。相似内容可复用合理的对齐与结构；不要把所有内容强行塞进等宽卡片，也不要为了差异重做已经可读的页面。

## 提交契约

提交 deck 的全部有序页面，显式带上 `designSpecPath: "design/design-spec.json"` 与 `pagePlanPath: "slides/page-plan.json"`。

communication 复制设计锁的 communicationContract，designSystem 复制 presentationDesignSystem。每页 id/path 与计划同序，narrative.role 取 narrativeRole，其余 narrative 字段原样取页面计划。提交工具会核验轴、页序、路径和叙事字段，不能另写一套近似值。

## 通过与失败

- 通过：用户范围内的页面齐全；每个新建/改动 SVG 与素材当前版本有成功 PNG；实际内容可读、事实和假设可区分；提交成功。此时停止润色。
- 预览成功但正文裁切：页面仍不通过，修正文案布局后重看该页。
- 图片无法读取：修实际资源或引用，不画空框后声称完成。
- 无法获得 PNG：只能报告源码检查，不能声称视觉验收。
- 只得到 Proposal ready：报告待应用，不声称已应用或已导出。

## 协作边界

主 Agent 持有 SVG 写入、P01 校准、预览和提交。默认 solo；用户明确要求协作时只委派独立辅助工作，给出输入版本、范围与交付标准，并核验实际结果。只有源码读取能力的协作者不能给出视觉验收结论。
