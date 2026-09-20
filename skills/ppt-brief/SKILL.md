---
name: ppt-brief
description: 起草 brief.md，统一受众、沟通目标、期望结果、核心信息、交付场景与会后用途
when_to_use: 大型新建且 workspace 尚无 brief.md，或用户只给模糊主题、需要先对齐沟通契约时
stages:
  - discover
---

# PPT Brief 起草

## 目标

本阶段无专用工具：用 `AskUser` / `ReadFile` / `WriteFile` 完成。产物不是 lifecycle 硬锁。

创建精简的 `brief.md`，作为 `design/design-spec.json` 和内容结构的上游输入。brief 只记录沟通事实、内容边界和用户明确给出的品牌约束；不锁定视觉 style、reading mode、image language 或页面构图。

## 需求澄清

先用 `ReadFile` 读取已有需求、素材和旧 brief。用户只给主题或模糊想法时，优先对齐以下项；已明确则跳过：

| # | 字段 | 为什么要问 |
|---|------|------------|
| 1 | `audience` | 明确要影响谁 |
| 2 | `objective` 与 `desiredOutcome` | 明确为何演示，以及受众看完后需理解、相信、决定或执行什么 |
| 3 | `coreMessage` | 确定整套唯一核心判断 |
| 4 | `deliveryContext` 与 `afterUse` | 明确现场/异步语境以及会后决策、留档或复用方式 |
| 5 | 内容权限、时长、素材与硬约束 | 确认是否允许重排/改写，以及必含事实和禁区 |

缺少的信息确实会改变内容事实或交付目标时，使用 `AskUser` 一次询问 1–3 个关键问题；不要连环追问。不要询问“标准还是创意”“要不要卡片”等内部选项。

用户明确给出的品牌色、字体、logo 或风格要求可以原样记录为约束，但设计选择统一由 `ppt-design` 写入 `design/design-spec.json`，不写入 layout-plan 或其他视觉模型。

## brief.md 结构（保持简短）

```markdown
# 演示标题

## 核心目的
（一句话）

## 受众
（一句话）

## 目标与期望结果
（为什么演示 · 受众看完后需要理解、相信、决定或执行什么）

## 核心信息
（整套演示唯一主张）

## 演示场景与会后用途
（会议语境 · 会后如何使用）

## 内容重构权限
（preserve / reorder / rewrite-and-merge）

## 时长与页数
（例如 30 分钟 · 约 20 页）

## 素材
（有/无 · 简述）

## 要点
- 要点 1
- 要点 2

## 明确约束
（必含事实 · 禁止内容 · 用户明确给出的品牌/视觉约束）
```

## 工作流

1. 用户已给完整沟通契约和大纲时，可跳过 brief。
2. 读取现有输入并提取已经明确的字段。
3. 仅在关键事实缺失时用 `AskUser` 一次补齐。
4. 用 `WriteFile` 写完整 `brief.md`。
5. 回读并检查：目标、受众、期望结果、核心信息和交付语境无冲突；不要把设计推测写成用户要求。

## 质量

- `audience`、`objective`、`desiredOutcome`、`coreMessage`、`deliveryContext`、`afterUse` 足够具体。
- 明确事实与推断，不能臆造受众、数据或品牌规则。
- 页数与时长合理即可。
- 文案完整表达，不在 brief 阶段强行压字数。
- 不在 brief 中建立第二套 argument mode 或视觉事实源。

## 衔接

`brief.md` 成功写入、已知需求无冲突且内容边界明确，即可结束本阶段。非关键的未知项可明确标为假设或待定，不为填满字段反复提问；brief 不是事实证明，也不代表页面已生成。

后续链路：outline（可选）→ storyboard（复杂 deck 可选）→ `ppt-design` 写 `design/design-spec.json` → `ppt-design-layout` 写 `slides/page-plan.json` → `ppt-build` 写逐页 SVG。
