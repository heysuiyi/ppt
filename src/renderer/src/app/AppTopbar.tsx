import { SidebarPanelIcon } from "../components/Icons";
import { TitlebarTemplateMenu } from "../components/TitlebarTemplateMenu";
import type { AppLocation } from "./appViewState";

interface AppTopbarProps {
  state: { location: AppLocation; sidebarCollapsed: boolean };
  data: { activeSessionId?: string; defaultTemplateId: string };
  actions: {
    toggleSidebar: () => void;
    setDefaultTemplateId: (templateId: string) => void;
    openTemplateSettings: () => void;
    notify: (message: string) => void;
  };
}

export function AppTopbar({ state, data, actions }: AppTopbarProps) {
  return (
    <div className="window-titlebar" role="toolbar" aria-label="窗口菜单栏" data-ui-region="topbar">
      {state.location.area === "workspace" ? (
        <>
          <button
            type="button"
            className={`window-titlebar-sidebar-toggle${state.sidebarCollapsed ? " is-collapsed" : ""}`}
            onClick={actions.toggleSidebar}
            title={state.sidebarCollapsed ? "展开工作台" : "折叠工作台"}
            aria-label={state.sidebarCollapsed ? "展开工作台" : "折叠工作台"}
            aria-expanded={!state.sidebarCollapsed}
          >
            <SidebarPanelIcon size={17} />
          </button>
          <div className="window-titlebar-leading">
            <TitlebarTemplateMenu
              activeSessionId={data.activeSessionId}
              defaultTemplateId={data.defaultTemplateId}
              setDefaultTemplateId={actions.setDefaultTemplateId}
              onOpenTemplateSettings={actions.openTemplateSettings}
              notify={actions.notify}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
