import { useState } from "react";
import type { SettingsCategory } from "../settingsCategories";
import type { AppLocation, WorkspacePage } from "./appViewState";
import { confirmProjectFileNavigation } from "./project/projectFilesState";

export function useAppNavigation() {
  const [location, setLocation] = useState<AppLocation>({ area: "workspace", page: "chat" });
  const [projectFilesDirty, setProjectFilesDirty] = useState(false);

  const confirmLeaveProjectFiles = () =>
    location.area !== "workspace" ||
    location.page !== "files" ||
    confirmProjectFileNavigation(projectFilesDirty, () =>
      window.confirm("当前项目文件有未保存修改。要放弃草稿并离开吗？"),
    );

  const showWorkspacePage = (page: WorkspacePage) => {
    if (location.area === "workspace" && location.page === page) return true;
    if (!confirmLeaveProjectFiles()) return false;
    setLocation({ area: "workspace", page });
    return true;
  };

  const openSettings = (category: SettingsCategory = "models") => {
    if (!confirmLeaveProjectFiles()) return;
    setLocation({
      area: "settings",
      category,
      returnTo: location.area === "workspace" ? location.page : location.returnTo,
    });
  };

  return {
    location,
    actions: {
      showWorkspacePage,
      openSettings,
      selectSettingsCategory: (category: SettingsCategory) => {
        setLocation((current) =>
          current.area === "settings" ? { ...current, category } : current,
        );
      },
      backToWorkspace: () => {
        setLocation((current) =>
          current.area === "settings" ? { area: "workspace", page: current.returnTo } : current,
        );
      },
      confirmLeaveProjectFiles,
      setProjectFilesDirty,
    },
  };
}
