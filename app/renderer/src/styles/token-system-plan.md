# 三风格主题优化与渐进接入方案

日期：2026-10-29。状态：主题底座、四组合配方、区域消费者与系统联动已实施；验收范围见末节。

本方案将[前期研究](./token-system-review.md)收敛为当前产品的契约、映射和验收要求。落地后的消费契约及迁移说明以[样式维护文档](./README.md)为准；下面保留设计决策与实施门槛，不能把验收矩阵中未实际执行的平台场景视为已通过。

## 1. 三种视觉方向，四种配色组合

仓库实际注册两个主题 ID：`studio`、`catnip`（`src/shared/ui-themes.ts:11–14`），不是三个独立主题。本文将“三套风格”解释为 Studio 暗色、Studio 浅色、Catnip 定制风格；Catnip 自身继续支持夜猫草莓与草莓牛奶，形成四种验收组合。外部用户主题为额外兼容路径，不算第三个内置 ID。

依据为当前 `studio.css`、`catnip.css`、外观设置及 `images/首页.png` / `images/猫娘定制版.png`。图片只是已有设计参考，不作为当前运行时截图或验收证据。

| 方向 | 保留的设计身份 | 优化重点 | 不允许的退化 |
| --- | --- | --- | --- |
| Studio 暗色 | 石墨灰、克制青蓝、连续窗口 chrome、紧凑工具感 | 主文字略柔化；辅助文字提亮；浮层分离；图标和标题重量协调 | 全局减字重、灰字过暗、用更重黑影代替层次 |
| Studio 浅色 | 中性浅灰 chrome、白色工作面、清晰信息层次 | 控件边界、辅助文字、强调按钮对比度、阴影克制 | 所有背景纯白、浅灰说明不可读、饱和蓝铺满卡片 |
| Catnip | 紫粉氛围、柔和大圆角、猫耳、局部装饰与轻弹性 | 明暗都可读；粉色区分装饰/文字/按钮；装饰不侵占内容与操作 | 为统一而抹掉个性、手写字体用于长文、装饰挡点击、粉色等同危险状态 |

三者共享结构、交互与信息层次，不强制同色、同圆角或同阴影。Studio 的 light/dark 共用几何；Catnip 的 light/dark 也共用几何。明暗切换本身不应重排页面。

## 2. 方案修正：先补哪些不足

1. 从“有变量”提升到“每项设计决策有唯一维护入口”：基础尺度、用途角色、组件实现分开。
2. 从“换颜色”提升到“颜色组合可读”：分别管理强调色、文字链接、实心按钮背景与其文字，避免一个粉色/青色承担所有职责。
3. 加入排版用途与光学校正：不采用 dark weight -50；系统字体、中文回退与用户排版保持有效。
4. 加入状态矩阵：hover、pressed、selected、keyboard focus、disabled、read-only、loading、error 不能各页面临时设计。
5. 收敛最终样式所有权：尤其 `review-*` 的后置覆盖、Composer 的多层描边和 `!important`。
6. 明确平台与内容例外：原生标题栏、拖拽算法、PPT 纸面和 SVG 作者内容不由皮肤任意改变。
7. 补齐切换生命周期：Studio ↔ Catnip ↔ 用户 CSS、系统明暗变化、恢复字体默认、portal 和减少动态效果都进入验收。

## 3. 契约架构与文件职责

维持现有 CSS Custom Properties 和 `styles.css` 有序入口，不引入 CSS-in-JS、主题算法库、全仓 `@layer` 或重复 TS Token 表。

| 层 | 拟落点 | 所有权与消费规则 |
| --- | --- | --- |
| 基础原料 | 现有 primitives / typography / motion | 色阶与有限尺度；modules 不读 raw 色阶；字号配对行高 |
| 视觉语义 | semantic | surface/text/border/accent/status/elevation/focus/scrollbar；根节点公开的稳定名字 |
| 空间用途 | 从 semantic / settings-density 整理为 geometry.css | 角色圆角、控件高度、inset、stack/section gap；不复制动态分栏状态 |
| 主题 recipe | studio 与 catnip 的配色/形状/动效参数 | 每个配色组合显式赋值，不依赖已退出运行时的 data-accent 分支 |
| 公共组件 | components 与已有 SettingsPrimitives / Select | 状态、内部布局、slot、键盘可见焦点、组件专属几何 |
| 业务模块 | modules | 区域布局、响应式、阅读宽度、局部光学修正；只消费适当的公开/内部契约 |
| 私有装饰 | Catnip 自有 recipe/装饰段 | 猫耳、网格、氛围渐变、装饰动画；不推广为通用 Token |

几何契约先以一个小文件整理，不预建庞大的目录树。loading ring 等单组件参数归组件内部，settings label/content width 等保留区域布局。字号 CSS 与 `shared/ui-typography.ts` 现有重复默认值需收敛为一个来源；生成仅限确实需要跨 CSS/TS 的默认排版数据，不借此建立全量 Token 构建平台。

### 3.1 保留的名字

- 保留已有 `--surface-*`、`--text-primary/secondary/muted/on-accent`、`--border-*`、`--accent-primary`、`--accent-selected-*`、status、`--elevation-*`。
- 保留 `--field/button/card/panel-border-radius` 用途；不要因为默认值一样删除角色。
- 保留 `--space-1/2/3/4/5/6/8` 含义，不批量改编号。确有消费者才补 2px/6px 等小尺度。
- 保留字体、字号/行高的用户设置，保持默认值回收 inline 的行为。

### 3.2 必须补齐的最小角色

| 候选契约 | 用途 | 约束 |
| --- | --- | --- |
| `--accent-action-bg` | 实心主要操作背景 | 与现有 `--text-on-accent` 成对校验；不能默认等于装饰强调色 |
| `--accent-link-text` | 链接、文字型强调操作 | 在允许的阅读背景上达标；selected text 按实际底色另测 |
| `--control-height-sm/md`、`--control-padding-inline` | 内容控件尺寸 | 用 min-height 配合实际文字高度，不缩放 native chrome |
| `--control-gap`、`--card-padding` | 图文间距、标准卡片内部留白 | 组件内部用途，不支配卡片外部距离 |
| `--layout-gap-compact/default`、`--section-gap` | 父级布局节奏 | 父容器选择档位，不设万能 card-gap |
| `--popover-border-radius` | 菜单等浮层外形 | 菜单项仍用较小角色圆角 |
| `--type-body/label/heading-weight` | 正文、控件标签、分组标题字重 | 有真实跨区消费者后增加；基本字重常量保持语义不变 |

焦点优先复用并明确 `--border-focused` 的用途，由公共 focus recipe 读取；不再增加语义相同的多个 focus-color。`--accent-primary-contrast` 与 `--text-on-accent` 的内部消费者统一到后者；前者是否属于对外契约单列评估，不长期保留内部双命名。

### 3.3 作用域与覆盖优先级

- 主题公开语义在 root 定义，确保 portal 到 body 的 Select/菜单能消费同一 recipe；不能只在 sidebar/settings 内写主题变量。
- 组件私有变量在组件边界定义。CSS 中在 root 计算的派生值不会因子树覆盖其依赖自动重新计算；需要局部变体的派生值应在消费作用域计算。
- 顺序：基础默认 → Studio 明暗 → 当前附加主题 → 用户显式排版 inline。保持现有完整 CSS 主题能力；不承诺对抗用户 CSS 的 `!important`。
- 保持 `:root[data-skin][data-color-scheme]` specificity 契约；引入新文件不能改变外部主题原有覆盖关系。
- `skin` 继续为 studio；Catnip 仍是附加主题。几何、明暗、密度不混成新主题 ID，不恢复旧 accent/control-shape 设置。

## 4. 四组合的可读性候选映射

保持四组合当前五种 surface 色值，先改变失衡的文字/强调关系，不同时重设计整个背景体系。Studio 暗色 primary 采用非纯白候选；这是一项视觉选择，不是宣称纯白必然错误。Catnip 保留有色中性色与品牌粉色，浅色操作使用更深的莓果色。

### 4.1 目标色值

以下是不透明候选值；已进行公式检查，尚未完成真实界面视觉验收。

| 组合 | primary | secondary | muted | link/focus | 实心主要操作背景 | 操作文字 |
| --- | --- | --- | --- | --- | --- | --- |
| Studio 暗色 | `#eceef0` | `#b0b0b0` | `#a0a0a0` | `#38bdf8` | `#0369a1` | `#ffffff` |
| Studio 浅色 | `#0f1217` | `#4a5160` | `#596372` | `#0369a1` | `#0369a1` | `#ffffff` |
| Catnip 暗色 | `#fff4fb` | `#d9bfd2` | `#b19bae` | `#ff78b5` | `#ff78b5` | `#2b1020` |
| Catnip 浅色 | `#3f2837` | `#67495e` | `#795b70` | `#b72a70` | `#b72a70` | `#ffffff` |

`--accent-primary` 仍表达身份/装饰/强调，不要求等于 action-bg。Catnip 浅色保留原亮粉用于局部装饰，不能继续用同一个亮粉搭白色小字实心按钮。Studio 必须显式设置各模式有效 accent，不能只改 `--accent-cyan`，却期待运行时不再设置的 `data-accent` 负责转接。

### 4.2 已执行的数值检查

用 WCAG 相对亮度公式对每组合当前 canvas/base/raised/sunken/overlay 的不透明背景计算最小对比度；Studio 浅色的 raised/overlay 同为白色。判定基于未四舍五入的值，表格仅展示三位小数。

| 组合 | 现有 muted 最小值 | 候选 primary 最小值 | 候选 secondary 最小值 | 候选 muted 最小值 | 候选 link 最小值 | 候选实心操作文字 |
| --- | --- | --- | --- | --- | --- | --- |
| Studio 暗色 | 3.634 | 12.340 | 6.618 | 5.489 | 6.700 | 5.934 |
| Studio 浅色 | 4.011 | 15.567 | 6.607 | 5.047 | 4.923 | 5.934 |
| Catnip 暗色 | 4.325 | 12.696 | 7.995 | 5.296 | 5.579 | 7.185 |
| Catnip 浅色 | 2.936 | 11.233 | 6.553 | 4.977 | 4.928 | 5.868 |

第一轮 Catnip 浅色 muted `#806277` 最小值只有 4.486，已淘汰，改用上表候选。现有 Studio 在无 data-accent 时从 semantic 使用 `#0ea5e9`，其白色文字约 2.771；Catnip 浅色 `#f6539f` 搭白字约 3.155。它们不能直接作为普通小字实心按钮的合格配对。

这些只是配色组合风险，不宣称所有实际消费者违规；实际 computed style 可能被覆盖，disabled/纯装饰也适用不同边界。渐变、透明叠层、hover/selected 底色、图像、滤镜及 Catnip glass 还需要合成后的实际背景检查，不能拿本表直接宣称全主题达标。候选色不得再额外乘 0.78 之类透明度用于有效 placeholder。

### 4.3 状态文字候选

| 组合 | danger | success | warning | 三者在允许背景上的最低值 |
| --- | --- | --- | --- | --- |
| Studio 暗色 | `#f87171` | `#34d399` | `#fbbf24` | 5.189 / 7.466 / 8.598 |
| Studio 浅色 | `#b91c1c` | `#047857` | `#854d0e` | 5.368 / 4.550 / 5.684 |
| Catnip 暗色 | `#ff7088` | `#7de6a5` | `#f0cf72` | 5.138 / 8.903 / 8.993 |
| Catnip 浅色 | `#b42345` | `#087052` | `#855013` | 5.398 / 5.112 / 5.591 |

状态色是文字/图标角色，不是任意实心填充配白字的许可。尤其浅色 success 候选余量有限，不能加透明度；状态徽标底色需单独合成校验。状态必须同时有文字、图标或结构提示，不能只靠红绿或粉色深浅。

## 5. 排版、圆角与空间映射

### 5.1 排版组合

| 角色 | 默认映射 | 三风格差异 |
| --- | --- | --- |
| 普通正文 | 现有 text-base / base-lh，400 | 两种 Studio 共用系统字体；Catnip 正文保留可读 UI 字体 |
| 控件标签 | text-base，500；行高与 padding 配合 | 不因 dark 自动减重；大字号可撑开控件 |
| 辅助说明 | text-sm / sm-lh，400 | 使用已校准 muted；有效信息不叠低透明度 |
| 分组标题 | text-md / md-lh，600 | Catnip 可用 display 字体，但中文回退、长标题必须验收 |
| 页面标题 | text-xl / xl-lh，600 | 保留风格表达，不让手写风格扩散到菜单/表格/长文 |
| 代码/数字 | mono 与对应字号/行高；数字按用途采用 tabular | 不改变内容代码；不因主题改变数字含义或列对齐 |

不统一设置负字距；中文正文默认不挤压。10/11px 只用于非关键短元信息，不承载说明、错误或必须读懂的操作。光学调整以同屏比较为依据，不默认配置 GRAD，不把 450/550 当所有系统字体都有的真实字重。不启用全局字体平滑覆盖。

### 5.2 角色圆角目标

| 角色 | Studio 暗/浅 | Catnip 暗/浅 |
| --- | --- | --- |
| badge / menu item | 4px | 6px |
| field | 6px | 9px |
| button | 8px | 13px |
| card | 12px | 18px |
| panel | 16px | 24px |
| popover | 8px | 13px |
| pill / circle | 保持几何语义 | 保持几何语义 |

实施前 `--main-radius` 公式结果为 12.4px；此次在几何抽离后完成了角色切换与实际界面校准，Studio 主面板采用 16px、Catnip 采用 24px。旧公式和内部引用已移除。Catnip 非对称气泡仍是有意的组件变体，不强行改为普通 card。

嵌套圆角由组件结合 inset 维护：同心嵌套可用外圆角减内缩距离并下限为 0，不能将其当所有卡片的通用公式。曲面、猫耳和非对称气泡按各自几何处理。

### 5.3 默认空间节奏

先保留当前信息密度，不新增密度设置。三风格共用下列功能性角色，Catnip 的更柔和感主要来自外形、颜色和局部装饰，不默认把所有间距放大。

| 角色 | 默认目标 | 使用边界 |
| --- | --- | --- |
| 紧凑 / 标准控件最小高度 | 28 / 32px | 不适用于 native titlebar；字体增大时允许撑开 |
| 标准控件水平 padding | 8px | 文字型/强调型按钮可按组件显式变体取 12px |
| 图标与标签 gap | 8px | 细节组合需要 4/6px 时留组件并说明用途 |
| 标准卡片 inset | 16px | 紧凑工具卡取 12px；不应用到聊天气泡或纸张内部 |
| 父级紧凑 / 标准 stack gap | 8 / 16px | 由父容器选择，不让子卡片叠 margin |
| 分组 gap | 24px | 表达组间关系，不替代卡片内 gap |
| 设置页 padding | block-start 24px、inline 32px、block-end 32px | 保留当前默认；窄布局 inline 换到 16px，按现有容器响应式接入 |
| 设置 row 最小高度 | 36px | label 168px / content 880px 仍为设置布局约束 |

字体和行高放大后不能因 fixed height 裁剪中文；设置行在内容放不下时切为标签/控件上下排列，触发点由实际内容/容器决定，而不是把所有断点改成一套魔法数字。

compact/comfortable 留作后续独立产品能力，仅映射空间角色；本次不增加 UI，也不更改基础 space 值或用户字号。几何可有 px，排版由现有字号机制控制，不顺手改全站 rem 基准。

## 6. 公共组件状态与光学校正规范

| 状态 | 共用行为与视觉 | 风格允许的变化 |
| --- | --- | --- |
| default | 明确文字、背景和可识别操作边界 | 颜色、形状、阴影 |
| hover | 合成底色变化，不靠位置变化提示可操作性 | Catnip 可有局部轻高光，不改变尺寸/命中区 |
| pressed | 与 hover 可区分，释放后恢复；实际禁用不触发动作 | 背景或内边界变化，不把所有控件整体缩放 |
| selected / checked | 持久状态，区别于指针悬停和键盘活动项 | 主题色 + 图标/标记；selected 背景与文字配对检查 |
| focus-visible | 公共 recipe：2px 清晰外轮廓、2px offset；实际遮挡与对比度检查 | 使用四组合 focus 候选；不被 box-shadow 或卡片装饰吞掉 |
| disabled | 阻止对应操作，明确状态；不把只读信息一起变淡 | 可降低控件强度，但不在整组内容上施加低 opacity |
| read-only | 仍可读、可选择复制，与 disabled 不混淆 | 中性 surface，不删除必要文字对比 |
| loading | 保留操作标签与尺寸，状态可理解；仅阻止不应重复的操作 | Spinner/进度样式，不用位移造成布局跳动 |
| error / warning | 信息、关联字段和恢复方式可理解；不只颜色变化 | 状态色与图标，粉色品牌装饰不代替错误语义 |

装饰性分割线不要求全部加粗到 3:1；用于识别控件、关键状态或焦点的非文字视觉信息需按对应 WCAG 条件检查。普通文字按 4.5:1，符合大字条件才用 3:1，placeholder 不自动豁免。参考标准与证据见研究文档。

### Catnip 特别处理

- 猫耳和氛围渐变保留，使用主题私有变量；装饰不承载业务语义，不截断、不挡点击，不侵入 PPT 纸面。
- Composer 单一外层 focus-within 边界可以代替 textarea 的重复矩形描边，但只有外层焦点可见且 textarea/附件/发送按钮逐一可辨认时才能移除内层 outline；不能继续一概清除所有内部 focus。
- 鼠标悬停与 focus 不改变布局尺寸；现有 focus translateY(-1px) 与循环猫耳动画需单独评估，减少动态效果时移除非必要位移，保留静态焦点。
- 透明 glass 与 glow 仅作局部装饰；阅读区使用稳定底层 surface，关闭透明效果时仍有不透明可读底色。不新增透明度设置，但保留高对比/平台偏好的渐进增强边界。
- 将 `catnip.css:487–525` 的清除规则收敛成共享 Composer 明确的“内层无框”配方；placeholder 不继续额外稀释；不靠增加 `!important` 竞争获胜。
- Catnip 使用的弹性 ease 保留给非关键装饰，不用于滚动定位、菜单几何或进度；用户 reduced-motion 下保留必要状态可辨识性。

## 7. 层级、平台、内容与切换边界

- 保留 z-index 语义，但先明确 owner/stacking context。标题栏局部 2/5 与全局 modal 不混为一个排序表；不靠把所有菜单 z-index 提到最大解决遮挡。
- body portal 的 Select 必须在模态框/全屏对应 owner 下可用。全屏内部操作不应因当前全局数字小于 fullscreen 而被盖住；挂载所有权与层级需一起验收，而非本次设计直接重写 portal 架构。
- 主/副分栏宽度、6px resizer、56px 折叠 rail、可用主区最小宽度是 CSS 与 TS 共享约束，不向外部主题承诺任意可调。若统一来源，必须同时迁移宽度算法和样式。
- 原生 caption overlay 当前只跟随 Studio 明暗固定色。首轮明确这一限制，不声称 Catnip token 已覆盖系统按钮，也不新增 IPC palette API；如后续需要完全同色，独立处理平台能力和安全区。
- PPT 纸面、SVG 图像、模板真实色板与导出保持内容事实源；不套 filter、opacity、暗色减重或主题字体。预览外壳、缩略图标签与工具栏继续属于 UI。
- theme 切换复用单一 style 节点；切回 Studio 应移除 Catnip 所有 palette/装饰效果，不能有遗留 class、inline 或附加节点。Catnip 与用户 CSS 切换不合并两套附加主题。
- 系统明暗自动切换不重新挂载对话、不丢焦点、不重置拖拽状态。用户非默认排版优先，恢复默认后重新由主题字体接管。
- 外部主题保持现有目录、ID 和完整 CSS 支持；列表刷新不等于热重载，相对资源 URL 不受支持。本次不扩展加载器，不引入 manifest 或兼容 shim。

## 8. 保留、合并、删除的实施决策

| 决策 | 具体对象 | 完成条件 |
| --- | --- | --- |
| 保留 | Studio 两模式、Catnip 两模式、用户 CSS、主题 ID、区域 hook | 同一交互结构，身份差异保留，持久化不破坏 |
| 保留并映射 | field/button/card/panel、space、字体用户设置 | 当前消费者按职责迁移，默认含义不随意改名 |
| 合并公共用途 | 设置/模型管理控件尺寸、图标按钮、菜单、状态反馈 | 优先复用 SettingsPrimitives、Select、run-status、loading；不抽万能 Button/Card |
| 收敛覆盖 | review 卡片最终外观、两种预览窗口外壳、Composer 内层无框 | 布局归业务模块，公共外观归唯一 recipe；删除确认被替代的声明 |
| 替换内部旧路径 | surface-elevated、shadow-popover、main-radius 公式 | 全部内部消费者切换，移除冗余 fallback；公开外部接口风险明确记录 |
| 删除候选 | settings-gap、letter-normal、raw-neutral-1000、font-serif、精确 accent-purple、旧 job-status | 逐名核对全部消费者/资源用途/外部承诺，确认后删除；不按数值相等或文本零引用批删 |
| 清理历史分支 | data-accent/control-shape、BUILTIN_UI_THEME_ID 历史符号别名 | 不恢复旧设置；内部 import/re-export 一次迁移；对外 CSS 契约变化单列说明 |
| 不动 | PPT 内容设计系统、作者 SVG、数据比例、动态坐标 | 不纳入 UI Token 清理，不顺手删除当前无生产消费者的内容词汇表 |

公开主题名字如确需破坏性移除，应与该区域迁移同批提供迁移说明；不能一边说契约稳定，一边因内部没引用就删。内部切换不长期维护新旧同义 Token 或兼容 re-export。

## 9. 分阶段实施与完成门槛

### A. 契约与主题底座

整理 geometry 职责与默认排版来源，显式声明四组合 recipe 和 action/link 角色；保持现有默认视觉作为接入基线，单独记录本方案中的视觉调整。交付 Token 目录，逐项含用途、默认值、允许的覆盖轴、消费者、作用域和例外。

门槛：引用无环、缺失 Token 有结论、用户主题 specificity 不变、颜色候选公式检查完成；不能仅以新文件存在算完成。

### B. 共享控件与设置

迁移 base、switch、Select、SettingsPrimitives、settings nav/forms/panels、model management 的公共配方；再接入 layout，保留 TS/CSS 的几何一致性。应用本方案的文字、强调配对与默认空间角色。

门槛：四组合的真实控件 default/hover/pressed/selected/focus/disabled/read-only/loading/error 可用；字号/行高上限不截字；Select 的键盘与真实窗口避让不回退。

### C. 工作区按区域完整切换

侧栏/文件 → 聊天/Composer → 审批/产物 → 预览/放映外壳。每一区域同步处理 CSS 和 TSX 中真正的视觉值，清除已替代的规则。Catnip 装饰每迁移一区域同步适配，不留到最后才发现主题失效。

门槛：单区所有消费者完成迁移；没有以新增覆盖层掩盖的旧视觉；PPT 内容、动态测量和操作行为不变。

### D. 光学验收与遗留清理

逐步对照“基线 → 仅调颜色 → 必要的角色字重/圆角/装饰调整”，分别记录对比度、布局、感知结果，不一次修改所有变量。核对删除候选、旧 shape/accent 和符号别名；更新主题作者指南。默认基线稳定后才另行决定是否做密度设置，不把该可选产品功能当成当前重构的未完成项。

门槛：完整通过下述矩阵，或逐项明确尚未支持的平台边界；不得把 jsdom、构建成功或数值对比度当作视觉完成证明。

## 10. 运行时验收矩阵

| 维度 | 必须覆盖的场景 | 通过条件 |
| --- | --- | --- |
| 配色 | Studio 暗/浅、Catnip 暗/浅、token-only 用户 CSS | 外壳完整生效，无旧色残留；透明/渐变背景按合成色检查 |
| 生命周期 | 四组合往返、Catnip→用户→Studio、系统明暗自动变化 | 无主题串色、内容重置、焦点丢失或异步旧主题覆盖 |
| 排版 | 默认/非默认字体，字号与行高上下界，中英文混排、长标题/路径 | 不截字、不伪造字体支持；恢复默认回到主题 recipe |
| 平台 | Windows 实际 Electron，至少 100%/125%/150% 缩放 | 小字/图标清楚，分栏和 caption 安全区正确；未实测平台不宣称通过 |
| 布局 | 窄窗口、侧栏折叠/拖拽、右预览展开、设置行换行 | 视觉与命中区一致，无新增双滚动或不可达操作 |
| 状态 | 公共状态矩阵、键盘 Tab、Select Arrow/Enter/Escape | focus 可见，selected 不等于 hover，状态不只颜色提示 |
| 层级 | Select/菜单→模态框→Toast→应用内全屏，实际 body portal | 遮挡/关闭/定位正确；局部 stacking context 不冒充全局层级 |
| 装饰与偏好 | Catnip 猫耳/渐变/透明、reduced-motion、高对比可用路径 | 装饰不挡内容，减少动态后保留可理解状态；不强行关闭用户系统颜色 |
| 内容隔离 | 白纸、SVG 原色、16:9、模板色板、预览/导出 | 工作台换肤不改变作者内容和导出事实源 |

先复用现有行为测试；新增永久测试只覆盖真实消费风险，例如主题异步竞态、恢复默认、键盘状态或内容隔离。字号截断、视觉层级和光学校正使用实际 Electron/浏览器验收，不新增锁定源码字符串或某个默认像素值的测试。

## 11. 实施与验证记录

### 已实施

- 新增 `geometry.css`，从 semantic 分离尺寸和形状；loading 几何归组件，设置局部布局与公共空间角色分开。
- Studio 与 Catnip 显式定义明暗配色，区分身份色、可读链接、实心操作与 hover/pressed，保留用户完整 CSS 主题能力。
- 排版阶梯统一由 `shared/ui-typography.ts` 在首屏安装低优先级默认样式；显式用户排版与恢复默认后的主题接管均保留。
- 公共控件、设置及业务区域完成角色接入；清理审阅卡片竞争规则、旧任务状态选择器、非标准变量引用和退出运行时的 accent/shape 分支。
- Catnip 保留猫耳、紫粉氛围、非对称气泡；Composer 无框内层与清晰外层焦点分离，减少动态效果不清除焦点。
- 实测发现系统变化未被订阅，已用 `useSyncExternalStore` 订阅媒体偏好；同时修正 Electron 原生 `system` 被解析成固定明暗的行为，系统更新时同步 caption/background，不增加自定义 palette IPC。

### 已观察的界面证据

- Windows Electron 四组合设置页截图；真实 CSS 计算结果中，正文/辅助文字在五种基础 surface 上，以及实心操作默认/hover/pressed、选中文字的配对均超过 4.5:1。此结论不扩大到所有透明叠层和所有业务状态。
- 820px 窗口、20px 基准字号、2.2 行高：设置行单列，输入框随文字撑开，无页面水平溢出；恢复默认后 inline 覆盖移除，Catnip display 字体重新接管，默认样式节点只有一个。
- 真实 body-portaled Select 在模态框之上可命中，ArrowDown 改变活动项，Escape 仅关闭菜单、不关闭底层对话框；未保存厂商草稿。
- 实际 Catnip Composer 内层 textarea 为 0 边框、无重复 outline；外层 focus-within 有可见轮廓。reduced-motion 下 transition 为 0、位移与猫耳动画关闭，焦点仍保留。
- 最终生产构建在前台渲染状态下实测媒体偏好 light → dark → light，页面随之变化；显式 dark 模式保持不变。原生主题的固定模式/系统模式及 caption 更新另有行为回归覆盖。
- 外部 example → Catnip → Studio 往返后，附加主题 style 节点数量为 1 → 1 → 0，默认排版节点始终为 1。
- 使用临时 DOM 夹具检查实际放映样式：四组合均保留白纸、640×360 几何，图像 filter 为 none、opacity 为 1；夹具检查后即移除，不冒充真实文档导出验收。
- `npm run build`（含两套 TypeScript 检查）通过；最终 `npm test` 为 174 个文件通过，1184 项通过、1 项跳过。修改范围的 Biome 检查通过；41 个 CSS 文件解析及引用审计未发现未定义变量（排版运行时与动态分栏变量纳入来源）。

### 验证边界

实际系统缩放为 125%；100%/150% 系统级缩放、macOS、物理显示器与视力条件下的光学舒适度未做实测，不宣称通过。现有预览/放映行为测试继续作为尺寸与选页回归；媒体偏好通过 CDP 模拟，未修改操作系统全局明暗；界面截图与样式夹具不等同于重新导出一份 PPTX 的人工验收。

没有新增密度设置、主题热重载、相对资源加载或原生自定义调色 API；这些是方案明确排除的产品扩展，不作为本次 Token 接入的空实现保留。
