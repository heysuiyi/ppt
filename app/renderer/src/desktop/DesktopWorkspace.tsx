import {
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../ui/components/button/Button";
import { createChatScrollController } from "../ui/patterns/chat-scroll-controller";
import type { UiTheme } from "../ui/provider/UiProvider";
import { DesktopComposer } from "./DesktopComposer";
import { DesktopTranscript } from "./DesktopTranscript";
import { WorkspaceIcon } from "./WorkspaceIcon";
import {
  isLocked,
  isRunning,
  selectedSession,
  type WorkspaceController,
  type WorkspaceViewState,
} from "./workspace-controller";

const compactQuery = "(max-width: 680px)";
function subscribeLayout(listener: () => void) {
  const query = window.matchMedia(compactQuery);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
function compactLayout() {
  return window.matchMedia(compactQuery).matches;
}
function desktopLayout() {
  return false;
}

const statuses = {
  idle: "",
  running: "正在处理",
  waiting: "需要你的审批",
  completed: "",
  cancelled: "已停止",
  interrupted: "任务已中断",
  failed: "任务未完成",
};

export function DesktopWorkspace({
  state,
  controller,
  onSettings,
  theme,
  onThemeChange,
  settingsRef,
  navigationRef,
}: {
  state: WorkspaceViewState;
  controller: WorkspaceController;
  onSettings: () => void;
  theme: UiTheme;
  onThemeChange: (theme: UiTheme) => void;
  settingsRef: RefObject<HTMLButtonElement | null>;
  navigationRef: RefObject<HTMLButtonElement | null>;
}) {
  const id = useId();
  const compact = useSyncExternalStore(subscribeLayout, compactLayout, desktopLayout);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [navigationAnimating, setNavigationAnimating] = useState(false);
  const [collapsedWorkspace, setCollapsedWorkspace] = useState<string | null>(null);
  const [scroll] = useState(createChatScrollController);
  const following = useSyncExternalStore(scroll.subscribe, scroll.isFollowing, () => true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const snapshot = state.snapshot;
  const session = selectedSession(state);
  const sessionHistory = session?.history ?? [];
  const preview = !state.composingNew ? state.preview : null;
  const tools = useMemo(
    () => (state.composingNew ? [] : state.toolProgress),
    [state.composingNew, state.toolProgress],
  );
  const history = useMemo(
    () =>
      sessionHistory.filter(
        (entry) =>
          entry.role !== "tool" ||
          !tools.some((tool) => {
            if (!entry.tool.identity || entry.tool.step === undefined || tool.step === undefined)
              return false;
            const stored = entry.tool.identity;
            const observed = tool.invocationIdentity ?? tool.identity;
            return (
              entry.tool.callId === tool.callId &&
              entry.tool.name === tool.name &&
              entry.tool.step === tool.step &&
              stored.agentId === observed.agentId &&
              stored.threadId === observed.threadId &&
              stored.queryId === observed.queryId &&
              stored.runId === observed.runId
            );
          }),
      ),
    [sessionHistory, tools],
  );
  const hasMessages =
    history.length > 0 ||
    Boolean(preview?.text || preview?.reasoning) ||
    tools.length > 0 ||
    Boolean(session?.unfinished || snapshot?.activeRun || state.error);
  const locked = isLocked(state);
  const unfinished = session?.unfinished;
  const approval = unfinished?.status === "waiting" ? snapshot?.pendingApproval : null;
  const running = isRunning(state);
  const waiting = snapshot?.status === "waiting";
  const needsResume = Boolean(unfinished && !waiting && !running);
  const status = state.loading
    ? "正在加载"
    : state.pending
      ? "正在处理"
      : needsResume
        ? "任务未完成，可继续或停止"
        : !state.composingNew && snapshot
          ? statuses[snapshot.status]
          : "";
  const conversationKey = `${snapshot?.workspace?.id ?? ""}:${session?.id ?? "new"}`;

  useEffect(() => {
    if (!navigationAnimating) return;
    const timer = window.setTimeout(() => setNavigationAnimating(false), 350);
    return () => window.clearTimeout(timer);
  }, [navigationAnimating, sidebarCollapsed]);

  useLayoutEffect(() => {
    scroll.setViewport(messagesRef.current);
    scroll.setStream(streamRef.current);
    scroll.setFollowing(true);
    const detach = scroll.attach();
    scroll.scrollToBottom();
    return () => {
      detach();
      scroll.setViewport(null);
      scroll.setStream(null);
    };
  }, [scroll, hasMessages, conversationKey]);

  useLayoutEffect(() => {
    scroll.stickToBottomIfFollowing();
  }, [scroll, history, preview?.text, preview?.reasoning, tools, approval]);

  function returnToComposer() {
    setNavigationOpen(false);
    inputRef.current?.focus();
  }

  return (
    <div
      className="ui-workspace-screen"
      data-has-messages={hasMessages}
      data-navigation-hidden={!compact && sidebarCollapsed}
      data-navigation-animating={navigationAnimating || undefined}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === "grid-template-columns")
          setNavigationAnimating(false);
      }}
    >
      <div className="desktop-caption">
        <button
          ref={navigationRef}
          type="button"
          className="ui-workspace-navigation-toggle"
          aria-label={
            (compact ? navigationOpen : !sidebarCollapsed) ? "收起会话导航" : "展开会话导航"
          }
          aria-expanded={compact ? navigationOpen : !sidebarCollapsed}
          aria-controls={`${id}-navigation`}
          onClick={() => {
            if (compact) setNavigationOpen((open) => !open);
            else {
              setNavigationAnimating(
                !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
              );
              setSidebarCollapsed((collapsed) => !collapsed);
            }
          }}
        >
          <WorkspaceIcon name="panel" />
        </button>
      </div>
      <aside
        id={`${id}-navigation`}
        className="ui-workspace-sidebar"
        aria-label="会话导航"
        hidden={compact && !navigationOpen}
        inert={compact ? !navigationOpen : sidebarCollapsed}
        aria-hidden={compact ? !navigationOpen : sidebarCollapsed}
      >
        <div className="desktop-sidebar-content">
          <div className="ui-workspace-brand" aria-label="Agent Harness">
            <img src="./icon.svg" alt="" width={28} height={28} />
            <span>Harness</span>
          </div>
          <button
            type="button"
            className="ui-workspace-new"
            disabled={locked || waiting || !snapshot?.workspace}
            onClick={() => {
              controller.newSession();
              returnToComposer();
            }}
          >
            <WorkspaceIcon name="plus" />
            新会话
          </button>
          <div className="desktop-navigation-heading">
            <span>工作区</span>
            <button
              type="button"
              className="desktop-navigation-add"
              aria-label="选择工作区目录…"
              title="添加工作区"
              disabled={locked || waiting}
              onClick={() => {
                void controller.chooseWorkspace();
                returnToComposer();
              }}
            >
              <WorkspaceIcon name="plus" />
            </button>
          </div>
          <nav className="ui-workspace-navigation" aria-label="工作区与会话">
            {snapshot?.recentWorkspaces.map((workspace) => (
              <section
                className="ui-workspace-group"
                key={workspace.id}
                aria-label={workspace.label}
              >
                <button
                  type="button"
                  className="ui-workspace-group-button"
                  title={workspace.path}
                  aria-current={snapshot.workspace?.id === workspace.id ? "true" : undefined}
                  aria-expanded={
                    snapshot.workspace?.id === workspace.id && collapsedWorkspace !== workspace.id
                  }
                  aria-controls={
                    snapshot.workspace?.id === workspace.id ? `${id}-threads` : undefined
                  }
                  disabled={locked || waiting}
                  onClick={() => {
                    if (snapshot.workspace?.id === workspace.id) {
                      setCollapsedWorkspace((current) =>
                        current === workspace.id ? null : workspace.id,
                      );
                      return;
                    }
                    setCollapsedWorkspace(null);
                    void controller.selectWorkspace(workspace.id);
                    returnToComposer();
                  }}
                >
                  <span className="desktop-workspace-glyph" aria-hidden="true">
                    <WorkspaceIcon name="folder" />
                    <svg
                      className="desktop-workspace-chevron"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m9 5 7 7-7 7" />
                    </svg>
                  </span>
                  <span>{workspace.label}</span>
                </button>
                {workspace.id === snapshot.workspace?.id && (
                  <div
                    id={`${id}-threads`}
                    className="desktop-fold"
                    hidden={collapsedWorkspace === workspace.id}
                    inert={collapsedWorkspace === workspace.id}
                    aria-hidden={collapsedWorkspace === workspace.id}
                  >
                    <div className="desktop-fold__inner">
                      <ul
                        className="ui-workspace-thread-list"
                        aria-label={`${workspace.label}的会话`}
                      >
                        {snapshot.sessions.length === 0 && (
                          <li className="desktop-navigation-empty">暂无会话</li>
                        )}
                        {snapshot.sessions.map((item) => {
                          const taskState = item.unfinished
                            ? item.unfinished.status === "waiting"
                              ? "待审批"
                              : item.id === session?.id && running
                                ? "进行中"
                                : "待继续"
                            : null;
                          return (
                            <li key={item.id}>
                              <button
                                type="button"
                                className="ui-workspace-thread"
                                disabled={locked}
                                aria-current={session?.id === item.id ? "page" : undefined}
                                title={item.label}
                                onClick={() => {
                                  void controller.selectSession(item.id);
                                  returnToComposer();
                                }}
                              >
                                <span className="desktop-thread-slot" aria-hidden="true">
                                  {taskState && (
                                    <span
                                      className="desktop-thread-dot"
                                      data-state={
                                        item.unfinished?.status === "waiting" ? "waiting" : "active"
                                      }
                                    />
                                  )}
                                </span>
                                <span className="desktop-thread-title">{item.label}</span>
                                {taskState && (
                                  <span className="desktop-thread-state">{taskState}</span>
                                )}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </div>
                )}
              </section>
            ))}
          </nav>
          <div className="ui-workspace-sidebar-footer">
            <button
              ref={settingsRef}
              type="button"
              className="ui-workspace-settings"
              disabled={locked || waiting}
              onClick={() => {
                setNavigationOpen(false);
                onSettings();
              }}
            >
              <WorkspaceIcon name="settings" />
              设置
            </button>
          </div>
        </div>
      </aside>
      <header className="ui-workspace-topbar">
        <div className="desktop-session-heading">
          <span className="ui-workspace-topbar-title" title={session?.label}>
            {session?.label ?? "新会话"}
          </span>
          {snapshot?.workspace && (
            <span className="desktop-session-context" title={snapshot.workspace.path}>
              <WorkspaceIcon name="folder" />
              <span>{snapshot.workspace.label}</span>
            </span>
          )}
        </div>
        <button
          type="button"
          className="desktop-theme-toggle"
          aria-label={`切换为${theme === "dark" ? "浅色" : "深色"}主题`}
          onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {theme === "dark" ? (
              <>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
              </>
            ) : (
              <path d="M20.5 14a8.5 8.5 0 0 1-10.5-10.5A8.5 8.5 0 1 0 20.5 14Z" />
            )}
          </svg>
        </button>
        {hasMessages && (
          <div className="desktop-view-heading" aria-label="当前视图">
            <span aria-current="page">对话</span>
          </div>
        )}
      </header>
      <main
        className="ui-workspace-main"
        data-has-messages={hasMessages}
        aria-label="会话工作台"
        hidden={compact && navigationOpen}
      >
        <div className="ui-workspace-message-scroll" ref={messagesRef}>
          <div className="desktop-scroll-content" ref={streamRef}>
            {!hasMessages && (
              <section className="desktop-welcome" aria-labelledby={`${id}-welcome`}>
                <img className="desktop-welcome-mark" src="./icon.svg" alt="" width={44} height={44} />
                <h1 id={`${id}-welcome`}>有什么可以一起完成？</h1>
                <p>从一个问题开始，或描述你想在工作区完成的任务。</p>
              </section>
            )}
            {hasMessages && (
              <div className="desktop-transcript-seat">
                <div
                  className="ui-workspace-message-column"
                  role="log"
                  aria-label="会话消息"
                  aria-relevant="additions"
                >
                  <DesktopTranscript
                    key={conversationKey}
                    sessionId={session?.id}
                    history={history}
                    tools={tools}
                    preview={preview}
                    status={!state.composingNew ? snapshot?.status : undefined}
                  />
                  {running && !preview?.text && !preview?.reasoning && (
                    <p className="desktop-thinking" role="status">
                      <span aria-hidden="true" /> 正在处理任务…
                    </p>
                  )}
                  {unfinished?.status === "waiting" && (
                    <section
                      className="desktop-interaction"
                      aria-label="待决审批"
                      aria-busy={state.pending}
                    >
                      <div className="desktop-interaction__heading">
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          aria-hidden="true"
                        >
                          <path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" />
                          <path d="M12 8v5m0 3v1" />
                        </svg>
                        <span>{state.pending ? "正在提交审批…" : "等待你的确认"}</span>
                      </div>
                      <p className="desktop-interaction__summary">
                        {approval?.summary ?? "需要你的确认"}
                      </p>
                      {approval?.supported &&
                      approval.queryId === unfinished.queryId &&
                      approval.choices.some(
                        (choice) => choice.id === "allow" || choice.id === "reject",
                      ) ? (
                        <div className="desktop-action-row">
                          {approval.choices
                            .filter((choice) => choice.id === "allow" || choice.id === "reject")
                            .map((choice) => (
                              <Button
                                key={choice.id}
                                data-choice={choice.id}
                                tone={choice.id === "allow" ? "primary" : "neutral"}
                                disabled={locked}
                                onClick={() => {
                                  if (choice.id === "allow" || choice.id === "reject")
                                    void controller.resume(choice.id).then(returnToComposer);
                                }}
                              >
                                {choice.id === "allow" ? "批准" : "拒绝"}
                              </Button>
                            ))}
                        </div>
                      ) : (
                        <p>此请求暂不支持在此审批，未自动批准。你可以停止任务。</p>
                      )}
                    </section>
                  )}
                  {!running &&
                    !state.pending &&
                    !state.loading &&
                    !waiting &&
                    status &&
                    !state.error && (
                      <p className="desktop-conversation-status" aria-hidden="true">
                        {status}
                      </p>
                    )}
                  {state.error && (
                    <div className="desktop-notice" data-error="true" role="alert">
                      {state.error}
                    </div>
                  )}
                  <div className="desktop-action-row">
                    {needsResume && (
                      <Button disabled={locked} onClick={() => void controller.resume()}>
                        继续任务
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}
            <div className="desktop-composer-seat">
              {hasMessages && !following && (
                <div className="desktop-jump-row">
                  <button
                    type="button"
                    aria-label="回到最新消息"
                    title="回到最新消息"
                    className="desktop-jump-latest"
                    onClick={() => {
                      scroll.setFollowing(true);
                      scroll.scrollToBottom();
                    }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 5v14m-6-6 6 6 6-6" />
                    </svg>
                  </button>
                </div>
              )}
              <div className="ui-workspace-composer-area">
                <DesktopComposer
                  state={state}
                  controller={controller}
                  onSettings={onSettings}
                  inputRef={inputRef}
                  variant={hasMessages ? "composer" : "hero"}
                />
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
