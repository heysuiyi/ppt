# 工作台 Token 体系调研与新版建议

日期：2026-10-29。状态：历史调研记录；后续实施状态见[执行方案](./token-system-plan.md#11-实施与验证记录)及[现行样式契约](./README.md)。

## 结论与边界

保留现有 CSS Custom Properties、Studio 深浅色、用户 CSS 主题以及应用 UI / PPT 内容隔离。补齐用途层、公共组件和消费约束，不更换 CSS 技术栈，不引入 UI 框架，不先做全仓机械替换。

目标不是消灭所有像素值，而是让同一种设计决策只有一个维护入口。主题改变视觉身份；密度改变空间节奏；结构和用户拖拽产生的尺寸仍由布局实现负责。

本文记录研究阶段的事实与建议，变量清单和“尚未实现”描述属于当时快照；不应当作当前源码状态。后续已实施的角色、清理和验证范围在执行方案与样式维护文档中单独记录。

三风格的具体契约、候选映射、状态规范与实施门槛见[三风格主题优化与渐进接入方案](./token-system-plan.md)。本文保留研究依据与现状证据；后续实施以该方案的具体决策为准。

## 1. 官方实践：统一靠什么

| 体系 | 官方机制 | 本项目采用什么 | 不照搬什么 |
| --- | --- | --- | --- |
| Material 3 | reference / system / component 三类 Token | 基础尺度 → 用途 → 必要的组件参数 | 不复制整套命名和全部组件 Token |
| Atlassian | 有限间距尺度；圆角按交互、容器等用途分配；优先组件和组合原语 | 同类对象统一规则，保留大小层次；先复用控件，再自定义 | 不把所有卡片或所有控件设成一个圆角 |
| Carbon | 2/4/8 的间距体系；Stack 由父容器管理子元素间距；允许有理由的例外 | 父级 gap 管卡片间距，组件 padding 管内部留白 | 不给每张卡片叠加 margin；不为响应式直接缩放全部基础尺度 |
| Ant Design | Seed → Map → Alias；组件覆盖；dark 与 compact 可组合 | 颜色与密度独立；小规模派生和用途映射 | 不为当前项目引入运行时主题算法或 CSS-in-JS |

企业设计系统并非没有例外，而是限制可选尺度、明确用途、把重复结构固化在组件中，并用视觉和交互验收防止偏离。Token 本身不能解决各页面独立实现 Button、Card 或表单行的问题。

参考来源（官方）：

1. [Material 3 — Design tokens](https://m3.material.io/foundations/design-tokens/overview)（层级信息由官方搜索摘要获取，页面为动态内容）。
2. [Atlassian — Spacing](https://atlassian.design/foundations/spacing/)：8px 基准，含 2/4/6px 小尺度；同时明确光学调整，不是只允许 8 的整数倍。
3. [Atlassian — Radius](https://atlassian.design/foundations/radius)：按用途分配圆角；焦点环与组件几何关联。
4. [Atlassian — Composition](https://atlassian.design/get-started/develop/composition)：组件 → 组件选项 → 布局原语 → 必要的自定义 Token 消费。
5. [Carbon — Spacing](https://www.carbondesignsystem.com/building-blocks/foundations/spacing/overview)：有限尺度、Stack、响应式换档而不是改变所有基础间距。
6. [Ant Design — Customize Theme](https://ant.design/docs/react/customize-theme.md)：Seed / Map / Alias、组件 Token、dark / compact 算法组合。
7. [DTCG — Format 2025.10](https://www.designtokens.org/tr/2025.10/format/)：跨工具交换格式的参考，不是本次必须引入的构建系统。

## 2. 当前样式资产

以下为只读 Node 递归盘点快照；工作区存在并行编辑，数字不是长期基线。定义次数按 `--name:` 正则统计，不能等同于有效契约或死代码分析。

| 目录 | CSS 文件数 | 不同变量定义名数 | 用途 |
| --- | --- | --- | --- |
| tokens | 7 | 174 | 颜色、字体、排版、动效、形状、间距、层级、Studio 皮肤、设置局部尺寸 |
| components | 4 | 5 | switch、select、loading indicator、run status |
| modules | 27 | 12 | 布局和各业务界面 |
| themes | 1 | 62 | Catnip 完整 CSS 主题 |

样式入口是 `../styles.css`，有序导入是现行层叠契约，不能随意改顺序。

### 2.1 模块地图

- 框架：`base`、`layout`、`startup`、`view-enter`。
- 左侧与文件：`sidebar`、`project-files`。
- 聊天：`chat`、`chat-markdown`、`chat-agent-run`、`components/run-process/run-process.css`、`chat-team`。
- 输入：`unified-input`。
- 画布外壳与镜像：`canvas-chrome`、`canvas-mirror`。
- 审批与产物：`review-approvals`、`review-artifacts-inline`、`review-surfaces`。
- 设置：`settings-nav`、`settings-panels`、`settings-forms`、`settings-token-usage`、`model-management`。
- 弹层与任务：`context-menu-thinking`、`overlays-slash`、`overlays-slideshow`、`overlays-toast`、`ppt-job-status`。

这些文件按区域拆分的方向可以保留；新版不是把它们重新合为一个大 CSS。

### 2.2 已有的正确基础

- `tokens/semantic.css:14–60`：surface / text / border / accent / status 语义体系。
- `tokens/skins/studio.css:7–108`：深浅色映射。
- `tokens/typography.css:12–37`：字号与行高配对、四档字重、字距。
- `tokens/motion.css:6–25`：时长、缓动和按属性 transition。
- `tokens/settings-density.css:7–18`：设置区域已经尝试以用途表达尺寸，但还不是全局密度模型。
- `styles/README.md:19–54`：现有依赖方向、工作台与 PPT 隔离、用户主题语义契约与区域 hook。
- `app/useAppearanceRuntime.ts:30–90`：颜色模式、主题注入、用户排版偏好已有实际装载路径。

### 2.3 明确的缺口

- 基础与用途混放：`semantic.css:71–115` 同时容纳圆角尺度、形状派生、间距、loading 尺寸和 z-index。
- 相同角色没有统一尺寸：`layout.css:158,192,220` 重复维护 6px 拖拽条；菜单和按钮各自维护 padding / 高度。
- 命名未对齐：`layout.css:125–128` 的 `--surface-elevated`、`--shadow-popover` 与现有 `--surface-overlay` / `--elevation-*` 体系不同，fallback 会掩盖遗漏接入。
- 圆角职责不明确：`layout.css:6` 的主面板公式额外加 10px，无法从“内容圆角 scale”直观理解；`semantic.css:81–90` 又同时提供 size-family 与 role aliases。
- 局部视觉绕过主题：例如聊天滚动条的黑白 rgba 与深色覆盖、侧栏固定字号；不能只靠完善根变量自动纠正。
- 公共组件自身尚未统一：`components/controls.css:6–47` 的 switch 仍直接维护尺寸、圆角、0.3s 和位移。
- 焦点与滚动条已有公共入口：`modules/base.css:9–11,30–45`；应扩展这里的统一规则，而非逐页增加独立版本。

### 2.4 运行时与旧文档不一致

- `app/useAppearanceRuntime.ts:30–90` 当前只设置 skin / color-scheme、装载主题并应用排版；不写 `data-accent` 或 `data-control-shape`。`app/appBootstrap.ts:129–150` 会删除旧 accent / shape / radius 设置。CSS 中的对应选择器是遗留分支，不能据此恢复已移除的设置能力。
- Studio 与 Catnip 都是内置主题；Catnip 走 `?raw` 打包注入，不是另一个 `UiSkin`，也不是只能通过外部文件夹安装的示例。相关路径见 `app/userUiTheme.ts:1–11`、`src/shared/ui-themes.ts:1–26`。
- 刷新主题目录不等于同 ID 的 CSS 热重载：读取 effect 当前只依赖 `uiThemeId`（`useAppearanceRuntime.ts:86`）。相对资源 URL 也没有主题目录解析支持；本次不扩展加载器。
- 原生窗口背景与 caption overlay 仍使用 Studio 的明暗固定色（`src/main/window/theme.ts:6–18,43–69`），不读取 Catnip/自定义 CSS palette。不能宣称现有语义变量已经控制整扇原生窗口。

### 2.5 覆盖债务与内容边界

- `review-surfaces.css:1–40` 后置覆盖 `review-artifacts-inline.css:1–30` 的卡片背景、阴影与徽标；接入时应以最终计算外观为基线，收敛规则所有权，而不是继续叠覆盖层。
- PPT 白纸、SVG 图像、模板真实色块要保持原值；但预览模态框标题栏、关闭按钮、侧栏、选中行和纸张周围画布仍是工作台 UI。`review-artifacts-inline.css:333–460` 的固定浅色外壳不应因“PPT 例外”而全部豁免主题化。
- `components/settings/SettingsPrimitives.tsx:4–41` 和 `components/Select.tsx` 已有设置行/分组/面板与支持键盘、portal 定位的公共组件。优先复用，不新增一套平行实现。
- 6px 拖拽条同时参与 CSS 和 `app/useWorkbenchLayout.ts:30–38` 的计算。可以统一内部几何来源，但不能把它变成主题任意可调的 gap，否则命中区域与宽度算法会不一致。

## 3. 新版分层

### A. 基础尺度：内部原料

颜色 ramp、间距尺度、圆角尺度、字号/行高、字重、时长和缓动。基础值稳定，不因切换 dark/light 而整体改变。

保留现有 `--space-1/2/3/4/5/6/8` 的含义。仅按实际需求补 2px、6px 或更大尺度；不要一次添加 0–100 的全量间距表，也不要为了命名对称批量更名。

### B. 用途语义：稳定消费契约

- 视觉：surface、text、border、accent、status、selection、focus、elevation、scrollbar。
- 排版角色：正文、辅助信息、分组标题；引用现有字号/行高对。只为跨区域重复出现的角色增加别名。
- 空间角色：控件高度及水平 padding、图文间距、行内间距、卡片内边距、卡片之间的 gap、分组间距、页面 padding。
- 形状角色：field、button、card、panel、popover；不要再用“control”家族默默决定所有内容面板的形状。
- 布局约束：窗口 chrome inset、标题栏几何、侧栏折叠宽度、拖拽命中宽度等。属于内部共享布局契约，不保证都是用户主题可随意改变的公开参数。

### C. 组件参数：只在确有独立规则时增加

例如 select menu 的最大高度、switch 的轨道/滑块几何、loading ring 尺寸。优先在组件作用域定义；不要把每个组件的每个属性都提升为全局公共 API。

### D. 模块与内容

模块维护 flex/grid、响应式、滚动、溢出和局部光学调整。动态拖拽宽度、定位结果、进度比例、PPT/SVG 作者内容不属于工作台视觉 Token。

文件可以按上述职责拆分，但文件数不是架构目标。建议从现有 `semantic.css` 提取真正混杂的 shape / spacing-size / elevation-layer，保留 `styles.css` 单入口；组件专属 loading 参数回到组件。不新增一套需手工同步的 TS Token 大表；但现有字号默认阶梯已经同时存在于 CSS 与 `src/shared/ui-typography.ts:42–50`，应单独收敛为一个默认值来源，保持 root inline 排版机制不变。

## 4. 圆角、卡片间隙和密度的具体规则

### 圆角

- 基础尺度继续表达 4/6/8/12/16px 与 pill；新增 0 或 2px 只在现有形状和细节场景需要时做。
- field / button / card / panel / popover 按用途引用尺度，可以相等，但不能因为“当前值相等”就合并不同角色。
- 当前没有可用的形状设置 UI；CSS 遗留的是 `sharp / soft / round`，不是 square / rounded / pill。新版应由主题明确映射角色圆角，评估遗留选择器的外部使用边界后清理，不恢复已移除的设置轴。特别是内容面板与交互控件应分别映射。
- 圆形状态点、头像或特定图标的 50% 是几何规则，可以保留。pill 不意味着整个工作台所有卡片都胶囊化。
- focus 样式由公共规则/组件维护；既检查轮廓可见性，也检查与外形的协调，不要求页面逐个计算 focus radius。

### 卡片与分组

建议用途：卡片 inset、布局 stack gap、section gap、page inline padding。候选名称如 `--card-padding`、`--stack-gap`、`--section-gap`；落地时先核对真实消费者。不同密度的布局通过显式变体选择同一尺度，不使用一个万能 `--card-gap` 控制所有页面。

- 卡片本体只管理内部 padding，不携带对外 margin。
- 列表/grid/stack 父级用 gap 决定兄弟卡片间距。
- section gap 表达不同分组的关系，不能和卡片内部标题/正文间距绑在一起。
- 紧凑消息、表单卡片、预览卡片可以有显式变体，不为每个业务页面发明独立 Token。
- 当前阶段优先复用 CSS 结构与已有组件；重复结构和行为确实需要时才抽 Card / Stack，不能只为包一层 div 建组件。

### 密度

将颜色模式、主题形状规则、排版偏好与密度分开；不恢复旧形状设置，也不在本轮新增密度设置 UI。

首轮固化当前 Studio 尺寸作为默认基线。用途层接入并验证后，再提供 compact / comfortable 的离散映射；只改变行高、控件最小高度、padding、gap 等确定的空间角色。不得把基础 `--space-*`、字号、窗口原生按钮安全区一起乘全局 scale。

字号增大时，行高与 padding 决定的内容高度必须能撑开控件；大量固定 height 应区分原生 chrome 与内容控件，后者优先使用 min-height，验收中文、换行和键盘焦点。

### 明暗模式的光学校正与可读性

上一版仅梳理了尺度与颜色契约，未完整讨论感知层。主题 recipe 必须同时负责视觉重量、文字层级、图标线条和表面分离，而不是只替换色值。下述是补充的研究结论与实施边界，不代表已修改默认渲染。

#### “暗色必须减字重”不是通用规则

亮字在暗背景上可能产生视觉扩张、光晕或看起来更粗；但感知粗细、舒适度与实际阅读流畅性不是同一指标，受字体、字号、视力、屏幕亮度和渲染环境影响。不能据此统一给 dark mode 的每种字重减 50 或改成 Light。

- [Apple Typography](https://developer.apple.com/design/human-interface-guidelines/typography.md) 建议通常避免 Light / Thin / Ultralight，特别是小字号；[Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode.md) 强调适应明暗的语义颜色和真实可读性验收，没有要求统一减字重。
- [Google 作者的 CHI 2023 原始研究](https://thereadabilityconsortium.org/wp-content/uploads/2023/07/How-bold-can-we-be-The-impact-of-adjusting-font-grade-on-readability-in-light-and-dark-polarities-1.pdf) 讨论了 halation 和减字重的设计建议，但其 Roboto Flex 实验没有检测到暗色 grade 调整对单词/段落阅读流畅性的改善；不能将这一结果外推成所有字体、语言或视力条件都不受影响。也不能把设计经验写成已有普适实验结论。
- grade 与 weight 不同：有些可变字体的 `GRAD` 轴能够调整笔画视觉重量而不改变字宽；weight 变化可能改变字宽和换行。只有确认字体实际支持并完成测试后，才能把 grade 纳入主题 recipe，不能对系统字体栈全局写 `font-variation-settings`。

#### 当前项目的具体处理

1. **默认不减字重。** `tokens/fonts.css:14–21` 采用系统 UI 字体与中文回退，不是统一的可变字体；不能假设 450/550 有真实字形或 `GRAD` 支持。继续以现有 Regular/Medium/Semibold/Bold 为基线。
2. **尺度与用途分开。** `--font-weight-regular/medium/semibold/bold` 保持含义不变。确有跨区域消费时增加正文、控件标签、分组标题等用途字重，允许主题 recipe 映射；不把全局 `semibold` 改成 `medium` 来掩盖单个标题过粗，也不先创建无人消费的 optical 参数全集。
3. **先校准前景/背景，再判断字重。** `studio.css:22` 的 primary 为纯白，可将非纯白作为正文对照候选，但纯白不等于必然错误。标题、正文、辅助文字分别验收，禁止通过整个容器的 opacity 压低所有内容，或把已有偏弱的辅助文字继续变灰。
4. **不切抗锯齿来伪造减重。** `modules/base.css:23–26` 已明确不启用全局 `-webkit-font-smoothing` 覆盖；保留该约束。该属性非跨平台的标准字重控制，也不能据此保证所有系统获得相同结果。
5. **主题覆盖不能牺牲个人可读性。** 保留字号/行高设置、操作系统明暗与高对比需求；不把内容区放大后的适配问题当成光学校正，PPT 作者内容也不应用工作台排版修正。

#### 不能漏掉的其他细节

| 细节 | 维护位置 | 验收边界 |
| --- | --- | --- |
| 文字亮度、角色字重 | 主题 recipe + 排版用途 | 中英文混排、小字号、粗体层级、长文舒适度；不是所有白字一起减重 |
| 辅助文字、placeholder | text 语义 + 实际背景组合 | 可读文字不能以“muted”命名豁免对比度 |
| 图标视觉重量与对齐 | 共享图标/控件 | 统一尺寸/线条家族，检查图标与标签基线；局部光学偏移留组件，不全局缩放描边 |
| 边框、阴影、暗色浮层 | border / surface / elevation | 阴影在深色背景上可能不够分层，组合表面亮度与边界，不单纯增加黑影 |
| 强调色、选中、focus | accent / selected / focus 语义 | 明暗分别校准；保留键盘可见性，不能只靠色相区分状态 |
| 圆角嵌套与光学居中 | 组件几何规则 | 外内圆角随 inset 的关系、图标重心、中文上下留白；不为每个偏移创建全局 Token |

#### 对比度的已执行局部测算

用 WCAG 相对亮度公式对 Studio 文件中的不透明色值执行了只读 Node 测算；这是配色组合检查，不是浏览器有效样式或完整界面合规审计：

| 前景 / 背景 | 对比度（展示四舍五入） | 普通文字 AA 4.5:1 |
| --- | --- | --- |
| `#ffffff` / `#1c1c1c` | 17.042:1 | 通过 |
| `#b0b0b0` / `#1c1c1c` | 7.858:1 | 通过 |
| `#808080` / `#1c1c1c` | 4.315:1 | 不足 |
| `#808080` / `#242424` | 3.930:1 | 不足 |
| `#808080` / `#2a2a2a` | 3.634:1 | 不足 |

这说明不能以“暗色偏粗”为由继续整体降低文字亮度/字重。上述不足的组合若用于有效的小字号说明、元信息或 placeholder，应优先修正；disabled、纯装饰与符合大字条件的内容按各自标准判断，不能据色值表宣称每个实际使用点均违规。

[WCAG 2.2 SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) 对普通文字要求至少 4.5:1，符合条件的大字为 3:1，并特别提醒细笔画即使名义色值达标也可能难读。验收既包含数值下限，也包含真实渲染，不用其中一个代替另一个。

#### 落地验收

在前述阶段 1 的契约中加入排版用途与明暗 recipe；阶段 2 接入时实际比较同一组正文、菜单、辅助文字、标题和图标。至少覆盖 Windows 实际 Electron 渲染、不同系统缩放、默认/用户字体、中文/英文混排、Studio/Catnip 的明暗及用户大字号；macOS 等平台只能在实际验证后声称通过。

先比较原始版本、仅校准颜色、必要时按角色调整字重，避免同时改所有变量而无法判断改善来源。字号 10–13px 的辅助信息需单独检查；对比度、换行、布局位移与视觉舒适度分别记录。未获得实际字体与界面证据之前，不将“dark weight -50”设成默认主题规则。

## 5. 保留、合并、移除决策

| 对象 | 决策 | 条件与原因 |
| --- | --- | --- |
| surface/text/border/accent/status 核心名字 | 保留 | 已有消费和用户 CSS 主题语义契约，不因重构目录更名 |
| Studio dark/light 与主题加载路径 | 保留 | 已有运行时行为；不能把只保留文件夹主题误当成当前事实 |
| Catnip | 保留并分离 palette 与装饰职责 | 是完整主题，不因类选择器多就判死代码；逐步减少内部组件结构耦合 |
| 字号+行高、字重、字体用户设置 | 保留并扩大接入 | 不把设置页的局部字号别名扩散为第二套全局排版表 |
| spacing / radius / motion 基础尺度 | 保留、归位 | 现有值已支撑默认视觉，先补用途而不是重设全站观感 |
| `settings-density.css` | 拆职责，逐步吸收公共角色 | 控件高度、card gap 可映射公共用途；168px label / 880px content width 等保留为设置布局 |
| `--control-radius-*` 与 field/button/card/panel aliases | 收敛消费者与职责 | role 与 size 不同；先迁移相应调用，不能因当前等值就全部删掉 |
| `--main-radius` 公式 | 替换候选 | 改成可读的 panel/workbench 角色；先保留当前视觉再调设计 |
| `--surface-elevated`、`--shadow-popover` 等非标准引用 | 清理候选 | 对齐现有语义；全量排查定义和外部契约后再移除，不新增同义别名补洞 |
| 局部硬编码颜色、同用途重复 padding / radius / shadow | 迁移后移除 | 用真实用途替换，不因数值相同就错误绑定 |
| 模块内深浅色选择器 | 按职责迁移 | 纯颜色差异回皮肤；确属内容/特效差异的保留在对应主题或组件 |
| loading 等单组件参数 | 降为组件作用域 | 不把内部 ring 尺寸承诺为全局主题 API |
| `display`、`minmax`、0、auto、百分比、原生标题栏安全区 | 保留 | 是结构/平台/几何，不进行机械 Token 化 |
| PPT `src/design-system`、`shared/visual-tokens`、纸面/SVG 作者颜色 | 保持独立 | 不随工作台主题修改，不因为名称相近合并 |
| 疑似未使用 Token | 只列候选，不能本轮直接删除 | 外部用户 CSS、动态 style、自定义主题和导出内容均可能消费；文本零引用不足以证明可删 |
| `--settings-gap`、`--letter-normal`、`--raw-neutral-1000`、`--font-serif`、精确名称 `--accent-purple` | 仓库未发现消费者的候选 | 逐名判断；`--accent-purple-glow` 有消费，不能整组删；`--font-serif` 无消费不等于 Lora 资源可删 |
| legacy accent / control-shape 选择器 | 历史分支，评估后清理 | 运行时已不写属性；外部 CSS 仍可使用，先记录契约去留，不恢复旧产品设置 |
| `BUILTIN_UI_THEME_ID` 的历史别名 | 可统一源码命名 | 迁移全部 import/re-export；持久化 ID `studio` / `catnip` 保留，符号名不是存储兼容边界 |
| 旧 `.project-files-job-status*` | 待确认的清理候选 | 页面已使用共享 `PptJobStatusBar`；全仓核对消费者后再删 |

上述未消费候选来自精确名称全仓搜索，不包括外部用户主题，也不等同于浏览器有效性证明。`src/shared/visual-tokens.ts` 的相关导出目前仅检索到测试消费，不应说它已经驱动生产 PPT 渲染；是否删除或合并它，应在内容设计系统内独立决定，本轮不顺手处理。

内部迁移采用按区域的完整切换，迁移该区域全部调用后删除废弃规则，不长期保留双命名和 fallback 链。对外已公开的主题名字不能套用“内部零引用就删除”的规则；如确需破坏性更名，必须明确契约变更和迁移说明。

## 6. 层叠与主题覆盖

保持现有 root `data-skin` × `data-color-scheme` 与 `data-ui-region` 扩展 hook；accent / control-shape 是 CSS 遗留条件分支，不是当前运行时设置轴。新增密度轴必须是后续显式产品能力，不能本轮凭空写入运行时。已公布的区域 hook 与内部 class 应区别对待；实际 topbar hook 是否升级为公开契约需明确。

当前用户主题注入为完整 stylesheet，不是变量白名单，不能为了“统一 Token”静默限制用户主题能力。推荐的稳定边界仍是语义 Token；类选择器属于高级、可能受 DOM 变化影响的定制。

`styles/README.md:43–45` 已记录主题选择器 specificity 要求。首轮不直接引入 `@layer` 或普遍 `!important`：必须先用 Studio、Catnip、用户 CSS 三种路径验证覆盖关系。

用户非默认字体/字号/行高由 `app/uiTypography.ts:30–70` 写 root inline style；默认值会移除 inline。应保留“显式用户排版偏好优先于普通主题声明”的能力，避免新主题层重新覆盖个人可读性设置；含 `!important` 的完整用户 CSS 仍遵循真实 CSS 层叠，不宣称可绝对约束。

## 7. 接入顺序与退出标准

### 阶段 1：先完善契约，不批量改页面

整理 Token 职责、用途表、默认值、作用域和覆盖轴；补齐已出现的角色缺口。锁定默认视觉基线，保留现有对外语义名。输出可直接查阅的 Token 目录，明确哪些值内部使用、哪些允许主题覆盖。

退出：能解释每类 Token 的所有权与使用边界，深浅色/主题/字体覆盖优先级有明确答案，不只是多了几个 CSS 文件。

### 阶段 2：接入基础与公共组件

先迁移 base、layout、switch、select、通用表单与弹层：统一焦点、disabled、hover/active、尺寸、圆角、阴影、菜单层级及 portal 继承。标题栏拖拽区和 native caption 安全区保留平台约束。

退出：实际启动应用，验证深浅色、菜单、键盘焦点、拖拽条和放大字体；不能只以编译成功或源码不含 px 为标准。

### 阶段 3：按区域完整切换

顺序建议：设置/模型管理 → 侧栏/文件 → 聊天/输入 → 审批/产物 → 画布外壳/放映与复杂主题装饰。每一区域同时处理 CSS 和 JSX 中的视觉字面量；动态计算和内容值不替换。用户正在编辑的样式以最新工作区状态为准，不覆盖其设计。

退出：迁移区域同角色使用一致，旧规则被删除，Studio/Catnip/用户 Token-only 主题都实际可见；预览与导出内容未被染色。

### 阶段 4：密度与治理

在默认基线稳定后，再按用途映射空间密度。检查新增硬编码与不合法 Token 引用，但允许明确的内容、平台和光学例外；例外写在使用点，不建立大而宽泛的白名单。

验收以消费者行为为主：字号放大不截字、窄窗口可操作、portal 样式正确、主题切回不残留、PPT 内容不受污染。静态引用审计用于发现候选，不替代真实渲染，也不新增断言某段源码/某个默认数值的脆弱测试。

### 现有测试能证明什么

本轮仅阅读测试源码，没有运行测试：

- `tests/ui-themes.test.ts`：目录发现、路径/ID 与读取边界，不证明 CSS 级联或视觉生效。
- `tests/user-ui-theme.test.ts`：style 节点注入/更新/移除；Catnip raw 内容被测试配置替代，不证明真实 bundled 主题的视觉。
- `tests/ui-typography.test.ts`：变量缩放和恢复默认，不证明组件消费变量或大字号不裁剪。
- `tests/ui-select.test.tsx`：点击/键盘/disabled，不证明 portal 的真实窗口布局或主题。
- `tests/visual-tokens.test.ts`：内容视觉词汇和 PPT preset，不是工作台 CSS 契约覆盖。

后续迁移验收还应包含 reduced-motion、菜单/模态框/Toast/全屏的层级，以及默认排版和非默认排版两条路径。已有源码字符串约束不作为新契约范式；迁移相关行为时用消费者行为验收替代，而不是重写源码正则来锁定实现。

## 8. 本轮验证范围

已读取官方资料并执行只读 Node 脚本，统计实际 CSS 文件和变量定义规模；已核对主题注入和用户排版覆盖实现。本轮仅修改研究文档，没有运行构建或测试，没有启动 UI，因此不声称任何新版视觉、密度或主题行为已经通过运行验收。
