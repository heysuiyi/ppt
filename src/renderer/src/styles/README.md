# Renderer Styles

`../styles.css` is the ordered stylesheet entry. Workbench appearance is independent of `src/design-system/`, SVG paper and PPTX content.

Research: [工作台 Token 体系调研与新版建议](./token-system-review.md). Implementation design and acceptance matrix: [三风格主题优化与渐进接入方案](./token-system-plan.md). Those documents retain historical findings; this file describes the current consumption contract.

## Layers and ownership

| Layer | Source | Responsibility |
| --- | --- | --- |
| Private primitives | `tokens/primitives.css` | Color ramps; modules must not consume `--raw-*` |
| Typography defaults | `src/shared/ui-typography.ts` → `app/uiTypography.ts` | Single size/leading ladder, installed before first render as a low-priority stylesheet |
| Typography roles | `tokens/typography.css` | Weights, body/label/heading roles and tracking |
| Motion | `tokens/motion.css` | Durations, easing and property-specific transitions |
| Semantic | `tokens/semantic.css` | Surfaces, text, borders, actions, links, status, elevation, scrim, stacking and scrollbar |
| Geometry | `tokens/geometry.css` | Finite spacing scale, shape roles and shared control/layout sizes |
| Studio recipe | `tokens/skins/studio.css` | Explicit dark/light palette; no legacy accent/shape switches |
| Fonts | `tokens/fonts.css` | System UI stacks, mono and retained presentation font resources |
| Settings layout | `tokens/settings-density.css` | Settings typography, row minimum, page padding, label/content widths; not a global density mode |
| Components | `components/` | Switch, Select, loading, run status and shared resize affordance |
| Regions | `modules/` | Area layout and consumer-specific recipes |
| Catnip | `themes/catnip.css` | Both palettes, shape identity and private decoration |

Modules consume semantic, geometry and typography roles. Component-only geometry stays local: switch thumb/track and loading rings are not global theme promises. Keep dynamic measurements, responsive grid rules and optical offsets in the owning component/region.

## Theme runtime and cascade

`useAppearanceRuntime` applies `data-skin="studio"`, `data-color-scheme="light|dark"` and native `colorScheme`. Built-in theme IDs remain `studio` and `catnip`; Catnip is an additional stylesheet, not another `UiSkin`. Light/dark share geometry within each theme.

Do not use `.dark-theme` or UI-level `[data-theme]`. Presentation template `data-theme` values are a separate content axis.

Default typography is installed in `<style id="ui-typography-defaults">` before other styles. A theme can override that stylesheet; explicit user font/size/leading settings use root inline variables. Returning to defaults removes inline overrides so the active theme takes over again. Do not copy the size ladder into CSS or change every dark-mode weight.

Custom themes live in `{applicationDataRoot}/themes/<id>/theme.css`, normally `~/.agent-ppt/themes/<id>/theme.css`. Settings lists Studio, bundled Catnip and discovered folders. Catnip and custom CSS use one `<style id="user-ui-theme">`; switching to Studio removes it. Existing custom CSS remains unrestricted, not token-only.

Override palettes using selectors with the same specificity as Studio:

```css
:root[data-skin][data-color-scheme="dark"] {
  --accent-primary: #38bdf8;
  --accent-action-bg: #0369a1;
  --text-on-accent: #ffffff;
  --accent-link-text: #38bdf8;
  --border-focused: #38bdf8;
}
```

A plain `:root[data-color-scheme="dark"]` loses to the built-in skin. An unrestricted user stylesheet can still use `!important`; do not claim the inline preference mechanism overrides such declarations.

Region hooks: `[data-ui-region="sidebar|composer|canvas|settings"]` (use one actual value, not a literal pipe-separated selector). Class names are implementation details. Relative theme asset URLs and same-ID CSS hot reload are not supported; refreshing the list is not a reload. Built-in folder IDs `studio` and `catnip` are reserved.

Native caption buttons/background follow the existing main-process light/dark recipe, not custom CSS palette. Panel widths, resize hit targets, caption safety insets and live positioning are not theme parameters.

## Token catalog

| Family | Consumer rules |
| --- | --- |
| `--surface-canvas/base/raised/sunken/overlay` | Window, chrome, work area, inset controls and elevated content. Dark elevation is not a demand to make inset inputs black. |
| `--surface-hover/active` | State layers; account for the actual underlying surface when checking contrast. |
| `--text-primary/secondary/muted` | Readable hierarchy; muted is not an exemption from contrast requirements. |
| `--accent-primary` / glow | Identity and decoration, not an automatic solid-button color. |
| `--accent-action-bg/hover-bg/active-bg` + `--text-on-accent` | Solid primary actions; keep the foreground/background pairing valid in all states. |
| `--accent-link-text` | Readable text links and text-style emphasis. |
| `--accent-selected-bg/border/text` | Persistent selection, distinct from hover and keyboard active item. |
| `--border-focused` | Visible focus recipe; shared outline is 2px with 2px offset. |
| `--danger/success/warning` + glow/border | Status text/icons and subtle state treatment, not arbitrary solid fills with white text. |
| `--elevation-1/2/3`, `--modal-backdrop` | Depth and scrim; do not use unregistered shadow/surface synonyms. |
| `--scrollbar-thumb-color/hover-color` | Shared scrollbar appearance; no local hard-coded black/white theme branches. |
| `--field/button/card/panel/popover-border-radius` | Shape by role. `--workbench-border-radius` owns the workbench outer surface. |
| `--control-radius-xs/sm/md/lg/xl/pill` | Existing size-family consumers; direct base-radius mapping, no global scale multiplication. |
| `--space-1/2/3/4/5/6/8` | Stable 4/8/12/16/20/24/32px scale. Structure values such as 0, auto and percentages do not need tokens. |
| `--control-height-sm/md` | 28/32px minimum, not fixed text clipping heights. |
| `--control-padding-inline`, `--control-gap` | 8px standard control inset and icon/text relationship. |
| `--card-padding` | 16px standard card inset; compact or domain-specific variants remain explicit. |
| `--layout-gap-compact/default`, `--section-gap` | 8/16px parent-owned stack gap and 24px group separation. Cards do not accumulate external margins. |
| `--text-2xs` … `--text-2xl`, matching `-lh` | Paired size/leading, scaled by user typography. Tiny metadata is not body/error text. |
| `--type-body/label/heading-weight` | Regular/Medium/Semibold role mapping. Stable weight constants remain 400/500/600/700. |

Do not introduce a global density multiplier. Studio field/button/card/panel/popover radii are 6/8/12/16/8px; Catnip uses 9/13/18/24/13px. Circles, pill shapes, asymmetric message bubbles and component optical offsets retain their geometry.

## Shared states and accessibility

- Preserve selected/checked state separately from hover, pressed and keyboard active state.
- Keep focus-visible for independent buttons. Composer may use an outer focus-within recipe for its frameless textarea, not blanket outline removal on all descendants.
- Disabled controls block actions; read-only content remains readable/selectable. Avoid applying low opacity to whole groups of informational text.
- Loading preserves labels and dimensions. Errors and status need text/icon/structure, not color alone.
- Normal readable text, including placeholders, targets at least 4.5:1; qualifying large text uses 3:1. Check composited state backgrounds, not only base palette values. Thin strokes can be hard to read despite nominal contrast.
- Reduced motion disables nonessential transitions and decoration through the owning recipe while preserving understandable state. Prefer property-specific transitions; never `transition: all`.
- Do not force `-webkit-font-smoothing` to simulate thinner dark text. Actual platform fonts and CJK fallbacks need actual rendering checks.

## Content and layout boundaries

PPT white paper, SVG author colors, template palette swatches, aspect ratios, progress percentages and measured positions remain content/behavior facts. Preview modal headers, toolbars, close controls and canvas around the paper are workbench UI and must follow the theme. Do not filter or recolor slide content.

`review-surfaces.css` owns shared review-card chrome; approval/artifact modules own their content layouts. Do not reintroduce competing card surfaces into both layers. Prefer existing `SettingsPrimitives` and `Select` over new page-specific clones.

Local stacking context numbers are not global overlay levels. Body-portaled menus inherit root theme tokens; modal/fullscreen interactions require actual hit-testing, not raising every z-index.

## Migration notes

- Removed obsolete internal `BUILTIN_UI_THEME_ID`; import `DEFAULT_UI_THEME_ID` from shared UI themes. Persisted IDs are unchanged.
- Removed inactive `data-accent` / `data-control-shape` branches and radius scale variables. Custom themes should assign role radii and accent roles directly.
- Removed `--accent-primary-contrast` in favor of `--text-on-accent`; solid actions use the new action background role.
- Removed undefined `--surface-elevated` / `--shadow-popover` references and old `--main-radius`; use overlay/elevation/workbench roles.
- Removed unused `--settings-gap/control-height/radius/section-pad`, `--letter-normal`, `--font-serif` and private `--raw-neutral-1000`. Font resources for presentation content remain.
- Existing external themes that only override `--accent-primary` should also set action/link/on-accent roles when they customize those surfaces. No hidden compatibility aliases are installed.

## Modules and naming

`base/layout` own shell; `sidebar/project-files` navigation; `chat-*` conversation/process/team; `unified-input` Composer; `canvas-*` preview chrome; `settings-*` settings; `review-*` approval/artifact layouts and shared surfaces; `overlays-*` overlays; feature modules own remaining domain layout.

Use region prefixes (`chat-`, `settings-`, `mirror-`), `is-*` state and `--` variants. Split files by ownership when needed, preserving cascade order; do not split merely to increase file count.
