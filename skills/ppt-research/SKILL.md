---
name: ppt-research
description: 整理调研素材到 research/notes.md（默认跳过，仅用户明确要求调研时）
when_to_use: 用户明确要求收集资料、或提供了大量外部素材需要整理时
stages:
  - discover
  - author
---

# 调研笔记

## 目标

本阶段无专用工具：用 `ReadFile` / `WriteFile`，需要外部事实时另用 `WebSearch`。产物不是 lifecycle 硬锁。

由 Lead（主 Agent）维护精简的 `research/notes.md`——事实清单，不是报告。默认跳过本阶段；仅用户提供资料或明确要求调研时执行。若任务路径评估标出 `ppt-research` 为「现在需要」，或用户明确要求调研/材料整理，再加载本技能。

## research/notes.md 结构

```markdown
# 调研笔记

## 关键事实
- 事实 1（来源）
- 事实 2

## 待核实
- 需用户补充的项
```

## 工作流

1. 仅当用户提供了资料、明确要求调研，或任务路径因 factBurden 高推荐 research 时才执行。
2. 用 `ReadFile` 读取 `brief.md` 主题方向（若存在）。
3. 需要外部事实或最新资料时使用 `WebSearch`；重要结论至少交叉核验两个来源。需要视觉素材候选时可设置 `include_images: true`；图片结果仅用于发现，必须保留来源并核对授权后才能进入 deck。
4. 用 `WriteFile` 结构化写入 notes；每条事实标注来源 URL。
5. 向用户摘要事实条数与待核实项。

## 约束

- 默认跳过此阶段；小型 PPT 不需要 research。
- notes 是素材清单，不是幻灯片正文。
- 不把未核实数据写成定论。
- **协作是条件性的，不是硬禁令**：默认由 Lead 直接执行。仅当用户明确要求多 Agent，且存在可拆分的独立辅助工作（如按来源分头摘录、交叉核验）时，才可将资料整理委派给 teammate；委派须写清目标、输入引用及版本、只读/写入范围、交付 notes 片段与验收条件。Lead 验收实际结果后合并进 `research/notes.md`。页面规划与 SVG 作者工作不在本技能委派范围内。
- 真实工具或权限限制不可被“想要并行”覆盖；teammate 工具不可用时显式说明，不静默改口。
