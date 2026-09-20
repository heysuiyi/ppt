---
name: ppt-design-layout
description: 在 deck-wide 设计锁之后，为 SVG-native 新建流程冻结每页 final copy、core message、audience move、rhythm、layout intent 和素材引用
when_to_use: 沟通契约与设计语言已锁定，需要把大纲或原始内容转成可逐页绘制的最终页面计划时
stages:
  - author
  - design
---

# 写逐页计划

入口是 `ReadFile` / `WriteFile`。输出 `slides/page-plan.json`，使 SVG 作者可以直接执行；不在这里展开 SVG 坐标或完整工具调用草稿。

## 执行

1. 在本 Query 的 create capability 内工作，尚未声明时先 `BeginPptCapability`。读取真实 `design/design-spec.json`、用户内容及实际需要的素材。brief、outline、storyboard、research 存在且相关时才读取，不先补做这些阶段。
2. 按用户页数和顺序组织内容。一个页面承载一个明确主张，必要信息不丢失；不机械增加封面、章节或过渡页。
3. 为每页写完整 finalCopy 和简短、可执行的构图意图。选定可用表达就落盘，不比较所有候选版式。
4. 用 `WriteFile` 写完整有序计划，核对范围和必填字段后交给 `ppt-build`。

## 页面字段

- id/path：稳定编号和 workspace 相对源路径，初次创建如 P01 → `slides/svg/P01.svg`。
- narrativeRole：页面职责；coreMessage：本页主张；audienceMove：受众需要理解或采取什么。
- finalCopy：最终可见文字和数据，包括所需标题、正文、标签、图注、来源、页码。保留事实、专名与明确措辞；示例假设必须有可见标注，不发明数据或出处。
- rhythm：anchor（突出结论）、dense（可扫描证据）、breathing（少量信息与留白）。按内容选择，不设每几页必须换风格的配额。
- layoutIntent：简述主焦点、阅读顺序与主要区域关系，不写模板名、组件清单或精确坐标。
- assetRefs：真实可用的 workspace 相对素材路径及用途，无素材为空数组；可选 evidenceRefs 回查事实来源。

图片遵循设计锁的 imageLanguage；精确标签保留为 SVG 文本。不能把“此处放图”当作可执行素材。finalCopy 冻结后，SVG 阶段可以换行排印，不擅自改事实。

## 文件结构

```json
{
  "version": 1,
  "designSpec": "design/design-spec.json",
  "slides": [
    {
      "id": "P01",
      "path": "slides/svg/P01.svg",
      "narrativeRole": "cover",
      "finalCopy": {"title": "封面标题", "subtitle": "一句话副标题"},
      "coreMessage": "本页唯一核心判断",
      "audienceMove": "受众看完本页后应理解或相信什么",
      "rhythm": "anchor",
      "layoutIntent": "用自然语言描述页面级构图意图，不要写模板名",
      "assetRefs": []
    }
  ]
}
```

## 验证与停止

通过条件：计划覆盖用户要求；页序、id、path 一一对应；finalCopy/coreMessage/audienceMove/layoutIntent 非空且具体；rhythm 为支持值；素材可读取；设计轴只来自设计锁。计划可执行后停止补充设计描述，进入实际 SVG 制作。

例如三页产品介绍，第三页内容可以直接收束时不额外增加“总结页”。若某个效果依赖缺失素材，先获取已授权素材或选择不依赖该素材且满足请求的表达；必需素材无法获得则报告缺口。计划写完只能称为内容规划完成，不能称为页面完成。
