import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { UiProvider, type UiTheme } from "../ui/provider/UiProvider";
import { DesktopSettings } from "./DesktopSettings";
import { DesktopWorkspace } from "./DesktopWorkspace";
import { createWorkspaceController, type WorkspaceController } from "./workspace-controller";
import "./desktop.css";

const themeKey = "harness-desktop-theme";

function readTheme(): UiTheme {
  try {
    return localStorage.getItem(themeKey) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function ConnectedDesktop({
  controller,
  theme,
  onThemeChange,
}: {
  controller: WorkspaceController;
  theme: UiTheme;
  onThemeChange: (theme: UiTheme) => void;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  const [settings, setSettings] = useState(false);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const navigationRef = useRef<HTMLButtonElement>(null);
  const previousSettings = useRef(false);

  useEffect(() => controller.start(), [controller]);
  useLayoutEffect(() => {
    if (previousSettings.current && !settings) {
      const trigger = settingsRef.current?.getClientRects().length
        ? settingsRef.current
        : navigationRef.current;
      trigger?.focus();
    }
    previousSettings.current = settings;
  }, [settings]);

  return (
    <div className="desktop-app">
      <div className="desktop-workspace-view" hidden={settings}>
        <DesktopWorkspace
          state={state}
          controller={controller}
          onSettings={() => setSettings(true)}
          theme={theme}
          onThemeChange={onThemeChange}
          settingsRef={settingsRef}
          navigationRef={navigationRef}
        />
      </div>
      {settings && (
        <DesktopSettings
          onBack={() => setSettings(false)}
          onChanged={() => {
            void controller.refreshModels();
          }}
          theme={theme}
          onThemeChange={onThemeChange}
        />
      )}
    </div>
  );
}

export function DesktopApp() {
  const [theme, setTheme] = useState<UiTheme>(readTheme);
  const [controller] = useState(() =>
    window.harnessDesktop ? createWorkspaceController(window.harnessDesktop) : null,
  );

  function changeTheme(next: UiTheme) {
    setTheme(next);
    try {
      localStorage.setItem(themeKey, next);
    } catch {
      /* 存储不可用时仍允许当前窗口切换非敏感外观。 */
    }
  }

  return (
    <UiProvider theme={theme}>
      {controller ? (
        <ConnectedDesktop controller={controller} theme={theme} onThemeChange={changeTheme} />
      ) : (
        <main className="desktop-app desktop-unavailable" role="alert">
          <h1>桌面服务未连接</h1>
          <p>请从桌面应用入口打开此界面；当前没有创建或发送任何会话。</p>
        </main>
      )}
    </UiProvider>
  );
}
