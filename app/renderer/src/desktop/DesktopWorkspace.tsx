import {
  type RefObject,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../ui/components/button/Button";
import { Markdown } from "../ui/components/markdown/Markdown";
import { Select } from "../ui/components/select/Select";
import type { UiTheme } from "../ui/provider/UiProvider";
import { ToolResult } from "./ToolResult";
import { WorkspaceIcon } from "./WorkspaceIcon";
import {
  canSubmit,
  draftKey,
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
  const composing = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
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
  const modelId = session?.modelId ?? state.newModelId;
  const running = isRunning(state);
  const stoppable = Boolean(unfinished || running);
  const actionLabel = stoppable ? "停止任务" : "发送任务";
  const model = state.models.find((item) => item.id === modelId);
  const unavailable = !model || model.availability?.state === "unavailable";
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
  const draft = state.drafts[draftKey(state)] ?? "";
  const modelOptions = state.models.map((item) => ({
    value: item.id,
    label: `${item.label}${item.availability?.state === "unavailable" ? "（不可用）" : ""}`,
    disabled: item.availability?.state === "unavailable",
  }));
  if (modelId && !model)
    modelOptions.push({ value: modelId, label: `${modelId}（原绑定，已不可用）`, disabled: true });

  useLayoutEffect(() => {
    const element = messagesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [history, preview?.text, preview?.reasoning, tools, approval]);

  function returnToComposer() {
    setNavigationOpen(false);
    inputRef.current?.focus();
  }

  function send() {
    if (!canSubmit(state) || composing.current) return;
    void controller.send();
  }

  return (
    <div className="ui-workspace-screen">
      <aside
        id={`${id}-navigation`}
        className="ui-workspace-sidebar"
        aria-label="会话导航"
        hidden={compact && !navigationOpen}
      >
        <div className="ui-workspace-brand">Harness</div>
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
        <nav className="ui-workspace-navigation" aria-label="工作区与会话">
          <div className="ui-workspace-navigation-label">工作区</div>
          {snapshot?.recentWorkspaces.map((workspace) => (
            <section className="ui-workspace-group" key={workspace.id} aria-label={workspace.label}>
              <button
                type="button"
                className="ui-workspace-group-button"
                title={workspace.path}
                aria-current={snapshot.workspace?.id === workspace.id ? "true" : undefined}
                disabled={locked || waiting}
                onClick={() => {
                  void controller.selectWorkspace(workspace.id);
                  returnToComposer();
                }}
              >
                <WorkspaceIcon name="folder" />
                <span>{workspace.label}</span>
              </button>
              {workspace.id === snapshot.workspace?.id && (
                <ul className="ui-workspace-thread-list">
                  {snapshot.sessions.map((item) => (
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
                        <span>
                          {item.label}
                          {item.unfinished
                            ? ` · ${item.unfinished.status === "waiting" ? "待审批" : item.id === session?.id && running ? "进行中" : "待继续"}`
                            : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
          <button
            type="button"
            className="ui-workspace-group-button"
            disabled={locked || waiting}
            onClick={() => {
              void controller.chooseWorkspace();
              returnToComposer();
            }}
          >
            <WorkspaceIcon name="folder" />
            <span>选择工作区目录…</span>
          </button>
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
      </aside>
      <header className="ui-workspace-topbar">
        <button
          ref={navigationRef}
          type="button"
          className="ui-workspace-navigation-toggle"
          aria-label={navigationOpen ? "收起会话导航" : "展开会话导航"}
          aria-expanded={!compact || navigationOpen}
          aria-controls={`${id}-navigation`}
          onClick={() => setNavigationOpen((open) => !open)}
        >
          <WorkspaceIcon name="panel" />
        </button>
        <span className="ui-workspace-topbar-title" title={snapshot?.workspace?.path}>
          {session?.label ?? snapshot?.workspace?.label ?? "选择工作区开始"}
        </span>
        <button
          type="button"
          className="ui-workspace-model-link desktop-theme-toggle"
          aria-label={`切换为${theme === "dark" ? "浅色" : "深色"}主题`}
          onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? "浅色" : "深色"}
        </button>
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
              {history.map((entry, index) => (
                <article
                  className={`ui-workspace-message${entry.role === "user" ? " desktop-user-message" : ""}`}
                  key={
                    entry.role === "tool" && entry.tool.identity
                      ? JSON.stringify([
                          entry.tool.identity.agentId,
                          entry.tool.identity.threadId,
                          entry.tool.identity.queryId,
                          entry.tool.identity.runId,
                          entry.tool.step,
                          entry.tool.callId,
                        ])
                      : `${session?.id}-${index}`
                  }
                  aria-label={
                    entry.role === "user"
                      ? "你的消息"
                      : entry.role === "assistant"
                        ? "助手消息"
                        : undefined
                  }
                >
                  {entry.role === "tool" ? (
                    <ToolResult
                      name={entry.tool.name}
                      status={
                        entry.tool.status ??
                        (entry.tool.result === "error"
                          ? "failed"
                          : entry.tool.result === "missing"
                            ? "unknown"
                            : "recorded")
                      }
                      display={entry.tool.display}
                      effects={entry.tool.effects}
                      error={entry.tool.error}
                    />
                  ) : entry.role === "reasoning" ? (
                    <details className="desktop-reasoning">
                      <summary>思考过程</summary>
                      <Markdown content={entry.text} />
                    </details>
                  ) : entry.role === "user" ? (
                    <p>{entry.text}</p>
                  ) : (
                    <Markdown content={entry.text} />
                  )}
                </article>
              ))}
              {preview && (preview.text || preview.reasoning) && (
                <article className="ui-workspace-message desktop-preview" aria-label="临时输出预览">
                  <span className="desktop-stream-label">生成中</span>
                  {preview.reasoning && (
                    <details className="desktop-reasoning">
                      <summary>思考过程</summary>
                      <Markdown content={preview.reasoning} />
                    </details>
                  )}
                  {preview.text && <Markdown content={preview.text} />}
                </article>
              )}
              {tools.map((tool) => (
                <article
                  className="ui-workspace-message"
                  key={JSON.stringify([
                    tool.identity.queryId,
                    tool.invocationIdentity?.runId ?? tool.identity.runId,
                    tool.step,
                    tool.callId,
                  ])}
                  aria-label={`工具状态 ${tool.name}`}
                >
                  <ToolResult
                    name={tool.name}
                    status={tool.status}
                    display={tool.display}
                    effects={tool.effects}
                    error={tool.error}
                  />
                </article>
              ))}
              {unfinished?.status === "waiting" && (
                <section className="desktop-interaction" aria-label="待决审批">
                  <p>{approval?.summary ?? "需要你的确认"}</p>
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
              <button
                type="button"
                className="ui-workspace-model-link desktop-workspace-picker"
                title={snapshot?.workspace?.path}
                aria-label={
                  snapshot?.workspace ? `更换工作区：${snapshot.workspace.path}` : "选择工作区"
                }
                disabled={locked || waiting}
                onClick={() => void controller.chooseWorkspace()}
              >
                {snapshot?.workspace?.label ?? "选择工作区"}
              </button>
            </div>
            <div className="ui-workspace-composer">
              <textarea
                ref={inputRef}
                className="ui-workspace-input"
                aria-label="任务输入"
                aria-describedby={`${id}-status${unavailable ? ` ${id}-model` : ""}`}
                placeholder="描述你的任务…"
                rows={3}
                value={draft}
                disabled={state.loading}
                onChange={(event) => controller.setDraft(event.target.value)}
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
                  aria-label="当前模型"
                  aria-describedby={unavailable ? `${id}-model` : undefined}
                  variant="compact"
                  align="end"
                  placeholder="请选择模型"
                  value={modelId ?? ""}
                  options={modelOptions}
                  disabled={locked || !state.composingNew}
                  onValueChange={(value) => controller.setNewModel(value)}
                />
                {/* 固定按钮类型，避免停止完成后同一次点击继续触发表单发送。 */}
                <button
                  className="ui-workspace-send"
                  type="button"
                  aria-label={actionLabel}
                  title={actionLabel}
                  data-processing={running || state.pending}
                  disabled={stoppable ? state.pending || state.loading : !canSubmit(state)}
                  onClick={() => {
                    if (stoppable) void controller.cancel();
                    else send();
                  }}
                >
                  {stoppable ? (
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                  ) : (
                    <WorkspaceIcon name="send" />
                  )}
                </button>
              </div>
            </div>
            {unavailable && (
              <p className="ui-workspace-model-hint" id={`${id}-model`} role="status">
                {session
                  ? "此会话的模型不可用，请检查连接或新建会话。"
                  : state.models.length
                    ? "请选择可用模型。"
                    : "添加模型后即可开始。"}
                <button
                  className="ui-workspace-model-link"
                  type="button"
                  disabled={locked || waiting}
                  onClick={onSettings}
                >
                  模型设置
                </button>
              </p>
            )}
            <p
              className="ui-workspace-local-status"
              id={`${id}-status`}
              role="status"
              data-quiet="true"
            >
              {status}
            </p>
          </form>
        </div>
      </main>
    </div>
  );
}
