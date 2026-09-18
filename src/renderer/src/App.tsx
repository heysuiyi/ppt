import { AppShell } from "./app/AppShell";
import { AppTopbar } from "./app/AppTopbar";
import { SettingsView } from "./app/SettingsView";
import { useAppModel } from "./app/useAppModel";
import { WorkspaceView } from "./app/WorkspaceView";

export function App() {
  const { boot, shell, topbar, content } = useAppModel();

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
    <AppShell {...shell} topbar={<AppTopbar {...topbar} />}>
      {content.area === "workspace" ? (
        <WorkspaceView {...content.props} />
      ) : (
        <SettingsView {...content.props} />
      )}
    </AppShell>
  );
}
