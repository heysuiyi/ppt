import { getWorkspaceLabel } from "@shared/workspace";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { InteractionCardHost } from "../cards/hosts/InteractionCardHost";
import { PermissionCardHost } from "../cards/hosts/PermissionCardHost";
import { CHAT_WORKSPACE_COPY_ZH_CN as copy, getChatPromptTemplates } from "./chat-workspace-copy";
import type {
  ChatRegionState,
  ChatWorkspaceActions,
  ChatWorkspaceDeck,
  ChatWorkspaceInputRuntime,
  ChatWorkspaceRun,
  ChatWorkspaceComposer as ComposerData,
} from "./chat-workspace-types";
import { CheckIcon, ChevronDownIcon, FolderIcon, SendIcon, StopIcon } from "./Icons";
import { RunStatusIndicator } from "./RunStatusIndicator";

interface ChatWorkspaceComposerProps {
  state: ChatRegionState;
  composer: ComposerData;
  run: ChatWorkspaceRun;
  deck: ChatWorkspaceDeck;
  actions: ChatWorkspaceActions;
  runtime: ChatWorkspaceInputRuntime;
}

function resizeTextarea(textarea: HTMLTextAreaElement) {
  const minHeight = Number.parseFloat(getComputedStyle(textarea).minHeight) || 52;
  textarea.style.height = "auto";
  const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), 180);
  textarea.style.height = `${nextHeight}px`;
}

export function ChatWorkspaceComposer({
  state,
  composer,
  run,
  deck,
  actions,
  runtime,
}: ChatWorkspaceComposerProps): ReactNode {
  const centered = state.phase === "welcome";
  const locked = state.availability !== "ready" || run.busy;
  const workspaceBound = state.workspace.kind === "bound";
  const workspacePath = state.workspace.path;
  const viewingTeamSession = state.focus.kind !== "main";
  const {
    request,
    onChangeRequest,
    onSubmitRequest,
    models,
    selectedModelId,
    onSelectModel: setSelectedModelId,
    onPrepareWorkspace,
  } = composer;
  const {
    busy,
    onCancel: onCancelRun,
    isCancelling: isCancellingRun = false,
    phase: agentRunPhase,
    activityTrace,
  } = run;
  const { pendingToolApproval, canCancelRun, runStartedAt } = runtime;
  const { onResolveToolApproval } = actions;
  const showSlashMenu = request.startsWith("/");
  const promptTemplates = useMemo(
    () => getChatPromptTemplates(deck.presentation, deck.selectedSlideId),
    [deck.presentation, deck.selectedSlideId],
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const selectedModel = models.find((model) => model.id === selectedModelId) ?? models[0];
  const isPermissionGateOpen = Boolean(pendingToolApproval && onResolveToolApproval);

  const handleSend = () => {
    if (locked || !request.trim() || models.length === 0) return;
    onSubmitRequest();
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      handleSend();
    }
  };

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (!request.trim()) {
      textarea.style.height = "";
      return;
    }
    resizeTextarea(textarea);
  }, [request]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!modelMenuRef.current?.contains(event.target as Node)) setModelMenuOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModelMenuOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [modelMenuOpen]);

  return (
    <div
      data-ui-region="composer"
      className={
        centered ? "center-focal-content-area" : "right-panel-footer chat-workspace-footer-unified"
      }
    >
      <div
        className={
          centered ? "center-focal-composer" : "chat-conversation-shell chat-conversation-footer"
        }
      >
        {!centered && showSlashMenu && !locked && !runtime.pendingToolApproval && (
          <div className="slash-menu-popup" role="listbox" aria-label={copy.promptTemplateAria}>
            <div className="slash-menu-header">{copy.promptTemplateHeader}</div>
            {promptTemplates.map((template) => (
              <button
                type="button"
                key={template.command}
                className="slash-menu-item"
                onClick={() => onChangeRequest(template.command)}
              >
                <span className="cmd-text">{template.command}</span>
                <span className="cmd-desc">{template.description}</span>
              </button>
            ))}
          </div>
        )}

        <div>
          {!centered && (
            <InteractionCardHost
              host="composer-before-input"
              busy={run.busy}
              onResolveQuestion={actions.onResolveQuestion}
            />
          )}
          {!centered && viewingTeamSession && !runtime.pendingToolApproval && (
            <div className="team-focus-composer-note">{copy.teammateComposerNote}</div>
          )}
          <div
            className={`unified-agent-input-container ${centered ? "center-focal-mode" : "bottom-anchored-mode"}`}
          >
            {centered ? (
              <div className="center-welcome-header">
                <h1 className="center-welcome-title">Agent PPT</h1>
                <p className="center-welcome-subtitle">
                  说明受众、场景和核心结论，从零生成一套演示文稿。
                </p>
              </div>
            ) : null}

            <div className="unified-agent-input-stack">
              {centered && !workspaceBound && !workspacePath && (
                <section
                  className="sandbox-preflight-card"
                  aria-labelledby="sandbox-preflight-title"
                >
                  <div className="sandbox-preflight-icon">
                    <FolderIcon size={18} />
                  </div>
                  <div className="sandbox-preflight-copy">
                    <strong id="sandbox-preflight-title">项目目录（可选）</strong>
                    <span>可直接发送，系统会自动创建托管沙箱；也可以先选择保存目录。</span>
                  </div>
                  <button
                    type="button"
                    className="sandbox-preflight-btn"
                    onClick={onPrepareWorkspace}
                    disabled={locked}
                  >
                    选择项目目录
                  </button>
                </section>
              )}
              {centered && (workspacePath || workspaceBound) && (
                <div className="composer-workspace" aria-label="项目目录">
                  <span className="composer-workspace-label">
                    {workspaceBound ? "已绑定目录" : "保存目录"}
                  </span>
                  <span className="composer-workspace-path" title={workspacePath}>
                    {workspacePath ? getWorkspaceLabel(workspacePath) : "托管空间"}
                  </span>
                  {!workspaceBound && (
                    <button
                      type="button"
                      className="sandbox-preflight-btn"
                      disabled={locked}
                      onClick={onPrepareWorkspace}
                    >
                      更换
                    </button>
                  )}
                </div>
              )}
              <div
                className="double-deck-panel-card unified-agent-input-shell"
                data-action-state={
                  isPermissionGateOpen ? "permission" : busy ? "running" : "composing"
                }
              >
                {isPermissionGateOpen && (
                  <div className="tool-approval-attached">
                    <PermissionCardHost
                      approval={pendingToolApproval}
                      onResolve={onResolveToolApproval}
                    />
                  </div>
                )}

                <div className="input-textarea-row">
                  <textarea
                    ref={textareaRef}
                    value={request}
                    onChange={(event) => {
                      onChangeRequest(event.target.value);
                      resizeTextarea(event.target);
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder={
                      centered
                        ? "例如：做一份面向管理层的季度汇报，8 页左右…"
                        : "继续描述修改目标，或提出新的演示需求…"
                    }
                    readOnly={locked}
                    autoFocus
                    rows={centered ? 3 : 2}
                    className={`input-textarea${busy ? " input-textarea--busy" : ""}`}
                    aria-label="向演示文稿 Agent 输入指令"
                  />
                </div>

                <div className="functional-control-bar">
                  <div className="functional-left">
                    {busy ? (
                      <RunStatusIndicator
                        phase={agentRunPhase}
                        activityTrace={activityTrace}
                        startedAt={runStartedAt}
                      />
                    ) : null}
                  </div>

                  <div className="functional-right">
                    <div
                      ref={modelMenuRef}
                      className={`model-tier-select-wrapper${modelMenuOpen ? " is-open" : ""}${locked || models.length === 0 ? " is-disabled" : ""}`}
                    >
                      <button
                        type="button"
                        className="mini-model-select"
                        disabled={locked || models.length === 0}
                        aria-haspopup="listbox"
                        aria-expanded={modelMenuOpen}
                        onClick={() => setModelMenuOpen((open) => !open)}
                      >
                        <span>{selectedModel?.name ?? "选择模型"}</span>
                        <ChevronDownIcon size={12} className="model-tier-select-icon" />
                      </button>

                      {modelMenuOpen && !locked && models.length > 0 ? (
                        <div className="model-tier-menu" role="listbox" aria-label="选择智能体模型">
                          {models.map((model) => {
                            const selected = model.id === selectedModelId;
                            return (
                              <button
                                key={model.id}
                                type="button"
                                role="option"
                                aria-selected={selected}
                                className={`model-tier-option${selected ? " is-selected" : ""}`}
                                onClick={() => {
                                  setSelectedModelId(model.id);
                                  setModelMenuOpen(false);
                                }}
                              >
                                <span className="model-tier-option-name">{model.name}</span>
                                {selected ? (
                                  <CheckIcon size={11} className="model-tier-option-check" />
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>

                    <button
                      type="button"
                      onClick={canCancelRun && onCancelRun ? onCancelRun : handleSend}
                      disabled={
                        canCancelRun
                          ? isCancellingRun
                          : locked || !request.trim() || models.length === 0
                      }
                      className={
                        canCancelRun
                          ? "stop-cta-btn"
                          : `send-cta-btn${
                              !locked && request.trim() && models.length > 0 ? " is-ready" : ""
                            }`
                      }
                      aria-label={canCancelRun ? "中止当前 Agent 会话" : "发送指令"}
                      title={canCancelRun ? "中止当前 Agent 会话" : "发送指令（Enter）"}
                    >
                      {canCancelRun ? <StopIcon size={13} /> : <SendIcon size={15} />}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        {centered && (
          <div className="center-suggestions">
            {copy.suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="suggestion-chip"
                disabled={locked}
                title="填入输入框，确认后发送"
                onClick={() => composer.onProposePrompt(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
