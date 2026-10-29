import type { FontFamily } from "@shared/typography";

import type {
  ArgumentMode,
  BackgroundStyle,
  ChartStyle,
  ColorScheme,
  Density,
  DesignPalette,
  DesignTokens,
  FontMood,
  ImageTreatment,
  Motif,
  ReadingMode,
  ShapeLanguage,
  VisualStyle,
} from "./schema";

/**
 * Adapted from the MIT-licensed ppt-master reference catalogs and inlined here
 *
 * Deliberately contains no HEX values. A visual style specifies how colors are
 * used; the independent color scheme supplies the actual colors.
 */

export const IMAGE_RENDERINGS = [
  "minimalist-swiss",
  "flat",
  "glassmorphism",
  "digital-dashboard",
  "blueprint",
  "editorial",
  "corporate-photo",
  "screen-print",
  "vintage-poster",
  "paper-cut",
  "sketch-notes",
  "ink-notes",
  "chalkboard",
  "watercolor",
  "pixel-art",
] as const;

export const ILLUSTRATION_PROPENSITIES = ["core", "supportive", "sparse"] as const;
export const TEXTURE_KINDS = [
  "none",
  "paper-grain",
  "halftone",
  "frosted-glass",
  "fine-grid",
  "chalk-dust",
  "ink-bleed",
  "misregistration",
  "pixel-grid",
] as const;

export type ImageRendering = (typeof IMAGE_RENDERINGS)[number];
export type IllustrationPropensity = (typeof ILLUSTRATION_PROPENSITIES)[number];
export type TextureKind = (typeof TEXTURE_KINDS)[number];

export interface VisualStyleDefinition {
  id: VisualStyle;
  label: string;
  summary: string;
  bestFor: readonly string[];
  shape: {
    language: ShapeLanguage;
    radius: number;
    strokeWidth: number;
    strokeStyle: "solid" | "dashed" | "dotted";
    decoration: "none" | "restrained" | "expressive";
    character: string;
  };
  elevation: {
    kind: "flat" | "soft-shadow" | "hard-offset" | "glow" | "layered";
    level: 0 | 1 | 2;
    shadow?: { x: number; y: number; blur: number; spread: number; opacity: number };
  };
  whitespace: {
    density: Density;
    margin: number;
    gutter: number;
    sectionGap: number;
    cardPadding: number;
    rhythm: "tight" | "balanced" | "airy" | "vast";
  };
  typography: {
    mood: FontMood;
    headingFamily: FontFamily;
    bodyFamily: FontFamily;
    dataFamily: FontFamily;
    headingWeight: number;
    bodyWeight: number;
    headingScale: number;
    bodyScale: number;
    tracking: number;
    lineHeight: number;
    character: string;
  };
  background: {
    style: BackgroundStyle;
    field: "light" | "dark" | "adaptive";
    gradient: "none" | "subtle" | "luminous";
    pattern: "none" | "grid" | "dots" | "halftone" | "pixel";
    colorUsage: string;
  };
  texture: {
    kind: TextureKind;
    opacity: number;
  };
  imageRendering: ImageRendering;
  imageTreatment: ImageTreatment;
  illustrationPropensity: IllustrationPropensity;
  grammarPreferences: {
    motif: Motif;
    chartStyle: ChartStyle;
    preferredVariants: readonly string[];
    avoid: readonly string[];
    composition: string;
  };
}

const STYLES: Record<VisualStyle, VisualStyleDefinition> = {
  "swiss-minimal": {
    id: "swiss-minimal",
    label: "瑞士极简",
    summary: "严格网格、锐利几何、强留白与近零装饰。",
    bestFor: ["高端咨询", "建筑", "设计机构", "文字主导"],
    shape: {
      language: "geometric",
      radius: 0,
      strokeWidth: 1,
      strokeStyle: "solid",
      decoration: "none",
      character: "锐利矩形、真圆与单线宽规则",
    },
    elevation: { kind: "flat", level: 0 },
    whitespace: {
      density: "calm",
      margin: 132,
      gutter: 40,
      sectionGap: 56,
      cardPadding: 28,
      rhythm: "vast",
    },
    typography: {
      mood: "minimal",
      headingFamily: "sans",
      bodyFamily: "sans",
      dataFamily: "sans",
      headingWeight: 800,
      bodyWeight: 300,
      headingScale: 1.18,
      bodyScale: 1,
      tracking: -0.02,
      lineHeight: 1.35,
      character: "单一 grotesque sans，以字重反差建立层级",
    },
    background: {
      style: "clean",
      field: "light",
      gradient: "none",
      pattern: "none",
      colorUsage: "近白底；一个主色概念分区；强调色只落一个点",
    },
    texture: { kind: "none", opacity: 0 },
    imageRendering: "minimalist-swiss",
    imageTreatment: "plain",
    illustrationPropensity: "sparse",
    grammarPreferences: {
      motif: "none",
      chartStyle: "minimal",
      preferredVariants: ["centered", "statement-stack", "split"],
      avoid: ["cards", "centered-card"],
      composition: "模块网格、非对称轴向切分、单个海报尺度几何面或英雄数字",
    },
  },
  "soft-rounded": {
    id: "soft-rounded",
    label: "柔和圆角",
    summary: "圆角容器、友好字体与克制的柔和悬浮层级。",
    bestFor: ["产品", "SaaS", "培训", "消费品牌"],
    shape: {
      language: "cards",
      radius: 14,
      strokeWidth: 1,
      strokeStyle: "solid",
      decoration: "restrained",
      character: "一致半径的圆角矩形、胶囊标签与柔和容器",
    },
    elevation: {
      kind: "soft-shadow",
      level: 1,
      shadow: { x: 0, y: 8, blur: 24, spread: 0, opacity: 0.12 },
    },
    whitespace: {
      density: "standard",
      margin: 112,
      gutter: 28,
      sectionGap: 40,
      cardPadding: 28,
      rhythm: "balanced",
    },
    typography: {
      mood: "warm",
      headingFamily: "sans",
      bodyFamily: "sans",
      dataFamily: "sans",
      headingWeight: 650,
      bodyWeight: 400,
      headingScale: 1.06,
      bodyScale: 1,
      tracking: 0,
      lineHeight: 1.45,
      character: "开放、圆润的 humanist/geometric sans",
    },
    background: {
      style: "gradient",
      field: "light",
      gradient: "subtle",
      pattern: "none",
      colorUsage: "主题色可做章节面，同色浅 tint 做容器，遵循 60-30-10",
    },
    texture: { kind: "none", opacity: 0 },
    imageRendering: "flat",
    imageTreatment: "framed",
    illustrationPropensity: "supportive",
    grammarPreferences: {
      motif: "arc",
      chartStyle: "minimal",
      preferredVariants: ["cards", "three-takeaways", "steps"],
      avoid: ["editorial-columns"],
      composition: "柔和色场、胶囊链、圆弧与单个英雄面板；卡片只作容器而非每页阵列",
    },
  },
  glassmorphism: {
    id: "glassmorphism",
    label: "玻璃拟态",
    summary: "暗场上的透明玻璃面板、渐变光与漂浮深度。",
    bestFor: ["现代 SaaS", "金融科技", "产品发布", "AI 演示"],
    shape: {
      language: "cards",
      radius: 18,
      strokeWidth: 1,
      strokeStyle: "solid",
      decoration: "restrained",
      character: "半透明玻璃圆板、亮发丝边与层叠面板",
    },
    elevation: {
      kind: "glow",
      level: 2,
      shadow: { x: 0, y: 12, blur: 36, spread: 0, opacity: 0.2 },
    },
    whitespace: {
      density: "calm",
      margin: 120,
      gutter: 36,
      sectionGap: 48,
      cardPadding: 32,
      rhythm: "airy",
    },
    typography: {
      mood: "minimal",
      headingFamily: "sans",
      bodyFamily: "sans",
      dataFamily: "sans",
      headingWeight: 500,
      bodyWeight: 350,
      headingScale: 1.1,
      bodyScale: 1,
      tracking: 0.01,
      lineHeight: 1.45,
      character: "轻到中等字重的现代 sans，空气感强",
    },
    background: {
      style: "gradient",
      field: "dark",
      gradient: "luminous",
      pattern: "none",
      colorUsage: "颜色表现为流光、玻璃 tint 与少量霓虹焦点",
    },
    texture: { kind: "frosted-glass", opacity: 0.16 },
    imageRendering: "glassmorphism",
    imageTreatment: "framed",
    illustrationPropensity: "sparse",
    grammarPreferences: {
      motif: "arc",
      chartStyle: "dashboard",
      preferredVariants: ["signal-dark", "metric-focus", "centered-card"],
      avoid: ["editorial-columns"],
      composition: "偏轴英雄玻璃板、径向光晕、叠圆、玻璃环与深度阶梯",
    },
  },
  "dark-tech": {
    id: "dark-tech",
    label: "深色科技",
    summary: "暗色画布、发光强调与精确几何。",
    bestFor: ["科技", "AI", "开发工具", "数据产品"],
    shape: {
      language: "geometric",
      radius: 6,
      strokeWidth: 1,
      strokeStyle: "solid",
      decoration: "restrained",
      character: "精确几何、细发光线、六边形与电路节点",
    },
    elevation: {
      kind: "glow",
      level: 1,
      shadow: { x: 0, y: 0, blur: 20, spread: 0, opacity: 0.22 },
    },
    whitespace: {
      density: "standard",
      margin: 112,
      gutter: 32,
      sectionGap: 44,
      cardPadding: 24,
      rhythm: "airy",
    },
    typography: {
      mood: "technical",
      headingFamily: "sans",
      bodyFamily: "sans",
      dataFamily: "mono",
      headingWeight: 650,
      bodyWeight: 400,
      headingScale: 1.08,
      bodyScale: 1,
      tracking: 0.02,
      lineHeight: 1.4,
      character: "clean sans 正文搭配 monospace 标签、数字与代码",
    },
    background: {
      style: "dark",
      field: "dark",
      gradient: "subtle",
      pattern: "grid",
      colorUsage: "深色底；一到两个高对比发光强调点",
    },
    texture: { kind: "fine-grid", opacity: 0.12 },
    imageRendering: "digital-dashboard",
    imageTreatment: "masked",
    illustrationPropensity: "sparse",
    grammarPreferences: {
      motif: "path-line",
      chartStyle: "dashboard",
      preferredVariants: ["signal-dark", "path", "metric-focus"],
      avoid: ["editorial-pullquote"],
      composition: "斜向电路轨迹、同心轨道、节点簇、低透明巨字与括号框",
    },
  },
  blueprint: {
    id: "blueprint",
    label: "蓝图",
    summary: "暗色蓝图纸上的技术线稿、等距投影与工程注释。",
    bestFor: ["技术简报", "架构", "工程", "系统讲解"],
    shape: {
      language: "path",
      radius: 2,
      strokeWidth: 1,
      strokeStyle: "solid",
      decoration: "restrained",
      character: "单线宽 outline frame、等距结构与工程标注",
    },
    elevation: { kind: "flat", level: 0 },
    whitespace: {
      density: "standard",
      margin: 108,
      gutter: 32,
      sectionGap: 44,
      cardPadding: 20,
      rhythm: "balanced",
    },
    typography: {
      mood: "technical",
      headingFamily: "sans",
      bodyFamily: "sans",
      dataFamily: "mono",
      headingWeight: 600,
      bodyWeight: 400,
      headingScale: 1.02,
      bodyScale: 0.94,
      tracking: 0.035,
      lineHeight: 1.35,
      character: "clean sans 正文；组件、坐标与代码全部 monospace",
    },
    background: {
      style: "grid",
      field: "dark",
      gradient: "none",
      pattern: "grid",
      colorUsage: "暗纸面；单一线色统领；一个 spot accent 标关键路径",
    },
    texture: { kind: "fine-grid", opacity: 0.18 },
    imageRendering: "blueprint",
    imageTreatment: "plain",
    illustrationPropensity: "supportive",
    grammarPreferences: {
      motif: "path-line",
      chartStyle: "dashboard",
      preferredVariants: ["path", "evidence", "signal-dark"],
      avoid: ["cards"],
      composition: "整页注释图、leader line、细节放大、尺寸括号、爆炸堆栈与图签",
    },
  },
  editorial: {
    id: "editorial",
    label: "编辑出版",
    summary: "杂志级层级、栏目、细规则线与 serif/sans 对照。",
    bestFor: ["金融", "新闻", "研究", "长篇分析"],
    shape: {
      language: "editorial",
      radius: 2,
      strokeWidth: 1,
      strokeStyle: "solid",
      decoration: "restrained",
      character: "直线型栏目与细规则线，尽量不用卡片",
    },
    elevation: { kind: "flat", level: 0 },
    whitespace: {
      density: "standard",
      margin: 112,
      gutter: 32,
      sectionGap: 40,
      cardPadding: 20,
      rhythm: "balanced",
    },
    typography: {
      mood: "editorial",
      headingFamily: "serif",
      bodyFamily: "sans",
      dataFamily: "sans",
      headingWeight: 650,
      bodyWeight: 400,
      headingScale: 1.08,
      bodyScale: 1,
      tracking: 0,
      lineHeight: 1.5,
      character: "serif/sans 角色对照，kicker 到正文的强纵向层级",
    },
    background: {
      style: "clean",
      field: "light",
      gradient: "none",
      pattern: "none",
      colorUsage: "浅底近单色文字；一个强调色只标结构与重点",
    },
    texture: { kind: "none", opacity: 0 },
    imageRendering: "editorial",
    imageTreatment: "captioned",
    illustrationPropensity: "supportive",
    grammarPreferences: {
      motif: "margin-note",
      chartStyle: "editorial",
      preferredVariants: ["editorial-columns", "editorial-pullquote", "editorial-index"],
      avoid: ["cards"],
      composition: "drop cap、跨栏引语、全高竖线、2:1 非对称栏与越栏图片",
    },
  },
  "photo-editorial": {
    id: "photo-editorial",
    label: "摄影编辑",
    summary: "由全出血摄影主导，文字只做标题、指引与图注。",
    bestFor: ["建筑", "设计", "时尚", "文化"],
    shape: {
      language: "editorial",
      radius: 0,
      strokeWidth: 0,
      strokeStyle: "solid",
      decoration: "none",
      character: "全出血图片是骨架，文字以栏、图注或 overlay 附着",
    },
    elevation: { kind: "flat", level: 0 },
    whitespace: {
      density: "calm",
      margin: 116,
      gutter: 36,
      sectionGap: 48,
      cardPadding: 18,
      rhythm: "airy",
    },
    typography: {
      mood: "editorial",
      headingFamily: "serif",
      bodyFamily: "sans",
      dataFamily: "sans",
      headingWeight: 600,
      bodyWeight: 400,
      headingScale: 1.12,
      bodyScale: 0.96,
      tracking: 0,
      lineHeight: 1.5,
      character: "editorial serif 标题搭配 clean sans 正文与精确小图注",
    },
    background: {
      style: "clean",
      field: "adaptive",
      gradient: "subtle",
      pattern: "none",
      colorUsage: "摄影承担色彩；文字侧保持安静中性，仅留一个强调点",
    },
    texture: { kind: "none", opacity: 0 },
    imageRendering: "corporate-photo",
    imageTreatment: "plain",
    illustrationPropensity: "sparse",
    grammarPreferences: {
      motif: "margin-note",
      chartStyle: "editorial",
      preferredVariants: ["hero-caption", "filmstrip", "editorial-hero"],
      avoid: ["cards"],
      composition: "L 型文字区、标题跨图边、diptych/triptych 与跨边图注块",
    },
  },
  "data-journalism": {
    id: "data-journalism",
    label: "数据新闻",
    summary: "出版级密度、多栏微图表、边栏、英雄数字与来源线。",
    bestFor: ["金融", "市场复盘", "研究", "数据报告"],
    shape: {
      language: "editorial",
      radius: 0,
      strokeWidth: 1,
      strokeStyle: "solid",
      decoration: "restrained",
      character: "严谨多栏、hairline、inline 微图表、边栏与来源线",
    },
    elevation: { kind: "flat", level: 0 },
    whitespace: {
      density: "dense",
      margin: 92,
      gutter: 24,
      sectionGap: 30,
      cardPadding: 16,
      rhythm: "tight",
    },
    typography: {
      mood: "editorial",
      headingFamily: "serif",
      bodyFamily: "sans",
      dataFamily: "mono",
      headingWeight: 650,
      bodyWeight: 400,
      headingScale: 1.02,
      bodyScale: 0.9,
      tracking: 0,
      lineHeight: 1.35,
      character: "serif headline/hero number 搭配精确 sans/mono 数据字",
    },
    background: {
      style: "clean",
      field: "adaptive",
      gradient: "none",
      pattern: "none",
      colorUsage: "克制纸面或石墨底；颜色只编码风险、焦点与数据系列",
    },
    texture: { kind: "none", opacity: 0 },
    imageRendering: "editorial",
    imageTreatment: "captioned",
    illustrationPropensity: "sparse",
    grammarPreferences: {
      motif: "margin-note",
      chartStyle: "report",
      preferredVariants: ["metric-focus", "editorial-columns", "evidence"],
      avoid: ["centered-card"],
      composition: "图表作页面脊柱、满栏英雄数、spanner rule、切入边栏与 small multiples",
    },
  },
  brutalist: {
    id: "brutalist",
    label: "粗野主义",
    summary: "报纸式高密度、硬框、粗规则线与外露网格。",
    bestFor: ["年度回顾", "研究摘要", "宣言", "编辑型报告"],
    shape: {
      language: "editorial",
      radius: 0,
      strokeWidth: 3,
      strokeStyle: "solid",
      decoration: "expressive",
      character: "硬矩形、ruled boxes、粗边框与显式栏线",
    },
    elevation: { kind: "flat", level: 0 },
    whitespace: {
      density: "dense",
      margin: 72,
      gutter: 18,
      sectionGap: 24,
      cardPadding: 14,
      rhythm: "tight",
    },
    typography: {
      mood: "editorial",
      headingFamily: "sans",
      bodyFamily: "serif",
      dataFamily: "mono",
      headingWeight: 900,
      bodyWeight: 400,
      headingScale: 1.2,
      bodyScale: 0.86,
      tracking: -0.015,
      lineHeight: 1.25,
      character: "display-black 标题、serif 栏正文与 mono 数据的硬碰撞",
    },
    background: {
      style: "paper",
      field: "light",
      gradient: "none",
      pattern: "halftone",
      colorUsage: "纸白与墨黑占绝对主体；spot accent 只占画布几个百分点",
    },
    texture: { kind: "halftone", opacity: 0.1 },
    imageRendering: "screen-print",
    imageTreatment: "framed",
    illustrationPropensity: "supportive",
    grammarPreferences: {
      motif: "chapter-number",
      chartStyle: "report",
      preferredVariants: ["editorial-columns", "editorial-index", "evidence"],
      avoid: ["centered-card"],
      composition: "巨型 masthead 跨栏、单格反白、满出血规则条、一次旋转印章与混合栏宽",
    },
  },
  memphis: {
    id: "memphis",
    label: "孟菲斯",
    summary: "撞色几何、粗描边、confetti 与充满能量的不对称。",
    bestFor: ["节庆", "消费品牌", "年轻受众", "发布造势"],
    shape: {
      language: "geometric",
      radius: 8,
      strokeWidth: 3,
      strokeStyle: "solid",
      decoration: "expressive",
      character: "圆、三角、zigzag、squiggle 与 blob 的粗描边组合",
    },
    elevation: {
      kind: "hard-offset",
      level: 1,
      shadow: { x: 6, y: 6, blur: 0, spread: 0, opacity: 0.22 },
    },
    whitespace: {
      density: "standard",
      margin: 96,
      gutter: 28,
      sectionGap: 36,
      cardPadding: 22,
      rhythm: "balanced",
    },
    typography: {
      mood: "warm",
      headingFamily: "sans",
      bodyFamily: "sans",
      dataFamily: "sans",
      headingWeight: 850,
      bodyWeight: 450,
      headingScale: 1.18,
      bodyScale: 1,
      tracking: -0.01,
      lineHeight: 1.35,
      character: "重 display poster 标题搭配安静易读的 neutral sans 正文",
    },
    background: {
      style: "clean",
      field: "light",
      gradient: "none",
      pattern: "dots",
      colorUsage: "浅底承载每页两到三种撞色块，深描边把能量收束",
    },
    texture: { kind: "halftone", opacity: 0.08 },
    imageRendering: "flat",
    imageTreatment: "masked",
    illustrationPropensity: "core",
    grammarPreferences: {
      motif: "arc",
      chartStyle: "minimal",
      preferredVariants: ["band", "verdict", "statement-stack"],
      avoid: ["editorial-columns"],
      composition: "越界巨形、斜向双色切分、zigzag 分隔、角落 props 与单个旋转 frame",
    },
  },
  zine: {
    id: "zine",
    label: "小刊",
    summary: "Riso 错版、halftone、有限油墨与 DIY 拼贴。",
    bestFor: ["文化", "设计演讲", "独立品牌", "印刷感"],
    shape: {
      language: "annotation",
      radius: 0,
      strokeWidth: 2,
      strokeStyle: "solid",
      decoration: "expressive",
      character: "cut-and-paste 色块、错位形状、粗框与低圆角",
    },
    elevation: { kind: "flat", level: 0 },
    whitespace: {
      density: "standard",
      margin: 84,
      gutter: 22,
      sectionGap: 30,
      cardPadding: 18,
      rhythm: "balanced",
    },
    typography: {
      mood: "warm",
      headingFamily: "sans",
      bodyFamily: "sans",
      dataFamily: "mono",
      headingWeight: 900,
      bodyWeight: 400,
      headingScale: 1.16,
      bodyScale: 0.95,
      tracking: -0.01,
      lineHeight: 1.35,
      character: "heavy poster × plain sans × typewriter mono annotation",
    },
    background: {
      style: "paper",
      field: "light",
      gradient: "none",
      pattern: "halftone",
      colorUsage: "暖纸底上两层 spot ink 为主，第三色极少且只用平涂",
    },
    texture: { kind: "misregistration", opacity: 0.16 },
    imageRendering: "screen-print",
    imageTreatment: "framed",
    illustrationPropensity: "core",
    grammarPreferences: {
      motif: "margin-note",
      chartStyle: "editorial",
      preferredVariants: ["evidence-wall", "band", "editorial-index"],
      avoid: ["centered-card"],
      composition: "轻旋拼贴块、撕纸分隔、超大 halftone bleed、复印框与混宽 scraps",
    },
  },
  "vintage-poster": {
    id: "vintage-poster",
    label: "复古海报",
    summary: "中世纪平面海报、有限色块、halftone 与复古暖意。",
    bestFor: ["文化", "酒店餐饮", "品牌历史", "周年纪念"],
    shape: {
      language: "geometric",
      radius: 10,
      strokeWidth: 3,
      strokeStyle: "solid",
      decoration: "expressive",
      character: "圆润有机几何、偏轴叠块与粗手感线",
    },
    elevation: { kind: "flat", level: 0 },
    whitespace: {
      density: "calm",
      margin: 96,
      gutter: 30,
      sectionGap: 42,
      cardPadding: 20,
      rhythm: "airy",
    },
    typography: {
      mood: "warm",
      headingFamily: "sans",
      bodyFamily: "sans",
      dataFamily: "sans",
      headingWeight: 800,
      bodyWeight: 400,
      headingScale: 1.18,
      bodyScale: 0.98,
      tracking: -0.005,
      lineHeight: 1.4,
      character: "mid-century retro display 标题搭配简单易读正文",
    },
    background: {
      style: "paper",
      field: "light",
      gradient: "none",
      pattern: "halftone",
      colorUsage: "暖纸底与有限平面色块；主色占大块、accent 只标小形",
    },
    texture: { kind: "halftone", opacity: 0.12 },
    imageRendering: "vintage-poster",
    imageTreatment: "masked",
    illustrationPropensity: "core",
    grammarPreferences: {
      motif: "arc",
      chartStyle: "minimal",
      preferredVariants: ["band", "statement-stack", "hero-caption"],
      avoid: ["cards"],
      composition: "巨型太阳盘或拱形、射线楔、地平线带、偏轴叠块与单枚 badge",
    },
  },
  "paper-cut": {
    id: "paper-cut",
    label: "剪纸",
    summary: "不规则纸张切边、真实层叠与柔和纸面阴影。",
    bestFor: ["文化民俗", "儿童", "节庆", "可持续主题"],
    shape: {
      language: "geometric",
      radius: 6,
      strokeWidth: 0,
      strokeStyle: "solid",
      decoration: "expressive",
      character: "无 outline 的不规则 polygon/path 剪纸边缘",
    },
    elevation: {
      kind: "layered",
      level: 2,
      shadow: { x: 0, y: 7, blur: 16, spread: 0, opacity: 0.1 },
    },
    whitespace: {
      density: "calm",
      margin: 104,
      gutter: 30,
      sectionGap: 42,
      cardPadding: 24,
      rhythm: "airy",
    },
    typography: {
      mood: "warm",
      headingFamily: "sans",
      bodyFamily: "sans",
      dataFamily: "sans",
      headingWeight: 650,
      bodyWeight: 400,
      headingScale: 1.08,
      bodyScale: 1,
      tracking: 0,
      lineHeight: 1.45,
      character: "温暖、圆润、亲和的 sans，标题可置于剪纸 banner",
    },
    background: {
      style: "paper",
      field: "light",
      gradient: "none",
      pattern: "none",
      colorUsage: "每一种颜色都像一层纸：底纸、前景纸与顶层 accent",
    },
    texture: { kind: "paper-grain", opacity: 0.13 },
    imageRendering: "paper-cut",
    imageTreatment: "masked",
    illustrationPropensity: "core",
    grammarPreferences: {
      motif: "arc",
      chartStyle: "minimal",
      preferredVariants: ["steps", "hero-caption", "statement-stack"],
      avoid: ["editorial-columns"],
      composition: "层叠 wave sheets、die-cut window、cut disc、tabbed steps 与前景框",
    },
  },
  "sketch-notes": {
    id: "sketch-notes",
    label: "手绘笔记",
    summary: "暖纸、轻微摇摆线、柔和色块与友好 doodle。",
    bestFor: ["教育", "培训", "入职", "知识分享"],
    shape: {
      language: "annotation",
      radius: 10,
      strokeWidth: 2,
      strokeStyle: "solid",
      decoration: "expressive",
      character: "以非对齐 path 表现轻微 wobble 的圆润形与手绘图标",
    },
    elevation: { kind: "flat", level: 0 },
    whitespace: {
      density: "calm",
      margin: 112,
      gutter: 34,
      sectionGap: 48,
      cardPadding: 24,
      rhythm: "airy",
    },
    typography: {
      mood: "warm",
      headingFamily: "sans",
      bodyFamily: "sans",
      dataFamily: "sans",
      headingWeight: 700,
      bodyWeight: 400,
      headingScale: 1.08,
      bodyScale: 1.02,
      tracking: 0,
      lineHeight: 1.5,
      character: "友好手写感标题与清晰 humanist 正文",
    },
    background: {
      style: "paper",
      field: "light",
      gradient: "none",
      pattern: "none",
      colorUsage: "暖柔纸面；主题色转柔和 pastel tint，只留一个明确 accent",
    },
    texture: { kind: "paper-grain", opacity: 0.08 },
    imageRendering: "sketch-notes",
    imageTreatment: "captioned",
    illustrationPropensity: "core",
    grammarPreferences: {
      motif: "path-line",
      chartStyle: "minimal",
      preferredVariants: ["path", "closing-checklist", "evidence-wall"],
      avoid: ["signal-dark"],
      composition: "波浪箭头旅程、径向 mind-map、手绘 banner、编号圆与 dotted route",
    },
  },
  "ink-notes": {
    id: "ink-notes",
    label: "墨迹笔记",
    summary: "浅底上的专业手墨线、巨大留白与稀疏语义色。",
    bestFor: ["方法论", "前后对比", "宣言", "思维转变"],
    shape: {
      language: "annotation",
      radius: 2,
      strokeWidth: 2,
      strokeStyle: "solid",
      decoration: "restrained",
      character: "以 off-grid path/polyline 画手墨框、箭头、分隔与括号",
    },
    elevation: { kind: "flat", level: 0 },
    whitespace: {
      density: "calm",
      margin: 128,
      gutter: 40,
      sectionGap: 56,
      cardPadding: 20,
      rhythm: "vast",
    },
    typography: {
      mood: "warm",
      headingFamily: "sans",
      bodyFamily: "sans",
      dataFamily: "sans",
      headingWeight: 750,
      bodyWeight: 400,
      headingScale: 1.12,
      bodyScale: 1,
      tracking: 0,
      lineHeight: 1.48,
      character: "大胆略大的手写/humanist 标题搭配朴素 sans 正文",
    },
    background: {
      style: "clean",
      field: "light",
      gradient: "none",
      pattern: "none",
      colorUsage: "绝大多数为浅底深墨；accent 只承载语义且面积很小",
    },
    texture: { kind: "none", opacity: 0 },
    imageRendering: "ink-notes",
    imageTreatment: "plain",
    illustrationPropensity: "supportive",
    grammarPreferences: {
      motif: "margin-note",
      chartStyle: "minimal",
      preferredVariants: ["before-after", "closing-checklist", "statement-stack"],
      avoid: ["cards"],
      composition: "中心圈与分支、手绘 Venn、划掉重写、巨大括号与极少 doodle",
    },
  },
  chalkboard: {
    id: "chalkboard",
    label: "黑板",
    summary: "深色板面、粉笔线与柔和粉彩强调。",
    bestFor: ["教学", "教程", "课堂", "学术内容"],
    shape: {
      language: "annotation",
      radius: 3,
      strokeWidth: 2,
      strokeStyle: "dashed",
      decoration: "expressive",
      character: "扩散干粉笔触与以非对齐 path 绘制的框、括号和箭头",
    },
    elevation: { kind: "flat", level: 0 },
    whitespace: {
      density: "calm",
      margin: 116,
      gutter: 36,
      sectionGap: 48,
      cardPadding: 22,
      rhythm: "airy",
    },
    typography: {
      mood: "warm",
      headingFamily: "sans",
      bodyFamily: "sans",
      dataFamily: "sans",
      headingWeight: 700,
      bodyWeight: 400,
      headingScale: 1.1,
      bodyScale: 1,
      tracking: 0.01,
      lineHeight: 1.45,
      character: "手写粉笔标题搭配清晰可读正文",
    },
    background: {
      style: "dark",
      field: "dark",
      gradient: "none",
      pattern: "none",
      colorUsage: "深色板面由灰白粉笔承载，主题色只作粉状 pastel accent",
    },
    texture: { kind: "chalk-dust", opacity: 0.14 },
    imageRendering: "chalkboard",
    imageTreatment: "plain",
    illustrationPropensity: "core",
    grammarPreferences: {
      motif: "arc",
      chartStyle: "minimal",
      preferredVariants: ["path", "closing-checklist", "centered"],
      avoid: ["editorial-columns"],
      composition: "大粉笔圈、径向 mind-map、弧形时间线、巨大括号与角落 takeaway",
    },
  },
  "ink-wash": {
    id: "ink-wash",
    label: "水墨",
    summary: "宣纸般巨大留白、克制笔触与单枚印章强调。",
    bestFor: ["文化", "哲学", "品牌传承", "新中式"],
    shape: {
      language: "editorial",
      radius: 0,
      strokeWidth: 1,
      strokeStyle: "solid",
      decoration: "restrained",
      character: "少量不规则 brush path、hairline 与唯一硬边印章方块",
    },
    elevation: { kind: "flat", level: 0 },
    whitespace: {
      density: "calm",
      margin: 144,
      gutter: 44,
      sectionGap: 60,
      cardPadding: 18,
      rhythm: "vast",
    },
    typography: {
      mood: "editorial",
      headingFamily: "serif",
      bodyFamily: "sans",
      dataFamily: "sans",
      headingWeight: 500,
      bodyWeight: 350,
      headingScale: 1.16,
      bodyScale: 1,
      tracking: 0.02,
      lineHeight: 1.6,
      character: "brush/serif 标题与 clean sans 正文的 Kai × Hei 对照",
    },
    background: {
      style: "paper",
      field: "light",
      gradient: "none",
      pattern: "none",
      colorUsage: "浅宣纸、深墨与单个印章 accent，颜色极少",
    },
    texture: { kind: "ink-bleed", opacity: 0.07 },
    imageRendering: "watercolor",
    imageTreatment: "plain",
    illustrationPropensity: "supportive",
    grammarPreferences: {
      motif: "bookmark",
      chartStyle: "editorial",
      preferredVariants: ["editorial-hero", "statement-stack", "editorial-pullquote"],
      avoid: ["cards"],
      composition: "宽 brush 斜脊、开放 ensō、竖卷带、低水墨地平线与印章配重",
    },
  },
  "pixel-art": {
    id: "pixel-art",
    label: "像素风",
    summary: "严格像素网格、阶梯边缘、有限色槽与平面块。",
    bestFor: ["游戏", "复古科技", "怀旧", "游戏化内容"],
    shape: {
      language: "geometric",
      radius: 0,
      strokeWidth: 1,
      strokeStyle: "solid",
      decoration: "expressive",
      character: "对齐可见像素网格的 block、step edge 与一像素 outline",
    },
    elevation: { kind: "flat", level: 0 },
    whitespace: {
      density: "standard",
      margin: 96,
      gutter: 24,
      sectionGap: 32,
      cardPadding: 16,
      rhythm: "balanced",
    },
    typography: {
      mood: "technical",
      headingFamily: "mono",
      bodyFamily: "sans",
      dataFamily: "mono",
      headingWeight: 700,
      bodyWeight: 400,
      headingScale: 1.12,
      bodyScale: 0.98,
      tracking: 0,
      lineHeight: 1.35,
      character: "pixel/bitmap display 标题搭配正常可读正文",
    },
    background: {
      style: "grid",
      field: "adaptive",
      gradient: "none",
      pattern: "pixel",
      colorUsage: "固定色槽分别承担物体、地形、标记与深色 outline，只用平涂",
    },
    texture: { kind: "pixel-grid", opacity: 0.14 },
    imageRendering: "pixel-art",
    imageTreatment: "plain",
    illustrationPropensity: "core",
    grammarPreferences: {
      motif: "chapter-number",
      chartStyle: "dashboard",
      preferredVariants: ["steps", "metric-focus", "band"],
      avoid: ["editorial-columns"],
      composition: "像素阶梯分隔、巨型 sprite、HUD 角框、底部 tile band 与像素进度条",
    },
  },
};

export const VISUAL_STYLE_CATALOG: readonly VisualStyleDefinition[] = Object.freeze(
  Object.values(STYLES),
);

export interface ArgumentModeDefinition {
  id: ArgumentMode;
  label: string;
  narrativeSkeleton: string;
  titleVoice: "assertion" | "story-beat" | "teaching" | "evocative" | "topic";
  pageStructures: readonly string[];
  speakerNotesRegister: string;
  hardRules: readonly string[];
  antiPatterns: readonly string[];
  titleExamples: readonly {
    prefer: string;
    avoid: string;
  }[];
  pageSkeletons: readonly {
    id: string;
    useWhen: string;
    titlePattern: string;
    bodySequence: readonly string[];
  }[];
}

export const ARGUMENT_MODE_CATALOG: readonly ArgumentModeDefinition[] = [
  {
    id: "pyramid",
    label: "金字塔",
    narrativeSkeleton: "结论先行；SCQA 开场，MECE 证据支撑；数字必须带比较与 so-what。",
    titleVoice: "assertion",
    pageStructures: ["结论标题", "一句 takeaway", "MECE 证据", "来源"],
    speakerNotesRegister: "首句给结论，再用两到三个事实支撑；权威克制。",
    hardRules: [
      "正文页标题必须是一句可独立成立的结论，而不是主题标签。",
      "每页只回答一个决策问题，并让标题、takeaway 与证据指向同一结论。",
      "每个数字同时给出比较基准或变化，并明确它为何重要。",
      "拆解必须 MECE；若无法穷尽，显式保留“其他”而不是伪装完整。",
      "所有数据页保留可追溯来源。",
    ],
    antiPatterns: [
      "先展示分析过程，最后一页才给答案。",
      "使用“市场概览”“主要挑战”等无结论主题标题。",
      "孤立陈列 KPI，既无比较也无 so-what。",
      "用等权卡片堆放重叠、遗漏或粒度不一的论据。",
    ],
    titleExamples: [
      {
        prefer: "续费而非拉新，已成为增长主引擎",
        avoid: "增长概览",
      },
      {
        prefer: "三项结构性矛盾阻碍规模化部署",
        avoid: "主要挑战",
      },
    ],
    pageSkeletons: [
      {
        id: "analytical-proof",
        useWhen: "证明一个关键判断",
        titlePattern: "结论句：主语 + 变化/判断 + 业务含义",
        bodySequence: [
          "一句 takeaway，压缩结论与关键比较",
          "二至四个 MECE 论据",
          "每个论据附比较口径与 so-what",
          "页脚列来源",
        ],
      },
      {
        id: "recommendation",
        useWhen: "提出选择或行动方案",
        titlePattern: "推荐动作 + 预期结果",
        bodySequence: [
          "推荐方案与适用边界",
          "互斥的选择标准或支柱",
          "量化收益、风险与权衡",
          "明确下一步",
        ],
      },
    ],
  },
  {
    id: "narrative",
    label: "叙事",
    narrativeSkeleton: "situation → conflict → resolution；悬念、转折与兑现推动页面。",
    titleVoice: "story-beat",
    pageStructures: ["故事场景", "冲突", "转折", "兑现"],
    speakerNotesRegister: "对话式、有桥接；用修辞问句和具体人物建立悬念。",
    hardRules: [
      "整副与单页都要有场景、冲突、解决或通向解决的桥接。",
      "用具体人物、时刻或代价承载抽象观点。",
      "全篇至少安排一次真正改变理解的转折或重构。",
      "悬念页提出问题，后续页面必须兑现，不能只制造情绪。",
      "密集信息页与呼吸页交替，连续章节保持线索，章节之间改变节奏。",
    ],
    antiPatterns: [
      "按主题平铺事实，没有 stakes、turn 或 payoff。",
      "在同一页同时提出悬念并完整回答，失去跨页推动力。",
      "使用与内容无关的戏剧化图片或空泛隐喻。",
      "每页密度与构图完全相同，故事没有快慢。",
    ],
    titleExamples: [
      {
        prefer: "直到周五，交付链突然断裂",
        avoid: "交付问题",
      },
      {
        prefer: "真正的瓶颈，却不在产能",
        avoid: "根因分析",
      },
    ],
    pageSkeletons: [
      {
        id: "turn-and-payoff",
        useWhen: "制造并兑现关键转折",
        titlePattern: "转折页用故事节拍；兑现页用新的理解",
        bodySequence: [
          "转折页：一个场景视觉 + 一句冲突",
          "留出未回答的问题",
          "兑现页：重构判断 + 一个焦点证据",
          "桥接到下一行动或后果",
        ],
      },
      {
        id: "human-stake",
        useWhen: "让抽象问题具象化",
        titlePattern: "人物/团队 + 关键时刻或代价",
        bodySequence: [
          "具体人物与场景",
          "可感知的阻力或代价",
          "一项证据放大 stakes",
          "一句未完成的下一拍",
        ],
      },
    ],
  },
  {
    id: "instructional",
    label: "教学",
    narrativeSkeleton: "先分解再排序；一页一概念；show then tell；持续 signpost。",
    titleVoice: "teaching",
    pageStructures: ["具体例子", "规则", "渐进图", "下一步"],
    speakerNotesRegister: "耐心解释，先定义再使用，类比之后给原则。",
    hardRules: [
      "按简单到复杂、前置到依赖或概览到细节建立明确学习顺序。",
      "一页只教一个概念，标题明确这页学会什么。",
      "先展示具体例子或类比，再抽象出规则。",
      "同级概念使用相同结构与深度，便于比较和建立心智地图。",
      "每页标明已学内容与下一步，图示只高亮当前讲解部件。",
    ],
    antiPatterns: [
      "术语未经定义就直接使用。",
      "在一页堆叠多个无依赖关系的概念。",
      "把有顺序的过程做成无序等权卡片。",
      "只给抽象定义，没有例子、演示或练习。",
    ],
    titleExamples: [
      {
        prefer: "第 2 步：让每个令牌与查询评分",
        avoid: "注意力机制",
      },
      {
        prefer: "为什么先归一化，再比较概率",
        avoid: "归一化介绍",
      },
    ],
    pageSkeletons: [
      {
        id: "worked-example",
        useWhen: "解释抽象概念或规则",
        titlePattern: "步骤/问题 + 本页要掌握的动作",
        bodySequence: [
          "一个最小可运行例子",
          "标注例子中正在发生的动作",
          "从例子提炼一条规则",
          "一句下一步 signpost",
        ],
      },
      {
        id: "ordered-process",
        useWhen: "教授多步流程",
        titlePattern: "第 N 步：动作 + 对象",
        bodySequence: [
          "显示完整路径但弱化未讲步骤",
          "放大当前步骤",
          "给输入、操作与输出",
          "说明它如何成为下一步的前置",
        ],
      },
    ],
  },
  {
    id: "showcase",
    label: "展演",
    narrativeSkeleton: "图片或数字先行；build/release 节奏；一页一意；hold/reveal。",
    titleVoice: "evocative",
    pageStructures: ["全出血英雄图", "巨型数字", "短语", "大留白"],
    speakerNotesRegister: "短促、有能量；讲视觉周围的感受，不复述页面。",
    hardRules: [
      "每页只有一个主导视觉：英雄图、巨型数字或极短短语三选一。",
      "文字只支撑主视觉，一页只保留一个可在台上说清的 takeaway。",
      "用强页与安静页交替形成 build/release，而不是全程满强度。",
      "产品、结果或口号先 hold，后续单独 reveal。",
      "留白必须围绕焦点形成舞台，不用次要信息填满空处。",
    ],
    antiPatterns: [
      "主视觉旁放段落、列表和多个同级 KPI。",
      "同一页出现两个争夺注意力的英雄对象。",
      "每页都全出血、巨字和高饱和，导致没有高潮。",
      "用漂亮图片代替信息逻辑，图像与 takeaway 无因果关系。",
    ],
    titleExamples: [
      {
        prefer: "新标准，就此出现",
        avoid: "产品功能介绍",
      },
      {
        prefer: "10×",
        avoid: "性能提升数据",
      },
    ],
    pageSkeletons: [
      {
        id: "hero-reveal",
        useWhen: "发布产品、品牌或关键结果",
        titlePattern: "不超过一行的短语",
        bodySequence: [
          "一个全出血或孤立英雄对象",
          "一行 reveal 文案",
          "可选：一个极短限定语",
          "其余区域留白",
        ],
      },
      {
        id: "hero-proof",
        useWhen: "用一个数字证明上一页承诺",
        titlePattern: "巨型数字或极短结论",
        bodySequence: ["一个巨型数字", "一句比较口径", "一个支持性视觉线索", "不增加第二组证据"],
      },
    ],
  },
  {
    id: "briefing",
    label: "简报",
    narrativeSkeleton: "刻意不造 thesis；完整、平行、可扫描、可导航地陈列事实。",
    titleVoice: "topic",
    pageStructures: ["表格", "定义列表", "状态卡", "参考网格"],
    speakerNotesRegister: "平实、中性、完整；不造悬念、不反问、不强加 so-what。",
    hardRules: [
      "标题命名页面主题，不把中性资料强写成结论。",
      "core message 说明覆盖范围，而不是宣称证明了什么。",
      "保留受众查阅所需的完整集合，不只选择支持某观点的事实。",
      "同级项目使用相同权重、字段与视觉结构。",
      "按时间、类别或字母等稳定顺序分组，提供可预测导航。",
      "只有真实异常才获得强调，正常项保持均匀。",
    ],
    antiPatterns: [
      "为中性资料强造 thesis、冲突或故事转折。",
      "省略不支持某个结论但查阅时必要的信息。",
      "任意放大某项，制造并不存在的 punchline。",
      "同级页面频繁换布局，破坏扫描与定位。",
    ],
    titleExamples: [
      {
        prefer: "Q3 各工作流交付状态",
        avoid: "支付集成拖累整体进度",
      },
      {
        prefer: "支持的文件格式",
        avoid: "我们覆盖了所有关键格式",
      },
    ],
    pageSkeletons: [
      {
        id: "status-reference",
        useWhen: "汇报状态或交付清单",
        titlePattern: "时间/范围 + 对象 + 状态",
        bodySequence: [
          "稳定字段的状态表或列表",
          "同级行等权排列",
          "真实异常使用单一状态信号",
          "补充 owner、日期与定义",
        ],
      },
      {
        id: "catalog-reference",
        useWhen: "提供可查阅的分类、定义或 FAQ",
        titlePattern: "对象或问题主题",
        bodySequence: [
          "按稳定规则分组",
          "每项使用相同字段",
          "必要时提供索引或章节定位",
          "不附加虚构结论",
        ],
      },
    ],
  },
] as const;

export interface CompositionDiscipline {
  primaryStructure: readonly string[];
  decorationLayer: readonly string[];
  deckVariation: readonly string[];
}

/**
 * Applies to every SVG style. The style supplies the aesthetic moves; this
 * discipline keeps those moves from collapsing into a repeated card grid or
 * an unstructured pile of decoration.
 */
export const SVG_COMPOSITION_DISCIPLINE: CompositionDiscipline = {
  primaryStructure: [
    "每页先选一个承担阅读顺序的主结构：轴线、分区、路径、英雄对象或整页图。",
    "标题、证据与视觉都挂接到该主结构；避免再建立第二套竞争网格。",
    "先用少量大形与留白确定焦点，再放正文和细节。",
  ],
  decorationLayer: [
    "修饰只强化层级、节奏或连续性，不承担核心信息。",
    "每页最多一个主 motif；纹理、光效和图案保持在内容层之后。",
    "任何装饰若削弱文字对比、数据读取或焦点唯一性，直接删除。",
  ],
  deckVariation: [
    "保持字体、色彩角色、形状语言与 motif 一致，但改变页面的主结构。",
    "相邻页面避免重复同一等权卡片阵列；只有真实平行比较才使用同构布局。",
  ],
};

export interface ReadingModeDefinition {
  id: ReadingMode;
  label: string;
  bodySize: number;
  density: Density;
  spacingScale: number;
  typographyScale: number;
  maxBodyCharacters: number;
  visualBurden: "supporting" | "balanced" | "leading";
}

export const READING_MODE_CATALOG: readonly ReadingModeDefinition[] = [
  {
    id: "text",
    label: "文字型·近读",
    bodySize: 20,
    density: "dense",
    spacingScale: 0.84,
    typographyScale: 0.88,
    maxBodyCharacters: 900,
    visualBurden: "supporting",
  },
  {
    id: "balanced",
    label: "均衡·商务",
    bodySize: 24,
    density: "standard",
    spacingScale: 1,
    typographyScale: 1,
    maxBodyCharacters: 650,
    visualBurden: "balanced",
  },
  {
    id: "presentation",
    label: "展示型·演讲",
    bodySize: 32,
    density: "calm",
    spacingScale: 1.18,
    typographyScale: 1.2,
    maxBodyCharacters: 320,
    visualBurden: "leading",
  },
] as const;

export function getVisualStyleDefinition(style: VisualStyle): VisualStyleDefinition {
  return STYLES[style];
}

export function listVisualStyles(): readonly VisualStyleDefinition[] {
  return VISUAL_STYLE_CATALOG;
}

export function searchVisualStyles(query: string): readonly VisualStyleDefinition[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return VISUAL_STYLE_CATALOG;
  return VISUAL_STYLE_CATALOG.filter((style) => {
    const haystack = [
      style.id,
      style.label,
      style.summary,
      ...style.bestFor,
      style.shape.character,
      style.typography.character,
      style.grammarPreferences.composition,
    ]
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function getArgumentModeDefinition(mode: ArgumentMode): ArgumentModeDefinition {
  const definition = ARGUMENT_MODE_CATALOG.find((item) => item.id === mode);
  if (!definition) throw new Error(`Unknown argument mode: ${mode}`);
  return definition;
}

export function getReadingModeDefinition(mode: ReadingMode): ReadingModeDefinition {
  const definition = READING_MODE_CATALOG.find((item) => item.id === mode);
  if (!definition) throw new Error(`Unknown reading mode: ${mode}`);
  return definition;
}

function namedSchemeId(colorScheme: ColorScheme): DesignPalette {
  return typeof colorScheme === "string" ? colorScheme : "business-blue";
}

export function createLayoutTokens(
  style: VisualStyle,
  readingMode: ReadingMode,
  colorScheme: ColorScheme,
): DesignTokens {
  const definition = getVisualStyleDefinition(style);
  const reading = getReadingModeDefinition(readingMode);
  return {
    palette: namedSchemeId(colorScheme),
    fontMood: definition.typography.mood,
    shapeLanguage: definition.shape.language,
    backgroundStyle: definition.background.style,
    motif: definition.grammarPreferences.motif,
    density: readingMode === "balanced" ? definition.whitespace.density : reading.density,
    imageTreatment: definition.imageTreatment,
    chartStyle: definition.grammarPreferences.chartStyle,
  };
}
