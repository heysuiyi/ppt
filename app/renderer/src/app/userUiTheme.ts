import { CATNIP_UI_THEME_ID, DEFAULT_UI_THEME_ID } from "@shared/ui-themes";
import catnipThemeCss from "../styles/themes/catnip.css?raw";

export { normalizePersistedUiThemeId } from "@shared/ui-themes";

export const USER_UI_THEME_STYLE_ID = "user-ui-theme";

export function getBuiltinUiThemeCss(id: string): string | null | undefined {
  if (id === DEFAULT_UI_THEME_ID) return null;
  if (id === CATNIP_UI_THEME_ID) return catnipThemeCss;
  return undefined;
}

export function applyUserUiThemeCss(css: string | null): void {
  if (typeof document === "undefined") return;

  const existing = document.getElementById(USER_UI_THEME_STYLE_ID);
  if (!css) {
    existing?.remove();
    return;
  }

  let styleElement = existing instanceof HTMLStyleElement ? existing : null;
  if (!styleElement) {
    styleElement = document.createElement("style");
    styleElement.id = USER_UI_THEME_STYLE_ID;
    document.head.appendChild(styleElement);
  }
  styleElement.textContent = css;
}
