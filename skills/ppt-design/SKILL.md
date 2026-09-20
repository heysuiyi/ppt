---
name: ppt-design
description: 为 SVG-native 新建 deck 建立沟通契约，并在页面构图前锁定 argument mode、visual style、reading mode、image language、色彩和字体
when_to_use: 新建整套 PPT，或尚未建立 deck-wide 设计事实源时
stages:
  - discover
  - design
  - style
---

# 建立设计规格

入口是 `ResolveProjectTemplate`、`GetDesignReference` 和 `WriteFile`。产物是 `design/design-spec.json`；设计锁只说明意图，页面质量要等 SVG 渲染后验证。

## 执行

1. 在本 Query 的 create capability 内工作，尚未声明时先 `BeginPptCapability`。读取用户要求及已有相关输入；有效设计锁可复用。
2. 将受众、目的、期望结果、核心信息、交付场景、会后用途写成简短具体的 communicationContract。只有缺失信息会实质改变交付目标或事实时才问。直接开始且允许示例时，把假设明确标注到后续可见文案；不编造调研、访谈或来源。
3. 检查 `design/template-pack.json` 与 `design/template-policy.json`，调用 `ResolveProjectTemplate`。用户指定风格/模板时使用 explicitVisualStyle / explicitTemplateId；不发明模板 ID。
4. 用解析出的 argumentMode、visualStyle、readingMode 调用 `GetDesignReference`。参数依赖解析结果时等待结果后再调用。保留返回的 designSystem、selection、pack 的 typography/chrome/assets，以及适用的 authoringGuidance、mustUse/avoid。
5. 写入完整设计规格。已有轴和 resolvedTemplate 匹配当前 pack 的种子文件可补齐沟通契约后复用，不无故重新选风格。

## 设计决策边界

- pack 存在或 policy 为 custom 时沿用解析结果的配色、字体、logo 与 chrome，不另选 builtin 外观。design-reference 表示按参考重生 SVG，不承诺 PowerPoint 母版保真；master-backed 尚未启用。
- 无 pack 时明确语义色 background/surface/primaryText/secondaryText/accent/signal 的 HEX，正文对比度至少 4.5:1；字体角色与字号层级采用运行环境可用字体。
- 记录可执行的边距、对齐、几何与图片语言即可。imageLanguage 包含 usage、rendering、motif、framing、tone、textPolicy（默认 none），不用图也明确记录。
- argumentMode、readingMode 沿用解析结果，用户顺序优先。节奏服务内容，不为设计配额扩页；除非用户要求比较方案，选择一个符合约束的方案后执行。

## 文件结构

以下为结构示例；轴、模板与视觉字段使用实际工具返回值，空对象按本任务补齐，不能照抄示例值作为已解析结果。

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

## 验证与停止

确认写入成功，六个沟通字段具体，顶层 argumentMode/visualStyle.id/readingMode 与 presentationDesignSystem 一致，resolvedTemplate 来自实际 selection；必需视觉事实已落实。满足这些条件就交给 `ppt-design-layout`，不提前逐页设计 SVG。

轴不一致或 pack 要求遗漏时修当前设计锁；工具无法解析模板时报告具体错误，不自造结果。锁文件写入不代表 PPT 已生成或视觉验收通过。
