---
name: ppt-review
description: 基于当前 SVG 真渲染与内容来源提交正式质量报告；区分实际缺陷、改进建议和未验证项
when_to_use: 用户要求正式质量审查，或复杂内容需要独立核验时；普通生成和小改使用作者技能自带检查
stages:
  - style
  - export
---

# 审查实际页面

入口是 `ListSlides` → `PreviewSvgPage` → `SubmitPptReview`。证据是当前版本的真实渲染、内容来源和结构化报告。XML 合法、工具成功或遵循了设计步骤，都不能单独证明视觉质量。

## 选择能力

- 只要正式报告：本 Query 使用 review，尚未声明时先 `BeginPptCapability`；只读检查后 `SubmitPptReview`。
- 要修复页面：在声明能力前选择 edit 或 restyle，按下面标准检查并走对应编辑技能；该路径提交 deck，不产出 QualityReport。
- 要先正式报告再修改：本 Query 完成 review，新的用户 Query 再进入 edit/restyle。同一 Query 不能切换 capability，review 不能写 SVG 或 `SubmitSvgDeck`。

## 执行

1. `ListSlides` 获取完整页序、svgSourcePath、svgSha256。读取设计锁、页面计划及相关事实来源，用于核对内容，不据此补想象中的可见对象。
2. 通过 `ReadFile` 读取完整作者 SVG；分页沿 nextOffset 和同一 expected_version 续读。用 `PreviewSvgPage` 获取并查看逐页真实 PNG；已取得、可确认仍对应当前 SVG/素材版本的渲染可复用。
3. 对照用户要求检查下表。每条问题记录页码、源路径/hash、实际现象及最小修复方向。只记录有证据且影响使用的问题。
4. 用 `SubmitPptReview` 的工具 schema 提交 verdict、summary、overallScore、findings，绑定当前 PresentationRevision；Markdown 只是可读摘要。

## 检查什么

| 检查 | 不通过的证据 | 修复方向 |
|---|---|---|
| 来源与版本 | 缺 source/hash；预览源 hash 与提交版本不一致 | 明确漂移，重新预览并走 authoring 提交，不冒用旧版本报告 |
| 画布与依赖 | 非完整 1280×720；脚本、foreignObject、远程/绝对资源依赖 | 修作者 SVG 或本地素材 |
| 内容 | finalCopy、关键事实、用户要求的对象缺失；虚构来源；示例未标注 | 恢复正确内容与可见标识 |
| 可读性 | 文本裁切、越界、非语义重叠；图片损坏或主体误裁 | 调整对应页几何、排印或资源 |
| 对比度 | 小字低于 4.5:1，24px+ 文字低于 3:1；背景使文字不可读 | 调整颜色、位置或衬底；精确比例需颜色证据，不能凭图估算数值 |
| 设计要求 | 明显违背品牌、主焦点难辨、阅读顺序阻碍理解 | 修具体偏差，不重做无问题页 |

跨页只检查实际一致性与阅读负担：颜色、字体语义、顺序和重复结构是否妨碍表达。不以版式种类、固定 rhythm 比例或“每三页必须变化”作为通过条件。建议性的美感偏好与阻断缺陷分开，不为凑分数制造问题。

## 判定与停止

- 实际页面覆盖请求且无阻断缺陷，报告通过并结束；不自动展开美化任务。
- 观察到缺陷，报告失败项与对应证据，不在 review 中偷偷改稿。
- 缺 PNG、来源漂移或不能取得当前版本时，报告无法完成相应验证；不把未验证写成通过，也不把环境阻塞直接当成视觉缺陷。结构化 verdict 只用工具 schema 支持的值，summary/findings 说明缺失证据。
- `SubmitPptReview` 成功只证明报告已提交，页面质量结论来自实际检查；未提交成功不宣称正式审查完成。

例：P02 预览成功但末行被裁切，应记录 P02 的裁切证据与调整文本区域建议；无需为了一个裁切问题建议全套换肤。

默认主 Agent 审查。用户明确要求协作时，可委派带版本引用的独立只读核验；没有真实渲染能力的结果只算源码/事实检查。主 Agent 读取证据并负责最终提交。
