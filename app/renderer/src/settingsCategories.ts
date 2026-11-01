export type SettingsCategory =
  | "appearance"
  | "models"
  | "web-search"
  | "templates"
  | "agent"
  | "data"
  | "usage";

const LEGACY_SETTINGS_CATEGORY: Record<string, SettingsCategory> = {
  "models-list": "models",
  "models-search": "web-search",
  "models-runtime": "models",
  "preferences-presentation": "templates",
  "preferences-storage": "data",
  "preferences-appearance": "appearance",
  "agent-approval": "agent",
  "agent-limits": "agent",
  "agent-logs": "data",
  "usage-overview": "usage",
};

const SETTINGS_CATEGORIES = new Set<SettingsCategory>([
  "appearance",
  "models",
  "web-search",
  "templates",
  "agent",
  "data",
  "usage",
]);

export function normalizeSettingsCategory(value: unknown): SettingsCategory {
  if (typeof value === "string") {
    if (SETTINGS_CATEGORIES.has(value as SettingsCategory)) {
      return value as SettingsCategory;
    }
    const mapped = LEGACY_SETTINGS_CATEGORY[value];
    if (mapped) return mapped;
  }
  return "models";
}
