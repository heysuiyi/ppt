import type { UiThemeSummary } from "@app/shared/ipc";
import { BUILTIN_UI_THEMES, DEFAULT_UI_THEME_ID } from "@shared/ui-themes";
import type React from "react";
import {
  MAX_UI_FONT_SIZE,
  MAX_UI_LINE_HEIGHT,
  MIN_UI_FONT_SIZE,
  MIN_UI_LINE_HEIGHT,
  normalizePersistedUiFontSize,
  normalizePersistedUiLineHeight,
  type UiFontFamily,
} from "../../app/uiTypography";
import { Button } from "../Button";
import { Input } from "../Field";
import { MoonIcon, PaletteIcon, SunIcon } from "../Icons";
import {
  SettingsChoiceGroup,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
} from "./SettingsPrimitives";
import { useCommittedNumberDraft } from "./useCommittedNumberDraft";

export type UiColorScheme = "light" | "dark" | "system";

const fontFamilyOptions: Array<{ value: UiFontFamily; label: string }> = [
  { value: "system", label: "系统默认" },
  { value: "yahei", label: "微软雅黑" },
  { value: "pingfang", label: "苹方" },
  { value: "segoe", label: "Segoe UI" },
];

const colorSchemeOptions: Array<{
  value: UiColorScheme;
  label: string;
  icon: React.ReactNode;
}> = [
  { value: "dark", label: "暗色", icon: <MoonIcon size={13} /> },
  { value: "light", label: "浅色", icon: <SunIcon size={13} /> },
  { value: "system", label: "跟随系统", icon: <PaletteIcon size={13} /> },
];

export function AppearanceSettingsPanel({
  colorScheme,
  setColorScheme,
  uiThemeId,
  setUiThemeId,
  uiThemes,
  onRefreshUiThemes,
  onOpenUiThemesDirectory,
  uiFontFamily,
  setUiFontFamily,
  uiFontSize,
  setUiFontSize,
  uiLineHeight,
  setUiLineHeight,
}: {
  colorScheme: UiColorScheme;
  setColorScheme: (value: UiColorScheme) => void;
  uiThemeId: string;
  setUiThemeId: (value: string) => void;
  uiThemes: UiThemeSummary[];
  onRefreshUiThemes: () => void;
  onOpenUiThemesDirectory: () => void;
  uiFontFamily: UiFontFamily;
  setUiFontFamily: (value: UiFontFamily) => void;
  uiFontSize: number;
  setUiFontSize: (value: number) => void;
  uiLineHeight: number;
  setUiLineHeight: (value: number) => void;
}) {
  const {
    draft: fontSizeDraft,
    setDraft: setFontSizeDraft,
    commit: commitFontSize,
  } = useCommittedNumberDraft(uiFontSize, setUiFontSize, normalizePersistedUiFontSize);
  const {
    draft: lineHeightDraft,
    setDraft: setLineHeightDraft,
    commit: commitLineHeight,
  } = useCommittedNumberDraft(uiLineHeight, setUiLineHeight, normalizePersistedUiLineHeight);

  const themeOptions = [
    ...BUILTIN_UI_THEMES.map((theme) => ({ value: theme.id, label: theme.name })),
    ...uiThemes.map((theme) => ({ value: theme.id, label: theme.name })),
  ];
  const selectedThemeLabel =
    themeOptions.find((option) => option.value === uiThemeId)?.label ??
    (uiThemeId === DEFAULT_UI_THEME_ID ? "Studio" : uiThemeId);
  const selectedSchemeLabel =
    colorSchemeOptions.find((option) => option.value === colorScheme)?.label ?? "暗色";
  const selectedFontFamilyLabel =
    fontFamilyOptions.find((option) => option.value === uiFontFamily)?.label ?? "系统默认";

  return (
    <SettingsPanel>
      <p className="settings-hint">只改变软件自身皮肤与控件，不影响导出的演示文档。</p>
      <SettingsSection title="皮肤" hint={selectedThemeLabel}>
        <SettingsRow label="设计语言">
          <SettingsChoiceGroup
            label="皮肤"
            value={uiThemeId}
            options={themeOptions}
            onChange={setUiThemeId}
          />
        </SettingsRow>
        <SettingsRow label="主题根目录">
          <div className="settings-choice-group" role="group" aria-label="主题根目录操作">
            <Button size="sm" onClick={onOpenUiThemesDirectory}>
              <span>打开主题根目录</span>
            </Button>
            <Button size="sm" onClick={onRefreshUiThemes}>
              <span>刷新列表</span>
            </Button>
          </div>
        </SettingsRow>
        <p className="settings-hint">
          在固定目录 <code>themes/&lt;主题名&gt;/theme.css</code>{" "}
          放置主题后刷新列表即可切换。推荐覆盖 semantic token；深度定制可用{" "}
          <code>data-ui-region</code>。
        </p>
      </SettingsSection>
      <SettingsSection title="明暗" hint={selectedSchemeLabel}>
        <SettingsRow label="配色方案">
          <SettingsChoiceGroup
            label="配色方案"
            value={colorScheme}
            options={colorSchemeOptions}
            onChange={setColorScheme}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="字体" hint={selectedFontFamilyLabel}>
        <SettingsRow label="界面字体">
          <SettingsChoiceGroup
            label="界面字体"
            value={uiFontFamily}
            options={fontFamilyOptions}
            onChange={setUiFontFamily}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="字号" hint={`${uiFontSize}px · 行高 ${uiLineHeight}`}>
        <SettingsRow label="基准字号（px）">
          <Input
            className="settings-field"
            type="number"
            min={MIN_UI_FONT_SIZE}
            max={MAX_UI_FONT_SIZE}
            step={0.5}
            value={fontSizeDraft}
            aria-label="基准字号"
            onChange={(event) => setFontSizeDraft(event.target.value)}
            onBlur={commitFontSize}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </SettingsRow>
        <SettingsRow label="行高（倍）">
          <Input
            className="settings-field"
            type="number"
            min={MIN_UI_LINE_HEIGHT}
            max={MAX_UI_LINE_HEIGHT}
            step={0.1}
            value={lineHeightDraft}
            aria-label="行高"
            onChange={(event) => setLineHeightDraft(event.target.value)}
            onBlur={commitLineHeight}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </SettingsRow>
        <p className="settings-hint">
          基准字号对应正文（默认 13px）；其余字号阶梯按同比例缩放。行高是相对字号的倍数。
        </p>
      </SettingsSection>
      <p className="settings-hint">
        当前：{selectedThemeLabel} · {selectedSchemeLabel} · {selectedFontFamilyLabel} ·{" "}
        {uiFontSize}px / {uiLineHeight}
      </p>
    </SettingsPanel>
  );
}
