---
name: ppt-design-layout
description: 在 deck-wide 设计锁之后，为 SVG-native 新建流程冻结每页 final copy、core message、audience move、rhythm、layout intent 和素材引用
when_to_use: 沟通契约与设计语言已锁定，需要把大纲或原始内容转成可逐页绘制的最终页面计划时
stages:
  - author
  - design
---

# SVG-native 逐页设计

## 角色

本技能必须运行在本 Query 已声明的 `create` capability 内；若尚未声明，先调用一次 `BeginPptCapability`。

读取 `design/design-spec.json` 和用户内容，为每一页写最终内容与页面级构图意图。输出唯一文件 `slides/page-plan.json`。本技能只写 page plan，不生成 SVG。

设计不是为页面挑模板。每页必须回答：

1. 这页最终要说什么。
2. 受众看完后发生什么变化。
3. 本页在整套节奏中承担什么密度。
4. 视觉焦点、阅读顺序、空间比例和图文关系如何服务论点。

## 输入

- `design/design-spec.json`。
- 用户原始需求及已存在的 `brief.md`、`outline.md`、storyboard、研究与事实文件。
- 可用的 workspace 素材及其来源信息。

使用 `ReadFile` 读取真实输入；不要凭记忆重建。事实、数字、专名和用户明确要求的措辞保持准确。页面顺序已经由用户指定时，不为追求某种 argument mode 擅自重排。独立路径的读取可与其他已知参数的工具同批发出；进入读稿/写大纲阶段时可写 1–2 句意图，但不要为“先读再读”拆成多轮。

## 先完成整套论证

根据锁定的 `argumentMode` 建立页面序列，但不要让模式覆盖内容真相：

- `pyramid`：核心判断 → 分解 → 证据 → 决策/行动。
- `narrative`：情境 → 张力 → 转折 → 解决 → 余韵。
- `instructional`：目标 → 前置 → 分解 → 示例 → 应用。
- `showcase`：强开场 → 关键亮点 → 视觉/数字峰值 → 收束。
- `briefing`：状态 → 事实 → 风险 → 决策点 → 下一步。

封面和结尾都必须承担沟通任务，不是装饰性占位页。相邻页面要有明确推进关系，避免把大纲每个 bullet 机械变成一页。

## 每页必填字段

字段服务实际页面，不是设计论文。每页保留一个明确主张，构图意图用简短可执行描述即可；已足够表达内容时不比较更多设计方案。不要为填满版面增加未经证实的数字或来源，示例假设须进入 `finalCopy` 的可见标注。

为每页分配稳定 id：`P01`、`P02`……，并填写：

- `id`：与最终 SVG 文件名一致。
- `path`：对应的 workspace 相对 SVG 路径，例如 `slides/svg/P01.svg`。
- `narrativeRole`：本页在论证中的职责。
- `finalCopy`：页面上最终出现的全部文字和数据，包括标题、正文、标签、图注、来源、页码文本等。保持段落、句子、列表和标签的原始语义纹理。
- `coreMessage`：本页唯一中心判断，不能只是主题名。
- `audienceMove`：用具体动词描述受众变化，例如“接受先保留率、后拉新的增长判断”。
- `rhythm`：`anchor`、`dense` 或 `breathing`。
- `layoutIntent`：用自然语言描述主焦点、阅读顺序、主要区域比例、对齐关系、留白和图文关系；不要写模板名或组件清单。
- `assetRefs`：本页显式需要的 workspace 相对素材路径及用途；无素材时为空数组。
- 可选 `evidenceRefs`：事实或来源 id。

`finalCopy` 在此阶段冻结。SVG Executor 可以做换行和层级排印，但不得重写、删除或发明事实来适配版面。

## Rhythm

| 值 | 页面职责 | 适合表达 |
|---|---|---|
| `anchor` | 建立章节、结论或证据锚点 | 封面、章节命题、关键 KPI、结尾 |
| `dense` | 承载需要近读的证据与关系 | 数据、比较、系统、表格 |
| `breathing` | 释放认知负荷并制造转折 | 大图、金句、单一结论、章节过渡 |

规则：

- 5 页以上至少出现两种 rhythm。
- 避免连续 3 页 `dense`；确需连续时在焦点、阅读方向或视觉尺度上形成差异。
- `narrative` / `showcase` 每 3–5 页通常安排一个 breathing beat。
- `breathing` 页不能被三个以上同构卡片重新填满。
- 节奏变化必须服务论证，不为追求“版式种类数”强行变化。

## 图片

- 服从 `imageLanguage`，保持同一渲染家族与 motif。
- 图片依赖页面必须有真实可用的 `assetRefs`，不得只写“此处放图”。
- 素材路径必须是 workspace 相对路径；不在计划中使用远程 URL 或绝对路径。
- 图片承担氛围、空间或证据；精确文字、数字和数据标签保留为 SVG 文本。
- 泛化办公照、同图无意义复用和纯填空配图不合格。

## 写入 `slides/page-plan.json`

用 `WriteFile` 一次写入有序 JSON（必须可通过运行时 SVG deck 锁契约校验）：

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

`finalCopy`、`coreMessage`、`audienceMove`、`layoutIntent` 不能为空字符串或空对象占位；`rhythm` 只能是 `anchor` / `dense` / `breathing`。
提交前确认：

1. 所有页面的 `finalCopy`、`coreMessage`、`audienceMove`、`rhythm`、`layoutIntent` 都具体且互相一致。
2. 每页 `id`、`path` 与顺序一一对应：`P01` → `slides/svg/P01.svg`，不得省略 `path`。
3. deck-wide `argumentMode`、`visualStyle`、`readingMode` 和 `imageLanguage` 只来自 `design/design-spec.json`。
4. `layoutIntent` 描述页面级构图，而不是模板名、卡片数量或坐标参数。
5. 页面序列有清楚推进和节奏变化，不存在默认的全套卡片化。
6. 所有素材引用可执行且用途明确。

完成后由 `ppt-build` 按页生成 `slides/svg/P01.svg`……。若尚未加载 `ppt-build`，可与其他已知需要的技能同批 `LoadSkill`。计划文件不拥有任何可见几何，预览或提交工具也不得根据它补充自动 chrome。
