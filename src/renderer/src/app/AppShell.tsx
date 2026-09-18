import type { CSSProperties, ReactNode } from "react";
import { NotificationViewport } from "./useNotificationCenter";

interface AppShellProps {
  notificationMessage: string | null;
  workspaceClassName: string;
  workspaceStyle: CSSProperties;
  topbar: ReactNode;
  children: ReactNode;
}

export function AppShell({
  notificationMessage,
  workspaceClassName,
  workspaceStyle,
  topbar,
  children,
}: AppShellProps) {
  return (
    <main className="app-shell">
      {topbar}
      <NotificationViewport message={notificationMessage} />
      <div className={workspaceClassName} style={workspaceStyle}>
        {children}
      </div>
    </main>
  );
}
