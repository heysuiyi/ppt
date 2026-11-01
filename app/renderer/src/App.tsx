import { AppTopbar } from "./app/AppTopbar";
import type { AppBootstrapSnapshot } from "./app/appBootstrap";
import { SettingsView } from "./app/SettingsView";
import { useAppModel } from "./app/useAppModel";
import { NotificationViewport } from "./app/useNotificationCenter";
import { WorkspaceView } from "./app/WorkspaceView";

export function App({ bootstrap }: { bootstrap: AppBootstrapSnapshot }) {
  const { boot, shell, topbar, content } = useAppModel(bootstrap);

  if (boot.status === "error") {
    return (
      <main className="loading error">
        <span className="loading-message">{boot.message}</span>
      </main>
    );
  }
  if (boot.status === "loading") {
    return (
      <main className="loading">
        <span className="loading-indicator" aria-hidden="true" />
        <span className="loading-message">正在打开本地演示文稿工作区...</span>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <AppTopbar {...topbar} />
      <NotificationViewport message={shell.notificationMessage} />
      <div
        ref={shell.workspaceRef}
        className={shell.workspaceClassName}
        style={shell.workspaceStyle}
      >
        {content.area === "workspace" ? (
          <WorkspaceView {...content.props} />
        ) : (
          <SettingsView {...content.props} />
        )}
      </div>
    </main>
  );
}
