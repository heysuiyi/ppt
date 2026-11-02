import { type RefObject, useId, useRef } from "react";
import { Select, type SelectOption } from "../ui/components/select/Select";
import { ComposerTools } from "./ComposerTools";
import {
  canSubmit,
  draftKey,
  isLocked,
  isRunning,
  NEW_SESSION_TOOLS_MODE,
  selectedSession,
  type WorkspaceController,
  type WorkspaceViewState,
} from "./workspace-controller";
import "./desktop-composer.css";

const statuses = {
  idle: "",
  running: "正在处理",
  waiting: "需要你的审批",
  completed: "",
  cancelled: "已停止",
  interrupted: "任务已中断",
  failed: "任务未完成",
};

/** 输入卡片只消费展示状态与宿主命令，不承担模型、权限或执行状态的重建。 */
export function DesktopComposer({
  state,
  controller,
  onSettings,
  inputRef,
  variant = "composer",
}: {
  state: WorkspaceViewState;
  controller: WorkspaceController;
  onSettings: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  variant?: "hero" | "composer";
}) {
  const id = useId();
  const composing = useRef(false);
  const snapshot = state.snapshot;
  const session = selectedSession(state);
  const locked = isLocked(state);
  const running = isRunning(state);
  const unfinished = session?.unfinished;
  const waiting = snapshot?.status === "waiting";
  const workspaceMissing = !snapshot?.workspace;
  const workspaceTrigger = workspaceMissing && !locked && !waiting;
  const needsResume = Boolean(unfinished && !waiting && !running);
  const stoppable = Boolean(unfinished || running);
  const actionLabel = stoppable ? "停止任务" : "发送任务";
  const modelId = session ? session.modelId : state.newModelId;
  const model = state.models.find((item) => item.id === modelId);
  const unavailable = !model || model.availability?.state === "unavailable";
  const modelRunning = running || snapshot?.status === "running";
  const modelLocked = workspaceMissing || locked || modelRunning || waiting || Boolean(unfinished);
  const modelHint = workspaceMissing
    ? "请先选择工作区"
    : state.loading
      ? "正在加载模型"
      : state.pending
        ? "请等待当前操作完成"
        : modelRunning
          ? "任务执行期间不能切换模型"
          : waiting || unfinished
            ? "请先继续或停止未完成的任务，再切换模型"
            : model?.label;
  const draft = state.drafts[draftKey(state)] ?? "";
  const status = state.loading
    ? "正在加载"
    : state.pending
      ? "正在处理"
      : needsResume
        ? "任务未完成，可继续或停止"
        : !state.composingNew && snapshot
          ? statuses[snapshot.status]
          : "";
  const draftHint = waiting
    ? "可编辑草稿，审批完成前暂不能发送。"
    : needsResume
      ? "可编辑草稿，请先继续或停止当前任务。"
      : running || state.pending
        ? "可编辑草稿，当前任务结束后才能发送。"
        : "";
  const modelOptions: SelectOption[] = state.models.map((item) => ({
    value: item.id,
    label: `${item.label}${item.availability?.state === "unavailable" ? "（不可用）" : ""}`,
    displayLabel: item.modelName
      ? `${item.modelName}${item.availability?.state === "unavailable" ? "（不可用）" : ""}`
      : undefined,
    group: item.vendor,
    disabled: item.availability?.state === "unavailable",
  }));
  if (modelId && !model)
    modelOptions.push({ value: modelId, label: `${modelId}（原绑定，已不可用）`, disabled: true });

  function send() {
    if (workspaceMissing || !canSubmit(state) || composing.current) return;
    void controller.send();
  }

  return (
    <form
      className="desktop-composer"
      data-variant={variant}
      aria-label="发送任务"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div
        className="desktop-composer-card"
        data-workspace-trigger={workspaceTrigger || undefined}
        onClick={(event) => {
          if (
            !(event.target instanceof Element) ||
            event.target.closest("button, input, select, a, [popover], [role='combobox']")
          )
            return;
          if (workspaceTrigger) void controller.chooseWorkspace();
          else if (!event.target.closest("textarea")) inputRef.current?.focus();
        }}
      >
        <textarea
          ref={inputRef}
          className="desktop-composer-input"
          aria-label={workspaceMissing ? "选择工作区后输入任务" : "任务输入"}
          aria-describedby={`${id}-keyboard${status || draftHint ? ` ${id}-status` : ""}${unavailable ? ` ${id}-model` : ""}`}
          placeholder={workspaceMissing ? "选择工作区以开始…" : "发消息或创建任务"}
          title={workspaceMissing ? "选择工作区" : "Enter 发送 · Shift+Enter 换行"}
          rows={1}
          value={draft}
          disabled={state.loading}
          readOnly={workspaceMissing}
          onChange={(event) => controller.setDraft(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (workspaceMissing) {
              if (
                workspaceTrigger &&
                (event.key === "Enter" || event.key === " ") &&
                !event.nativeEvent.isComposing &&
                !composing.current &&
                event.nativeEvent.keyCode !== 229
              ) {
                event.preventDefault();
                void controller.chooseWorkspace();
              }
              return;
            }
            if (
              event.key !== "Enter" ||
              event.shiftKey ||
              event.ctrlKey ||
              event.altKey ||
              event.metaKey ||
              event.nativeEvent.isComposing ||
              composing.current ||
              event.nativeEvent.keyCode === 229
            )
              return;
            event.preventDefault();
            send();
          }}
        />
        <div className="desktop-composer-toolbar">
          <ComposerTools
            mode={session?.toolsMode ?? NEW_SESSION_TOOLS_MODE}
            disabled={locked || waiting}
            workspaceMissing={workspaceMissing}
            onNewSession={controller.newSession}
            onChooseWorkspace={controller.chooseWorkspace}
            onSettings={onSettings}
          />
          <div className="desktop-composer-trailing">
            <div className="desktop-composer-model" title={modelHint}>
              <Select
                aria-label="当前模型"
                aria-describedby={unavailable ? `${id}-model` : undefined}
                variant="chip"
                align="end"
                placeholder="请选择模型"
                value={modelId ?? ""}
                valueLabel={model?.modelName || model?.label}
                options={modelOptions}
                disabled={modelLocked}
                onValueChange={(value) => {
                  if (state.composingNew) controller.setNewModel(value);
                  else void controller.selectModel(value);
                }}
              />
            </div>
            <button
              className="desktop-composer-send"
              type="button"
              aria-label={actionLabel}
              title={actionLabel}
              disabled={
                workspaceMissing || (stoppable ? state.pending || state.loading : !canSubmit(state))
              }
              onMouseDown={(event) => {
                if (event.button === 0) event.preventDefault();
              }}
              onClick={() => {
                if (stoppable) void controller.cancel();
                else send();
              }}
            >
              {stoppable ? (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <rect x="3" y="3" width="10" height="10" rx="3" />
                </svg>
              ) : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M8 15V2m-6 5 6-6 6 6" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
      {unavailable && (
        <p className="desktop-composer-model-hint" id={`${id}-model`} role="status">
          {session
            ? "此会话的模型不可用，请切换可用模型或检查连接。"
            : state.models.length
              ? "请选择可用模型。"
              : "添加模型后即可开始。"}
          <button
            className="desktop-composer-settings"
            type="button"
            disabled={locked || waiting}
            onClick={onSettings}
          >
            模型设置
          </button>
        </p>
      )}
      <p className="desktop-composer-keyboard" id={`${id}-keyboard`}>
        {workspaceMissing ? "Enter 或空格选择工作区" : "Enter 发送 · Shift+Enter 换行"}
      </p>
      {(status || draftHint) && (
        <p className="desktop-composer-status" id={`${id}-status`} role="status">
          {status}
          {status && draftHint ? " · " : ""}
          {draftHint}
        </p>
      )}
    </form>
  );
}
