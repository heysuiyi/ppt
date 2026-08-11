# Visual Expression System

> 文档类型：现行架构与剩余边界
> 最后核对：2026-08-12
> 模板上传、内容自动选择与默认回退方案见
> [Presentation 模板管理与自动选择](../roadmap/template-management.md)
> （Proposed；零依赖 Grammar；对齐 SVG-native design-spec）

## 1. 系统定位

产品 Agent **作者路径**仅为完整页面 SVG。Layout Grammar / element-IR 已从**产品作者表面
下架**（默认注册表不含相关工具；见 `tests/svg-native-tool-surface.test.ts`）；共享库与
未注册实现已从仓库删除。产品新建只写入 `visualSource.kind === "svg"` 的
Presentation，供 Editor / HTML / PPTX 使用。

```text
产品作者（Agent SVG-native）:
  design-spec + page-plan
    → slides/svg/PNN.svg
    → PreviewSvgPage / SubmitSvgDeck
    → Presentation（visualSource.kind = "svg"）
```

## 2. 已形成的能力层

| 层 | 当前能力 |
|---|---|
| SVG page source | 完整页面 SVG（1280×720）；`visualSource.kind === "svg"`；预览 PNG 门禁 |
| Design System | DesignSystemV2：颜色、字体、密度、背景、图片和图表默认值 |
| Brand Profile | 稳定视觉人格到 DesignSystem 的确定性映射 |
| Visual Tokens | spacing、radii、elevation、motif |
| Rendering | Editor、HTML/contact sheet、PPTX 共用 SVG-native Presentation |
| Evaluation | SVG 预览校验；deck 结构与 designSystem 一致性评分 |

当前实现位于 `src/design-system/`、`src/shared/visual-*`、
`src/main/agent/tools/core/preview-svg-page.ts`、`src/main/agent/tools/core/submit-svg-deck.ts`。

## 3. 核心契约

### DesignSystemV2

定义 deck 级视觉语气（`designSystemV2Schema`）。Renderer 不应分别解释旧 theme/palette 和新 token；所有路径先解析为统一结果。SVG-native 提交时，`SubmitSvgDeck` 要求 `designSystem` 与 `design/design-spec.json` 锁一致。

### SVG visualSource

当 slide 带有 `visualSource.kind === "svg"` 时，该页的视觉作者源是对应 SVG 文件。
可见修改必须改 SVG 并重新预览，不能只改 page-plan 期待自动重绘。

## 4. 单一渲染事实

Presentation 是三端共同输入：

```text
Presentation
  ├─ PPTMirror
  ├─ HTML / contact sheet
  └─ PPTX exporter
```

新增视觉字段必须同时覆盖三条路径和契约测试。Renderer 只忠实显示，不重新猜测设计意图。

## 5. 图片与素材

图片能力包含：

- 搜索候选和来源页；
- 本地化；
- license/provenance；
- 焦点裁切；
- cover/contain；
- plain/framed/masked 等 treatment；
- layout slot 与宽高比适配；SVG 路径用显式 `href`。

SVG-native 路径要求图片以 workspace 相对 `href` 写入 SVG；`SubmitSvgDeck` 内联同一字节。禁止远程 URL。

声明依赖图片的设计若没有有效素材，应质量失败或更换不依赖图片的设计，不能留下空框。

## 6. 图表与可编辑性（混合导出已实现文字层）

**现行事实**：PPTX 导出采用混合策略——将去文字后的整页 SVG 嵌入为底图，并把可见
`<text>` / `<tspan>` 提升为 PowerPoint 原生文字框，便于改文案。装饰、图片与图表
仍留在 SVG 底图中，**不**拆成原生 shape / chart parts。无法提升的字形（如
`textPath`、带 `transform` 的文字）会留在底图里。

**远期目标**（未承诺为现行行为）：在不破坏所见即所得的前提下，探索原生可编辑图表
或基础形状拆解；不得把未实现能力写成当前导出契约。

## 7. 模型控制边界

### SVG-native（产品新建）

模型负责写作完整页面 SVG 几何与文案，并遵守画布、自包含与素材路径约束。代码负责：

- PreviewSvgPage 真实渲染与凭据；
- SubmitSvgDeck 锁文件核对、素材内联与 schema 校验；
- CommitGate 与导出。

### Layout Grammar / element-IR（作者表面已下架）

产品 slide 为 STRICT SVG-only（`visualSource` 必填；无 `elements` / `layout` /
`grammarVariant`）。Grammar / 命令轨作者工具不在默认注册表；handler / variant / slot
语义不再适用产品新建。未注册的 Grammar/layout 实现与 layout-plan 共享库已从仓库移除；
`tests/svg-native-tool-surface.test.ts` 继续断言这些工具名不出现在默认注册表。

## 8. Render Feedback（已移除）

**已落地**：`PreviewSvgPage` PNG 门禁与 deck validators 的确定性检查。

**已移除**：有界多页视觉复盘循环（原 `render-feedback-loop`）及其专测已从仓库删除，
不得写成现行或「仅未接线」的产品能力。内部启发式评分见 `design-system/evaluation.ts`
（非产品质检路径）。

视觉模型不能无限返工，也不能修改事实、数字、来源、页序和商业目标。

## 9. 当前剩余工作

Grammar / 双轨 / 频谱残骸清扫已收工。以下按工作流分类，**不要**再当作「扫死代码」继续切。

### 9.1 产品主线（已选定）：模板管理

下一产品立项优先 [template-management.md](../roadmap/template-management.md)
（Proposed）：内置模板 catalog、项目 template policy、与 `design/design-spec.json` 单锁对齐。
原生可编辑图表/形状（§6）保持远期目标，**不**与模板争主线。

### 9.2 视觉与内容增强（模板落地后或并行小项）

- 默认 project artifact / workspace probe 与 SVG-native 作者文件对齐；
- captioned image 建立独立内容模型；
- ppt-review 增强母题、锚点、密度和页面差异度；
- 从内容自动推导 Brand Profile，并允许用户自然语言调节。

### 9.3 风险 backlog（独立专项）

Linux `basic_text` 凭据降级、后台 daemon、E2E Layer 1/3/4/5、AppData 迁移——见
[capability-scorecard.md](../architecture/capability-scorecard.md)「风险 backlog」表与
[端到端质量证据](../architecture/e2e-quality.md)。Layer 2 导出 golden 已落地，不阻塞
模板 Phase 1。

### Grammar / element-IR 作者表面（已移除）

默认注册表不含 Grammar/命令轨作者工具；Deferred 发现面为空，且默认不注册
`SearchExtraTools` / `ExecuteExtraTool`（`tests/svg-native-tool-surface.test.ts`）。
未接线的 modular IPC / session-runtime 双轨与未消费 logo 管道已从产品面移除。

[template-management](../roadmap/template-management.md)（Proposed）与 Grammar 零耦合：
内置模板只锁定 Design System 与 SVG 作者指引。

剩余项集中维护在本文件和 [工作流](./workflow.md)，不再保留多个视觉建设 plan。

## 10. 关键实现

- `src/design-system/`（含内部启发式 `evaluation.ts`；产品质检走 CommitGate / DeckValidationService）
- `src/shared/presentation.ts`（`designSystemV2Schema`、`visualSource`）
- `src/main/agent/tools/core/preview-svg-page.ts`
- `src/main/agent/tools/core/submit-svg-deck.ts`
- `src/main/agent/tools/tool-registry.ts`（默认注册表不含 Grammar 作者工具）
- `src/shared/visual-tokens.ts`
- `src/shared/visual-asset-audit.ts`
- `src/shared/shape-render-utils.ts`
- `src/shared/gradient-export.ts`
- `src/main/ppt-exporter.ts`

## 11. 验收

- 新建路径可仅凭 SVG 作者文件完成预览与提交。
- 默认工具注册表不含 Grammar/命令轨作者工具；Deferred 发现面为空。
- 缩略图可区分页面角色和整套节奏。
- 同一 deck 的母题稳定，但页面不成为重复卡片墙。
- Editor、HTML 和 PPTX 的结构语义一致。
- 对 SVG 页，视觉修改必须改 SVG 源并重新 Preview；不能只改派生元素树。
