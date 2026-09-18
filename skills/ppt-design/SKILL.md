---
name: ppt-design
description: 为 SVG-native 新建 deck 建立沟通契约，并在页面构图前锁定 argument mode、visual style、reading mode、image language、色彩和字体
when_to_use: 新建整套 PPT，或尚未建立 deck-wide 设计事实源时
stages:
  - discover
  - design
  - style
---

# SVG-native 设计锁

## 目标

本技能必须运行在本 Query 已声明的 `create` capability 内；若尚未声明，先调用一次 `BeginPptCapability`。

在写任何页面 SVG 前，先决定这套演示如何推动受众，再锁定一套可执行的视觉语言。将唯一 deck-wide 设计事实写入 `design/design-spec.json`；本技能不直接生成可见页面对象。

## 1. 建立沟通契约

根据用户要求确定最小充分范围，不自行升级为长篇立项或咨询报告。用户要求直接开始但缺少真实资料时，可明确选择一个示例场景；示例数字必须在可见文案中标明“示例假设，待实际数据替换”，不得编造内部调研、访谈或数据来源。每个契约字段用简短具体描述即可，不为填字段增加事实承诺。

从用户原话、brief、outline 和已有 workspace 文件中确定：

- `audience`：谁看。
- `objective`：为什么需要这套演示。
- `desiredOutcome`：受众看完后需要理解、相信、决定或执行什么。
- `coreMessage`：整套演示唯一核心判断。
- `deliveryContext`：现场讲述、会议讨论、异步近读或其他场景。
- `afterUse`：会后决策、留档、传播或培训复用。

已有事实不要重复询问。仅当缺失信息会改变内容事实或交付目标时才暂停；不要询问“标准还是创意”“要不要卡片”等内部设计选项。

## 2. 解析项目模板并锁定设计轴

先检查 `design/template-pack.json` 与 `design/template-policy.json`。若 pack 已存在（或 policy `mode=custom`），**必须**调用一次 `ResolveProjectTemplate` 并沿用其返回值；不得另选 builtin `visualStyle` 或自造调色板。

若无 pack：读取 `design/template-policy.json`（若存在），再调用一次 `ResolveProjectTemplate`，传入沟通契约字段；若用户明确点名风格或模板，分别传 `explicitVisualStyle` / `explicitTemplateId`。

工具返回的 `designSystem`、`selection`（写入 `resolvedTemplate`）、`typography` / `chrome` / `assets`（若有）与 `authoringGuidance` 是唯一允许的 deck-wide 风格事实源。不要发明模板 ID，也不要覆盖已解析的 `visualStyle`。

- `supportLevel=native`：内置模板，锁定 Design System 与构图指引。
- `supportLevel=design-reference`：上传参考模板；按 pack 配色/字体/logo/页眉页脚/标题框重生 SVG；**不**保留 PowerPoint 母版或占位符。
- `master-backed` 尚未启用；不得向用户承诺母版保真。

### Argument / reading / image language

在已解析的 `designSystem` 轴之上补充行为细节：

| `argumentMode` | 论证方式 | 适用目标 |
|---|---|---|
| `pyramid` | 结论先行，MECE 证据支撑 | 高管决策、战略、分析 |
| `narrative` | 情境 → 张力 → 转折 → 解决 | 融资、案例、品牌故事 |
| `instructional` | 前置知识 → 分解 → 示例 → 练习 | 培训、教程、解释型内容 |
| `showcase` | 大图/大数字主导，情绪节奏 | 发布、品牌揭晓、活动 |
| `briefing` | 中性、完整、便于检索 | 状态同步、会议包、交接 |

用户已经给定顺序或事实结构时，不为迁就 mode 擅自重排或改写事实。`readingMode` 必须与返回的 `designSystem.readingMode` 一致。

即使决定不用图片，也要显式锁定 image language：`usage`、`rendering`、`motif`、`framing`、`tone`、`textPolicy`（默认 `none`）。

### 读取完整执行参考

模板解析后立即调用一次 `GetDesignReference`，传入解析结果中的 `argumentMode`、`visualStyle` 和 `readingMode`。当 pack 激活时，该工具会合并 pack 配色/字体/chrome；**不得**用内置样板覆盖 pack 外观。将返回的论证骨架、标题语气、构图纪律、image language 和 `avoid`/`mustUse` 写入设计规格。

`ResolveProjectTemplate` 与 `GetDesignReference` 可在沟通契约就绪后同批发出（后者参数取前者结果时须等返回）；写入 `design/design-spec.json` 须等两工具结果返回后再发。若 Main 已种子化 design-spec 且 axes/`resolvedTemplate` 已匹配 pack，可补全真实 communicationContract 后保留轴与色。进入模板/参考阶段时可写 1–2 句意图，但不要为“加载参考”单独空转一轮。除非用户明确要求比较方案，不展示 safe/shifted/bold 选择题。

## 3. 锁定配套视觉事实

- 有 pack 时：色彩 HEX、字体角色、logo 路径、页眉页脚与标题框**直接复制 pack**；只补充 surface/secondary 等派生角色说明。
- 无 pack 时：定义语义色彩角色 `background`、`surface`、`primaryText`、`secondaryText`、`accent`、`signal`，使用明确 HEX；正文对背景对比度至少 4.5:1。
- 定义 `title`、`body`、`emphasis`、`code/data` 字体角色和大致字号层级；选择预览与提交环境可用的字体。
- 定义页面边距、常用对齐线、圆角/直角倾向、描边、阴影与纹理纪律；有 pack chrome.margins / titleFrame 时优先使用。
- 定义 `anchor`、`dense`、`breathing` 三种页面节奏如何在本风格中呈现。
- 明确禁止项，至少包括自动 chrome、全套卡片网格和仅换色不换构图；有 pack 时并入其 `avoid`/`mustUse`。

## 4. 写入设计规格

用 `WriteFile` 写 `design/design-spec.json`。最低结构（必须可通过运行时 SVG deck 锁契约校验）：

```json
{
  "version": 1,
  "canvas": {"width": 1280, "height": 720},
  "communicationContract": {
    "audience": "目标受众",
    "objective": "演示要推动的决策或行动",
    "desiredOutcome": "受众看完后应理解、相信或执行什么",
    "coreMessage": "整套演示唯一核心判断",
    "deliveryContext": "现场讲述 / 会议讨论 / 异步近读",
    "afterUse": "会后决策、留档、传播或培训复用"
  },
  "presentationDesignSystem": {
    "version": 2,
    "argumentMode": "pyramid",
    "visualStyle": "swiss-minimal",
    "colorScheme": "business-blue",
    "readingMode": "balanced"
  },
  "argumentMode": "pyramid",
  "visualStyle": {"id": "swiss-minimal", "reference": {}},
  "readingMode": "balanced",
  "resolvedTemplate": {
    "templateId": "builtin/swiss-minimal",
    "templateRevisionId": "1",
    "source": "auto",
    "reasons": ["..."],
    "supportLevel": "native"
  },
  "imageLanguage": {},
  "colors": {},
  "typography": {},
  "geometry": {},
  "rhythmBehavior": {},
  "forbidden": []
}
```

`communicationContract` 六个字符串字段、`presentationDesignSystem`（须与 `ResolveProjectTemplate` 返回值一致）、顶层 `argumentMode` / `visualStyle.id` / `readingMode`、以及 `resolvedTemplate` 必须齐全且轴一致；空对象 `{}` 不能代替沟通契约。字段值必须具体，不能把待决定项留给 SVG Executor。该文件不含可见对象，也不授权预览或提交工具补对象。

完成后由 `ppt-design-layout` 读取同一文件，为每页冻结最终文案和构图意图。若已知下一步需要 layout/build 技能，可在适当时机同批 `LoadSkill`，不要一技能一轮。后续不得无故重新选择 mode 或 style；若用户改变沟通目标，先更新设计规格，再继续页面规划。
