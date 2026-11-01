import { useLayoutEffect, useReducer, useRef, useState } from "react";
import { Button } from "../ui/components/button/Button";
import { Dialog } from "../ui/components/dialog/Dialog";
import { UiProvider, type UiTheme } from "../ui/provider/UiProvider";
import { ConnectionForm } from "./scenarios/ConnectionForm";
import { SettingsScreen } from "./scenarios/SettingsScreen";
import { WorkspaceScreen } from "./scenarios/WorkspaceScreen";
import { connectionReducer, createConnectionState } from "./state/connection-state";
import { createWorkspaceState, workspaceReducer } from "./state/workspace-state";

type PreviewScreen = "workspace" | "settings";

export function PreviewApp() {
  const [theme, setTheme] = useState<UiTheme>("dark");
  const [screen, setScreen] = useState<PreviewScreen>("workspace");
  const [inspection, setInspection] = useState(false);
  const [about, setAbout] = useState(false);
  const [state, dispatch] = useReducer(connectionReducer, undefined, () => createConnectionState());
  const [workspaceState, workspaceDispatch] = useReducer(
    workspaceReducer,
    undefined,
    createWorkspaceState,
  );
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const workspaceNavigation = useRef<HTMLButtonElement>(null);
  const settingsBack = useRef<HTMLButtonElement>(null);
  const previewTrigger = useRef<HTMLButtonElement>(null);
  const previousScreen = useRef(screen);

  useLayoutEffect(() => {
    if (previousScreen.current === "settings" && screen === "workspace") {
      const trigger = settingsTrigger.current?.getClientRects().length
        ? settingsTrigger.current
        : workspaceNavigation.current;
      trigger?.focus();
    }
    previousScreen.current = screen;
  }, [screen]);

  return (
    <UiProvider theme={theme}>
      <div className="ui-preview-app">
        <button
          ref={previewTrigger}
          type="button"
          className="ui-preview-badge"
          aria-label="预览说明"
          onClick={() => setAbout(true)}
        >
          预览
        </button>
        <div className="ui-preview-view" hidden={screen !== "workspace"}>
          <WorkspaceScreen
            state={workspaceState}
            dispatch={workspaceDispatch}
            settingsTriggerRef={settingsTrigger}
            navigationTriggerRef={workspaceNavigation}
            onSettings={() => {
              dispatch({ type: "leave", intent: { kind: "page", page: "connection" } });
              setScreen("settings");
            }}
          />
        </div>
        {screen === "settings" && (
          <SettingsScreen
            state={state}
            dispatch={dispatch}
            workspaceState={workspaceState}
            workspaceDispatch={workspaceDispatch}
            theme={theme}
            onThemeChange={setTheme}
            onInspectionChange={setInspection}
            backRef={settingsBack}
            onBack={() => {
              setInspection(false);
              setScreen("workspace");
            }}
          />
        )}
      </div>
      <Dialog
        open={about}
        purpose="confirm"
        title="预览说明"
        fallbackFocusRef={previewTrigger}
        onRequestClose={() => setAbout(false)}
        footer={<Button onClick={() => setAbout(false)}>知道了</Button>}
      >
        <p>工作区、模型与消息均为本地界面示例，不调用服务或访问目录。</p>
        <p>修改仅保留在当前窗口，刷新后恢复。</p>
      </Dialog>
      {state.editor && (
        <ConnectionForm
          key={`${state.generation}:${state.editor.id}`}
          state={state}
          dispatch={dispatch}
          fallbackFocusRef={settingsBack}
          inspection={inspection}
          onInspectionChange={setInspection}
        />
      )}
    </UiProvider>
  );
}
