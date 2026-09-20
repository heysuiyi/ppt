---
name: ppt-storyboard
description: 根据 outline 生成可选叙事分镜 storyboard，供 page-plan 参考；不是生命周期视觉事实源
when_to_use: outline 已就绪，复杂或长篇演示需要先规划逐页叙事再冻结最终 page plan 时
stages:
  - discover
  - author
---

# Storyboard 分镜

## 目标

本阶段无专用工具：用 `ReadFile` / `WriteFile` 完成。产物不是 lifecycle 硬锁。

由主 Agent 用 `ReadFile` 读取 outline、brief 和事实来源，写出 `slides/storyboard.json`。它是 `slides/page-plan.json` 的**可选叙事上游**，不是 lifecycle 视觉事实源，也不是 SVG 作者源；本阶段不写 SVG 几何或提交调用。

简单 deck 应跳过本技能，由 `ppt-design-layout` 直接从 outline / brief 生成 page plan。

## storyboard.json 结构

```json
{
  "version": 1,
  "slides": [
    {
      "id": "P01",
      "narrativeRole": "hook",
      "contentIntent": "用一句核心命题建立整套演示语境",
      "coreMessageDraft": "封面要让受众记住的判断",
      "audienceMoveDraft": "从泛泛兴趣转为关注核心矛盾",
      "keyPoints": ["副标题或必要上下文"],
      "sourceRefs": [],
      "assetIntent": []
    }
  ]
}
```

字段说明：

- `id`：使用 `P01`、`P02`……稳定编号，供 page plan 与 SVG 文件复用。
- `narrativeRole`：页面在整套论证中的职责。
- `contentIntent`：本页要承载的内容边界。
- `coreMessageDraft`：中心判断草案；后续在 page plan 中冻结。
- `audienceMoveDraft`：受众变化草案。
- `keyPoints`：需要保留的事实、论据或解释。
- `sourceRefs`：事实来源 id。
- `assetIntent`：需要何种真实素材及其论证作用；不写占位坐标。

## 叙事角色

可使用 `hook`、`section`、`claim`、`evidence`、`process`、`comparison`、`case`、`decision`、`summary` 等开放角色。角色帮助建立推进关系，不映射到固定版式。

## 工作流

1. 读取真实 outline、brief 与来源，确认用户指定的页数、顺序和不可改内容。
2. 根据后续受众行动组织叙事弧，确保相邻页面有清楚推进。
3. 为每页写稳定 id、角色、中心信息草案、受众变化草案、关键事实和素材意图。
4. 用 `WriteFile` 一次写入完整 `slides/storyboard.json`。
5. 检查来源引用、页序与信息覆盖；不要为追求页数拆出空洞过渡页。

## 约束（内容阶段）

- 每条 `keyPoint` 表达完整意思，不强行压成短标签。
- 单页要点数量按内容需要，不必压到 3–5 条。
- 信息量过大时先按内容权限精简或重组；需要超出用户指定页数时取得方向，不按固定卡片数量决定页数。
- 不在本阶段锁定 visual style、reading mode、image language、rhythm 或 `layoutIntent`；它们由 design spec 与 page plan 阶段完成。
- 本阶段只写内容规划，不写坐标、视觉实现细节或提交调用。

## 衔接

写入成功、用户要点与来源覆盖、页序和页数符合要求后停止。分镜用于内容规划，实际视觉效果仍需后续 PNG；不要在此阶段额外推演完整 SVG。

`ppt-design` 将 deck-wide 设计事实写入 `design/design-spec.json`；随后 `ppt-design-layout` 可合并 design spec 与本 storyboard（若存在），冻结 `slides/page-plan.json`。最后才由 `ppt-build` 写逐页 SVG。生命周期与提交只认 design-spec、page-plan 与 SVG，不认 storyboard。
