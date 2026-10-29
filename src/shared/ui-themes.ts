export const DEFAULT_UI_THEME_ID = "studio";
export const CATNIP_UI_THEME_ID = "catnip";

export interface BuiltinUiTheme {
  id: string;
  name: string;
}

export const BUILTIN_UI_THEMES: readonly BuiltinUiTheme[] = [
  { id: DEFAULT_UI_THEME_ID, name: "Studio" },
  { id: CATNIP_UI_THEME_ID, name: "Catnip 猫娘" },
];

export const BUILTIN_UI_THEME_IDS = new Set(BUILTIN_UI_THEMES.map((theme) => theme.id));

export function normalizePersistedUiThemeId(
  value: unknown,
  availableThemeIds: ReadonlySet<string> = new Set(),
): string {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_UI_THEME_ID;
  const id = value.trim();
  if (BUILTIN_UI_THEME_IDS.has(id)) return id;
  if (availableThemeIds.size === 0) return id;
  return availableThemeIds.has(id) ? id : DEFAULT_UI_THEME_ID;
}
