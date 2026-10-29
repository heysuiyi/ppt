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
| Components | `components/` | Button, field, Switch, Select, Menu, Dialog, artifact and preview recipes; loading, run status and resize affordances |
| Regions | `modules/` | Area layout and consumer-specific recipes |
| Catnip | `themes/catnip.css` | Both palettes, shape identity and private decoration |

Modules consume semantic, geometry and typography roles. Component-only geometry stays local: switch thumb/track and loading rings are not global theme promises. Keep dynamic measurements, responsive grid rules and optical offsets in the owning component/region.

### Shared component ownership

- `Button` / `IconButton` own native button behavior and primary/secondary/quiet/danger recipes; `type` defaults to `button`. Regions own placement and width, not another copy of hover/disabled/selected styles. `aria-pressed`, `aria-selected` and `aria-current="page"` preserve selection independently of hover.
- `Input` / `Textarea` own field chrome and forward native props/ref. `Switch` keeps the native checkbox and shared switch recipe. Numeric parsing and persistence stay with consumers; `useCommittedNumberDraft` shares only draft synchronization and commit lifecycle.
- `SettingsRow` labels recognized controls using their actual IDs; composite controls receive a labelled group. `SettingsChoiceGroup` represents pressed choices, while usage tabs retain tab semantics. `RangeField` owns value output plus slider structure; consumers choose immediate or end-of-interaction persistence.
- `Select` is the shared single-choice implementation, including the compact Composer model selector. `Menu` serves action menus; slash completion remains a listbox attached to the Composer input. They share viewport positioning and overlay ownership, not business selection semantics.
- `Dialog` owns modal lifecycle, dynamic focus boundaries, background inertness, scroll locking and focus return. Only the top layer handles Escape. Select/Menu portals mount inside their owning dialog; regions supply panel dimensions and optional keyboard actions. The attached permission gate is an inline region, not a modal.
- `ArtifactCard`, `CardHeader` and `CardActions` own artifact structure. Parent `.card-stack` owns separation, including Catnip decoration clearance. Approval and patch state machines remain independent.
- `SlidePreviewSurface` owns SVG image/placeholder rendering; preview navigation is shared. PNG inspection screenshots keep their cover behavior. Slide paper, author colors and viewport sizing remain content/layout facts.
- Presentation export has one application-layer action and busy state. Chat messages and mirror notifications are separate result consumers; neither the Button nor preview surface owns export IPC.

Built-in themes target `[data-ui-button][data-variant]`, `[data-ui-field]`, `[data-ui-switch]`, `[data-ui-menu]` and `[data-ui-dialog]`. `[data-theme-emphasis="primary"]` explicitly preserves Catnip emphasis for actions that remain neutral in Studio. It does not change business meaning. Fullscreen slideshow panels are excluded from Catnip dialog chrome.

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
| `--surface-canvas/base/raised/sunken/overlay` | Window, chrome, work area, inset controls and elevated content; roles, not a monotonic lightness ladder. Light chrome is darker than the work area; dark chrome is lighter. |
| `--surface-hover/active` | State layers; account for the actual underlying surface when checking contrast. |
| `--text-primary/secondary/muted` | Readable hierarchy; muted is not an exemption from contrast requirements. |
| `--accent-primary` / glow | Identity and decoration, not an automatic solid-button color. |
| `--accent-action-bg/hover-bg/active-bg` + `--text-on-accent` | Solid primary actions; keep the foreground/background pairing valid in all states. |
| `--accent-link-text` | Readable text links and text-style emphasis. |
| `--accent-selected-bg/border/text` | Persistent selection, distinct from hover and keyboard active item. |
| `--border-focused` | Shared control outline is 2px with 2px offset; Composer instead uses its neutral inset-ring recipe. |
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
- Keep focus-visible for independent buttons. Composer uses a focus-within outer shadow plus a 1px inset ring mixed from 55% primary text; no accent glow or second outline. Forced colors restores a system Highlight outline. Do not remove descendant button outlines.
- Disabled controls block actions; read-only content remains readable/selectable. Avoid applying low opacity to whole groups of informational text.
- Loading preserves labels and dimensions. Errors and status need text/icon/structure, not color alone.
- Normal readable text, including placeholders, targets at least 4.5:1; qualifying large text uses 3:1. Check composited state backgrounds, not only base palette values. Thin strokes can be hard to read despite nominal contrast.
- Reduced motion disables nonessential transitions and decoration through the owning recipe while preserving understandable state. Prefer property-specific transitions; never `transition: all`.
- Do not force `-webkit-font-smoothing` to simulate thinner dark text. Actual platform fonts and CJK fallbacks need actual rendering checks.

## Content and layout boundaries

PPT white paper, SVG author colors, template palette swatches, aspect ratios, progress percentages and measured positions remain content/behavior facts. Preview modal headers, toolbars, close controls and canvas around the paper are workbench UI and must follow the theme. Do not filter or recolor slide content.

`components/artifact-card.css` owns artifact chrome; `review-surfaces.css` owns decision/resolved chrome, and approval/artifact modules own their domain content layouts. Shared preview chrome lives in `components/preview.css`. Do not duplicate these recipes in regional modules; reuse `SettingsPrimitives`, fields and `Select`.

Local stacking context numbers are not global overlay levels. Body-portaled menus inherit root theme tokens; modal/fullscreen interactions require actual hit-testing, not raising every z-index.

## Tonal hierarchy refinement (2026-10-29)

Surface roles supersede the earlier plan's fixed surface palettes. Studio uses `#232323` chrome / `#1c1c1c` work area in dark mode and `#edeef0` / `#f5f6f7` in light mode. Catnip retains violet/rose identity with `#2a2232` / `#231b2b` and `#f5edf2` / `#fcf5fa`. Adjacent opaque surface steps differ by roughly 1–3 percentage points per sRGB channel; this is not a text/focus contrast target.

The example theme follows the same dark chrome/work-area direction: `--surface-base: #1b222c` for the shared left/outer background, `--surface-raised: #151b22` for the entire right work area. Its previous two values were reversed. Both the seed recipe in `src/main/ui-themes.ts` and the installed local example CSS were corrected; light values and other color roles were left intact. Existing user theme files are still never overwritten automatically. An already-loaded external theme must be reselected (Studio → example) or the application restarted to read file changes. Verified using the real theme switch in appearance settings and the conversation screen; the right work area rendered darker, and the example light backgrounds remained `#e7ecf2` / `#f7f9fc`.

The workbench outer edge is tonal rather than stroked. Studio separators use 2.5% / 5.5% neutral alpha; stronger functional boundaries remain separate. Sidebar selection locally uses a 6% primary-text state layer and neutral text instead of an accent outline. Native Studio caption backgrounds match chrome.

Background ownership is shared, not per-column: `.app-shell` alone paints `--surface-base` across the window. Titlebar, workspace grid and sidebar slot are transparent; `.left-panel` also stays transparent. `.rounded-canvas` independently paints opaque `--surface-raised`, including its settings/chat descendants. `--surface-canvas` remains the body/first-paint fallback. A theme should override these tokens, not replace region backgrounds with transparent gradients.

Settings functional cards use mode-specific tonal hierarchy: light mode retains the equal mix of `--surface-raised` and `--surface-overlay`; dark mode shades `--surface-raised` with 20% black so functional blocks are darker than their backdrop. Do not reuse window chrome (`--surface-base`) here: custom palettes can reverse the intended direction. This section recipe does not set shell/work-area palette values.

Verified via actual keyboard-operated appearance controls in Studio, Catnip and example: all dark-mode settings sections rendered darker than the work-area backdrop, while all light-mode section colors matched the preceding light recipe. The corrected example dark screen was visually inspected.

Catnip previously combined a shell gradient with an opaque sidebar slot, then replaced the right canvas fill with a transparent gradient and added a separate settings gradient. Its sidebar border, shadow and backdrop filter amplified the seams. Those structural overrides and unused shell decoration tokens were removed; component-local decoration remains. Theme loading in `useAppearanceRuntime` is unchanged: it installs CSS and mode attributes, not per-column colors.

Composer owns private `--composer-shadow` / `--composer-shadow-focus` recipes in `unified-input.css`; Catnip reuses them rather than adding a second halo. Focus deepens both outer elevation and the neutral inset ring. Buttons retain independent keyboard outlines.

Verification: Electron conversation screenshots inspected in Studio/Catnip dark/light; editing enables send without submitting, and Tab reaches the model selector with a visible independent outline. The focused inset ring over each opaque input background computes above 3:1; Catnip decorative gradients are not included in that numerical check. The 16 composer/native-theme/theme tests and `npm run typecheck` passed. Forced-color styling is implemented but has not been visually exercised.

Background continuity follow-up: exercised the real appearance controls to switch Catnip light/dark, inspected both conversation and appearance-settings screens, and checked computed paint ownership. Chrome children were transparent with no background images; sidebar shadow/backdrop filter were absent; both right-side screens had opaque work-area fills. Switching back to Studio light/dark retained the same hierarchy and removed Catnip CSS. Original Studio/dark preferences were restored and saved; renderer reported no page errors. Screenshot checks settled finite CSS transitions before inspection.

References: [Material 3 tone-based surfaces](https://m3.material.io/blog/tone-based-surface-color-m3), [W3C Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html).

## Migration notes

- Removed obsolete internal `BUILTIN_UI_THEME_ID`; import `DEFAULT_UI_THEME_ID` from shared UI themes. Persisted IDs are unchanged.
- Removed inactive `data-accent` / `data-control-shape` branches and radius scale variables. Custom themes should assign role radii and accent roles directly.
- Removed `--accent-primary-contrast` in favor of `--text-on-accent`; solid actions use the new action background role.
- Removed undefined `--surface-elevated` / `--shadow-popover` references and old `--main-radius`; use overlay/elevation/workbench roles.
- Removed unused `--settings-gap/control-height/radius/section-pad`, `--letter-normal`, `--font-serif` and private `--raw-neutral-1000`. Font resources for presentation content remain.
- Existing external themes that only override `--accent-primary` should also set action/link/on-accent roles when they customize those surfaces. No hidden compatibility aliases are installed.
- Removed duplicated settings/model/review button and field recipes, the Composer `model-tier-*` selector, old `inline-artifact-*` card shell, and the custom context-menu stylesheet. Migrate internal consumers and built-in theme hooks together; no legacy class aliases are retained.
- Preview dialogs share overlay lifecycle; SVG previews share one surface. Card spacing belongs to parent stacks rather than card margins. Dynamic positioning, percentages, typography measurement and SVG paper colors remain legitimate local styles.

## Modules and naming

`base/layout` own shell; `sidebar/project-files` navigation; `chat-*` conversation/process/team; `unified-input` Composer; `canvas-*` preview chrome; `settings-*` settings; `review-*` approval/artifact layouts and shared surfaces; `overlays-*` overlays; feature modules own remaining domain layout.

Use region prefixes (`chat-`, `settings-`, `mirror-`), `is-*` state and `--` variants. Split files by ownership when needed, preserving cascade order; do not split merely to increase file count.
