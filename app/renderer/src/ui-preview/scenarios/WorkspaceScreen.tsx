import {
  type Dispatch,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Select } from "../../ui/components/select/Select";
import {
  getActiveThread,
  type WorkspaceAction,
  type WorkspaceState,
} from "../state/workspace-state";
import "./workspace.css";

export interface WorkspaceScreenProps {
  state: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  onSettings: () => void;
  settingsTriggerRef: RefObject<HTMLButtonElement | null>;
  navigationTriggerRef: RefObject<HTMLButtonElement | null>;
}

const compactQuery = "(max-width: 680px)";

function subscribeToCompactLayout(onChange: () => void) {
  const query = window.matchMedia(compactQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function isCompactLayout() {
  return window.matchMedia(compactQuery).matches;
}

function desktopLayout() {
  return false;
}

function WorkspaceIcon({ name }: { name: "panel" | "plus" | "folder" | "settings" | "send" }) {
  return (
    <svg
      className="ui-workspace-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "panel" && (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </>
      )}
      {name === "plus" && <path d="M12 5v14M5 12h14" />}
      {name === "folder" && <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3V7Z" />}
      {name === "settings" && (
        <>
          <path d="m9 4 .7-2h4.6l.7 2 2 1.2 2.1-.4 2.3 4-1.4 1.7v2.4l1.4 1.7-2.3 4-2.1-.4-2 1.2-.7 2H9l-.7-2-2-1.2-2.1.4-2.3-4 1.4-1.7v-2.4L1.9 8.8l2.3-4 2.1.4L9 4Z" />
          <circle cx="11.7" cy="11.7" r="3" />
        </>
      )}
      {name === "send" && <path d="M12 19V5m-6 6 6-6 6 6" />}
    </svg>
  );
}

export function WorkspaceScreen({
  state,
  dispatch,
  onSettings,
  settingsTriggerRef,
  navigationTriggerRef,
}: WorkspaceScreenProps) {
  const prefix = useId();
  const compact = useSyncExternalStore(subscribeToCompactLayout, isCompactLayout, desktopLayout);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationVisible = !compact || navigationOpen;
  const thread = getActiveThread(state);
  const workspace = state.workspaces.find((item) => item.id === thread.workspaceId)!;
  const model = state.models.find((item) => item.id === thread.modelId);
  const modelUnavailable = !model?.enabled;
  const hasMessages = thread.messages.length > 0;
  const lastMessageId = thread.messages.at(-1)?.id;
  const canSend = Boolean(thread.draft.trim()) && !modelUnavailable;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const focusInputPending = useRef(false);
  const composing = useRef(false);
  const navigationId = `${prefix}-navigation`;
  const modelHintId = `${prefix}-model-hint`;
  const localStatusId = `${prefix}-local-status`;

  useLayoutEffect(() => {
    const container = messagesRef.current;
    if (container && lastMessageId !== undefined) container.scrollTop = container.scrollHeight;
  }, [lastMessageId]);

  useLayoutEffect(() => {
    if (!focusInputPending.current || (compact && navigationOpen)) return;
    focusInputPending.current = false;
    inputRef.current?.focus();
  });

  const returnToComposer = () => {
    focusInputPending.current = true;
    setNavigationOpen(false);
  };

  const send = () => {
    if (!canSend || composing.current) return;
    dispatch({ type: "send", threadId: thread.id });
    inputRef.current?.focus();
  };

  return (
    <div className="ui-workspace-screen">
      <aside
        id={navigationId}
        className="ui-workspace-sidebar"
        aria-label="会话导航"
        hidden={!navigationVisible}
      >
        <div className="ui-workspace-brand">Harness</div>
        <button
          type="button"
          className="ui-workspace-new"
          onClick={() => {
            dispatch({ type: "new-thread", workspaceId: thread.workspaceId });
            returnToComposer();
          }}
        >
          <WorkspaceIcon name="plus" />
          新会话
        </button>
        <nav className="ui-workspace-navigation" aria-label="工作区与会话">
          <div className="ui-workspace-navigation-label">工作区</div>
          {state.workspaces.map((item) => (
            <section className="ui-workspace-group" key={item.id} aria-label={item.name}>
              <button
                type="button"
                className="ui-workspace-group-button"
                aria-current={item.id === thread.workspaceId ? "true" : undefined}
                onClick={() => {
                  dispatch({ type: "select-workspace", workspaceId: item.id });
                  returnToComposer();
                }}
              >
                <WorkspaceIcon name="folder" />
                <span>{item.name}</span>
              </button>
              <ul className="ui-workspace-thread-list">
                {state.threads
                  .filter((itemThread) => itemThread.workspaceId === item.id)
                  .map((itemThread) => (
                    <li key={itemThread.id}>
                      <button
                        type="button"
                        className="ui-workspace-thread"
                        aria-current={thread.id === itemThread.id ? "page" : undefined}
                        title={itemThread.title}
                        onClick={() => {
                          dispatch({ type: "select-thread", threadId: itemThread.id });
                          returnToComposer();
                        }}
                      >
                        <span>{itemThread.title}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </nav>
        <div className="ui-workspace-sidebar-footer">
          <button
            type="button"
            ref={settingsTriggerRef}
            className="ui-workspace-settings"
            onClick={() => {
              setNavigationOpen(false);
              onSettings();
            }}
          >
            <WorkspaceIcon name="settings" />
            设置
          </button>
        </div>
      </aside>

      <header className="ui-workspace-topbar">
        <button
          type="button"
          ref={navigationTriggerRef}
          className="ui-workspace-navigation-toggle"
          aria-label={navigationOpen ? "收起会话导航" : "展开会话导航"}
          aria-expanded={navigationVisible}
          aria-controls={navigationId}
          onClick={() => setNavigationOpen((open) => !open)}
        >
          <WorkspaceIcon name="panel" />
        </button>
        <span
          className="ui-workspace-topbar-title"
          title={hasMessages ? thread.title : workspace.name}
        >
          {hasMessages ? thread.title : workspace.name}
        </span>
      </header>

      <main
        className="ui-workspace-main"
        data-has-messages={hasMessages}
        aria-label="会话工作台"
        hidden={compact && navigationOpen}
      >
        {hasMessages && (
          <div className="ui-workspace-message-scroll" ref={messagesRef}>
            <div
              className="ui-workspace-message-column"
              role="log"
              aria-label="会话消息"
              aria-relevant="additions"
            >
              {thread.messages.map((message) => (
                <article className="ui-workspace-message" key={message.id}>
                  <h2>你</h2>
                  <p>{message.text}</p>
                </article>
              ))}
            </div>
          </div>
        )}
        <div className="ui-workspace-composer-area">
          <form
            className="ui-workspace-composer-form"
            aria-label="发送任务"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <div className="ui-workspace-context">
              <WorkspaceIcon name="folder" />
              <Select
                className="ui-workspace-workspace-select"
                variant="compact"
                aria-label="当前工作区"
                value={thread.workspaceId}
                options={state.workspaces.map((item) => ({ value: item.id, label: item.name }))}
                onValueChange={(workspaceId) => dispatch({ type: "select-workspace", workspaceId })}
              />
            </div>
            <div className="ui-workspace-composer">
              <textarea
                ref={inputRef}
                className="ui-workspace-input"
                aria-label="任务输入"
                aria-describedby={modelUnavailable ? modelHintId : undefined}
                placeholder="描述你的任务…"
                rows={3}
                value={thread.draft}
                onChange={(event) =>
                  dispatch({ type: "draft", threadId: thread.id, value: event.target.value })
                }
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
                onKeyDown={(event) => {
                  if (
                    event.key !== "Enter" ||
                    event.shiftKey ||
                    event.nativeEvent.isComposing ||
                    composing.current ||
                    event.nativeEvent.keyCode === 229
                  )
                    return;
                  event.preventDefault();
                  send();
                }}
              />
              <div className="ui-workspace-composer-toolbar">
                <Select
                  className="ui-workspace-model-select"
                  variant="compact"
                  align="end"
                  aria-label="当前模型"
                  aria-describedby={modelUnavailable ? modelHintId : undefined}
                  placeholder="请选择模型"
                  value={thread.modelId}
                  options={state.models
                    .filter((item) => item.enabled || item.id === thread.modelId)
                    .map((item) => ({
                      value: item.id,
                      label: `${item.name}${item.enabled ? "" : "（已隐藏）"}`,
                      disabled: !item.enabled,
                    }))}
                  onValueChange={(modelId) =>
                    dispatch({ type: "select-model", threadId: thread.id, modelId })
                  }
                />
                <button
                  className="ui-workspace-send"
                  type="submit"
                  aria-label="发送示例"
                  title="发送示例"
                  disabled={!canSend}
                >
                  <WorkspaceIcon name="send" />
                </button>
              </div>
            </div>
            {modelUnavailable && (
              <p className="ui-workspace-model-hint" id={modelHintId} role="status">
                {state.models.some((item) => item.enabled)
                  ? "当前模型已隐藏，请重新选择。"
                  : "没有可选的示例模型。"}
                <button className="ui-workspace-model-link" type="button" onClick={onSettings}>
                  模型设置
                </button>
              </p>
            )}
            {hasMessages && (
              <p className="ui-workspace-local-status" id={localStatusId} role="status">
                仅保存在本地，未调用模型。
              </p>
            )}
          </form>
        </div>
      </main>
    </div>
  );
}
