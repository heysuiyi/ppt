import type { SettingsCategory } from "../settingsCategories";

export type WorkspacePage = "chat" | "files";
export type AppLocation =
  | { area: "workspace"; page: WorkspacePage }
  | { area: "settings"; category: SettingsCategory; returnTo: WorkspacePage };

export type AppBootState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };
