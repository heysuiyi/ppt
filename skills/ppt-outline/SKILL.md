---
name: ppt-outline
description: 根据 brief 起草 outline.md，含叙事弧章节骨架（完整路径时使用）
when_to_use: brief 已就绪、大型新建需要结构化大纲时
stages:
  - discover
  - author
---

# PPT Outline 大纲

## 目标

本阶段无专用工具：用 `ReadFile` / `WriteFile` 完成。产物不是 lifecycle 硬锁。

由主 Agent 直接创建精简 `outline.md`，为后续 storyboard 或 page-plan 提供带叙事弧的章节骨架。本技能不写 SVG，也不提交 deck。

## 叙事范围

按用户页数与目的组织开场、主体和收束，同一页可以兼任职责，不为 Hook、Context 或 Takeaway 单独扩页。简单演示可直接进入 page-plan，不必额外起草 outline。版式留到页面阶段处理。

## outline.md 结构

```markdown
# [演示标题]

## 叙事弧
- Hook: …
- Context: …
- Core: …
- Takeaway: …

## 章节

### 1. [章节名]（N 页 · section?）
- 要点 1
- （可选）内容形态：并列 / 对比 / 流程

### 2. [章节名]（N 页）
...
```

## 工作流

1. 用 `ReadFile` 读取 `brief.md`（需求已清晰且无 brief 时，可内联推断）。
2. 优先按用户指定页数、顺序和内容拆章节；未指定时以完整表达所需的范围规划。
3. 只有内容确需分隔时才安排章节页。
4. 用 `WriteFile` 写回 `outline.md`。
5. 向用户摘要章节数、总页数，以及最多 1 处待确认项（若有）。

## 质量

- 每章至少 1 个要点；禁止空章节。
- 内容结构服务理解，不以章节形态多样性作为硬指标。
- 要点可完整表达，不必压字数。

写入成功，页数与内容覆盖符合请求且无空章节即可结束本阶段。缺关键事实时标出缺口，不编造材料填满大纲；只交大纲时不继续生成 SVG。

## 衔接

复杂或长篇演示完成后可 LoadSkill `ppt-storyboard`；简单 deck 可跳过 storyboard，进入 `ppt-design` → `ppt-design-layout`。
