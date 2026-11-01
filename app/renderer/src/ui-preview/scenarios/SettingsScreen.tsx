import {
  type Dispatch,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "../../ui/components/button/Button";
import { Input } from "../../ui/components/input/Input";
import type { UiTheme } from "../../ui/provider/UiProvider";
import type { ConnectionAction, ConnectionState } from "../state/connection-state";
import type { WorkspaceAction, WorkspaceState } from "../state/workspace-state";
import { Foundations } from "./Foundations";
import { PreviewInspection } from "./PreviewInspection";
import "./settings.css";

export interface SettingsScreenProps {
  state: ConnectionState;
  dispatch: Dispatch<ConnectionAction>;
  workspaceState: WorkspaceState;
  workspaceDispatch: Dispatch<WorkspaceAction>;
  theme: UiTheme;
  onThemeChange: (theme: UiTheme) => void;
  onInspectionChange: (open: boolean) => void;
  onBack: () => void;
  backRef: RefObject<HTMLButtonElement | null>;
}

type SettingsSection = "models" | "appearance";

export function SettingsScreen({
  state,
  dispatch,
  workspaceState,
  workspaceDispatch,
  theme,
  onThemeChange,
  onInspectionChange,
  onBack,
  backRef,
}: SettingsScreenProps) {
  const [normalSection, setNormalSection] = useState<SettingsSection>("models");
  const [search, setSearch] = useState("");
  const generation = useRef(state.generation);
  const prefix = useId();
  // foundations 是 reducer 的导航结果，不能被页面内的分类状态遮住。
  const section = state.page === "foundations" ? "inspection" : normalSection;
  const sectionTitle =
    section === "models" ? "模型" : section === "appearance" ? "外观" : "验收工具";
  const query = search.trim().toLocaleLowerCase();
  const models = workspaceState.models.filter((model) =>
    model.name.toLocaleLowerCase().includes(query),
  );

  useLayoutEffect(() => {
    backRef.current?.focus();
  }, [backRef]);

  useEffect(() => {
    if (generation.current === state.generation) return;
    generation.current = state.generation;
    setNormalSection("models");
    onInspectionChange(false);
  }, [state.generation, onInspectionChange]);

  const selectSection = (next: SettingsSection) => {
    setNormalSection(next);
    onInspectionChange(false);
    if (state.page !== "connection") {
      dispatch({ type: "leave", intent: { kind: "page", page: "connection" } });
    }
  };
  const openConnectionInspection = () => {
    const target = state.connections[0];
    if (!target) return;
    setNormalSection("models");
    dispatch({ type: "leave", intent: { kind: "page", page: "connection" } });
    onInspectionChange(true);
    dispatch({ type: "open", targetId: target.id });
  };

  return (
    <div className="ui-settings-screen">
      <aside className="ui-settings-sidebar">
        <button ref={backRef} type="button" className="ui-settings-back" onClick={onBack}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="m9 4-6 6 6 6M3 10h14" />
          </svg>
          返回会话
        </button>
        <p className="ui-settings-sidebar-title">设置</p>
        <nav className="ui-settings-navigation" aria-label="设置分类">
          <button
            type="button"
            aria-current={section === "models" ? "page" : undefined}
            onClick={() => selectSection("models")}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="m10 2 7 4v8l-7 4-7-4V6l7-4Zm0 8 7-4M10 10 3 6m7 4v8" />
            </svg>
            模型
          </button>
          <button
            type="button"
            aria-current={section === "appearance" ? "page" : undefined}
            onClick={() => selectSection("appearance")}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <circle cx="10" cy="10" r="7" />
              <path d="M10 3v14M10 3a7 7 0 0 1 0 14Z" fill="currentColor" />
            </svg>
            外观
          </button>
          <button
            type="button"
            aria-current={section === "inspection" ? "page" : undefined}
            onClick={() => {
              setNormalSection("models");
              onInspectionChange(true);
              dispatch({ type: "leave", intent: { kind: "page", page: "foundations" } });
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M3 5h14M3 10h14M3 15h14M7 3v4m6 1v4m-6 1v4" />
            </svg>
            验收工具
          </button>
        </nav>
      </aside>
      <div className="ui-settings-body">
        <header className="ui-settings-topbar">
          <span>设置</span>
          <span aria-hidden="true">/</span>
          <span>{sectionTitle}</span>
        </header>
        <main className="ui-settings-main" aria-label={`${sectionTitle}设置`}>
          <div className="ui-settings-content">
            {section === "models" && (
              <>
                <section className="ui-settings-section" aria-labelledby={`${prefix}-models`}>
                  <header className="ui-settings-heading">
                    <h1 id={`${prefix}-models`}>示例模型</h1>
                    <p>显示在会话模型菜单中 · 仅本地示例</p>
                  </header>
                  <div className="ui-settings-model-list">
                    <div className="ui-settings-search">
                      <Input
                        type="search"
                        aria-label="搜索示例模型"
                        placeholder="搜索示例模型"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                      />
                    </div>
                    {models.length ? (
                      models.map((model) => (
                        <label key={model.id} className="ui-settings-model-row">
                          <span className="ui-settings-model-name">{model.name}</span>
                          <input
                            type="checkbox"
                            role="switch"
                            className="ui-settings-model-switch"
                            aria-label={`在模型菜单中显示 ${model.name}`}
                            checked={model.enabled}
                            onChange={(event) =>
                              workspaceDispatch({
                                type: "set-model-enabled",
                                modelId: model.id,
                                enabled: event.target.checked,
                              })
                            }
                          />
                        </label>
                      ))
                    ) : (
                      <p className="ui-settings-empty" role="status">
                        没有匹配的示例模型
                      </p>
                    )}
                  </div>
                </section>
                <section className="ui-settings-section" aria-labelledby={`${prefix}-connections`}>
                  <header className="ui-settings-connection-heading">
                    <h2 id={`${prefix}-connections`}>连接</h2>
                  </header>
                  <div className="ui-settings-connections">
                    {state.connections.map((connection) => (
                      <div key={connection.id} className="ui-settings-connection-row">
                        <div className="ui-settings-connection-details">
                          <h3>{connection.name}</h3>
                          <code>{connection.address}</code>
                        </div>
                        <Button
                          className="ui-settings-edit"
                          aria-label={`编辑 ${connection.name}`}
                          onClick={() => dispatch({ type: "open", targetId: connection.id })}
                        >
                          编辑
                        </Button>
                      </div>
                    ))}
                  </div>
                  <p className="ui-settings-save-status" role="status">
                    {state.notice}
                  </p>
                </section>
              </>
            )}
            {section === "appearance" && (
              <section className="ui-settings-section" aria-labelledby={`${prefix}-appearance`}>
                <header className="ui-settings-heading">
                  <h1 id={`${prefix}-appearance`}>外观</h1>
                </header>
                <fieldset className="ui-settings-theme-picker">
                  <legend>界面主题</legend>
                  <label className="ui-settings-theme-option">
                    <input
                      type="radio"
                      name={`${prefix}-theme`}
                      value="light"
                      checked={theme === "light"}
                      onChange={() => onThemeChange("light")}
                    />
                    <span>浅色</span>
                  </label>
                  <label className="ui-settings-theme-option">
                    <input
                      type="radio"
                      name={`${prefix}-theme`}
                      value="dark"
                      checked={theme === "dark"}
                      onChange={() => onThemeChange("dark")}
                    />
                    <span>深色</span>
                  </label>
                </fieldset>
              </section>
            )}
            {section === "inspection" && (
              <section className="ui-settings-section" aria-labelledby={`${prefix}-inspection`}>
                <header className="ui-settings-heading">
                  <h1 id={`${prefix}-inspection`}>验收工具</h1>
                </header>
                <div className="ui-settings-inspection-entry">
                  <div>
                    <h2>连接交互</h2>
                    <p>在编辑对话框内检查失败、等待、切换与旧结果。</p>
                  </div>
                  <Button disabled={!state.connections.length} onClick={openConnectionInspection}>
                    连接交互检查
                  </Button>
                </div>
                <div className="ui-settings-inspection-layout">
                  <PreviewInspection
                    state={state}
                    dispatch={dispatch}
                    theme={theme}
                    onThemeChange={onThemeChange}
                    onClose={() => selectSection("models")}
                  />
                  <Foundations />
                </div>
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
