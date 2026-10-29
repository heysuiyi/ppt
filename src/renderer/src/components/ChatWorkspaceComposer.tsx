import { getWorkspaceLabel } from "@shared/workspace";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { InteractionCardHost } from "../cards/hosts/InteractionCardHost";
import { PermissionCardHost } from "../cards/hosts/PermissionCardHost";
import { Button, IconButton } from "./Button";
import { CHAT_WORKSPACE_COPY_ZH_CN as copy, getChatPromptTemplates } from "./chat-workspace-copy";
import type {
  ChatRegionState,
  ChatWorkspaceActions,
  ChatWorkspaceDeck,
  ChatWorkspaceInputRuntime,
  ChatWorkspaceRun,
  ChatWorkspaceComposer as ComposerData,
} from "./chat-workspace-types";
import { Textarea } from "./Field";
import { FolderIcon, SendIcon, StopIcon } from "./Icons";
import { useOverlayOwner } from "./overlay-lifecycle";
import { usePopoverPosition } from "./popover-position";
import { RunStatusIndicator } from "./RunStatusIndicator";
import { Select } from "./Select";

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
  const { pendingToolApproval, canCancelRun } = runtime;
  const { onResolveToolApproval } = actions;
  const [dismissedSlashRequest, setDismissedSlashRequest] = useState<string | null>(null);
  const [activeTemplate, setActiveTemplate] = useState(0);
  const slashListId = useId();
  const showSlashMenu =
    !centered &&
    request.startsWith("/") &&
    dismissedSlashRequest !== request &&
    !locked &&
    !runtime.pendingToolApproval;
  const promptTemplates = useMemo(
    () => getChatPromptTemplates(deck.presentation, deck.selectedSlideId),
    [deck.presentation, deck.selectedSlideId],
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const overlayOwner = useOverlayOwner();
  const slashPosition = usePopoverPosition(
    showSlashMenu,
    slashMenuRef,
    () => textareaRef.current?.getBoundingClientRect() ?? null,
    "above",
  );
  const isPermissionGateOpen = Boolean(pendingToolApproval && onResolveToolApproval);

  const handleSend = () => {
    if (locked || !request.trim() || models.length === 0) return;
    onSubmitRequest();
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const completeTemplate = (index: number) => {
    const template = promptTemplates[index];
    if (!template) return;
    onChangeRequest(template.command);
    setDismissedSlashRequest(template.command);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (showSlashMenu) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedSlashRequest(request);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActiveTemplate(
          (index) =>
            (index + (event.key === "ArrowDown" ? 1 : promptTemplates.length - 1)) %
            promptTemplates.length,
        );
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        completeTemplate(activeTemplate);
        return;
      }
    }
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
    setActiveTemplate((index) => Math.min(index, promptTemplates.length - 1));
  }, [promptTemplates.length]);

  useEffect(() => {
    if (showSlashMenu)
      document
        .getElementById(`${slashListId}-${activeTemplate}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [activeTemplate, showSlashMenu, slashListId]);

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
        {showSlashMenu &&
          createPortal(
            <div
              ref={slashMenuRef}
              id={slashListId}
              className="slash-menu-popup"
              role="listbox"
              aria-label={copy.promptTemplateAria}
              style={
                slashPosition
                  ? {
                      top: slashPosition.top,
                      left: slashPosition.left,
                      width: slashPosition.width,
                      maxHeight: slashPosition.maxHeight,
                    }
                  : { visibility: "hidden" }
              }
            >
              <div className="slash-menu-header" role="presentation">
                {copy.promptTemplateHeader}
              </div>
              {promptTemplates.map((template, index) => (
                <button
                  type="button"
                  key={template.command}
                  id={`${slashListId}-${index}`}
                  role="option"
                  aria-selected={index === activeTemplate}
                  tabIndex={-1}
                  className={`slash-menu-item${index === activeTemplate ? " is-active" : ""}`}
                  onPointerDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveTemplate(index)}
                  onClick={() => completeTemplate(index)}
                >
                  <span className="cmd-text">{template.command}</span>
                  <span className="cmd-desc">{template.description}</span>
                </button>
              ))}
            </div>,
            overlayOwner.portalHost ?? document.body,
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
                  <Button
                    variant="primary"
                    size="sm"
                    className="sandbox-preflight-btn"
                    onClick={onPrepareWorkspace}
                    disabled={locked}
                  >
                    选择项目目录
                  </Button>
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
                    <Button
                      variant="primary"
                      size="sm"
                      className="sandbox-preflight-btn"
                      disabled={locked}
                      onClick={onPrepareWorkspace}
                    >
                      更换
                    </Button>
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
                  <Textarea
                    ref={textareaRef}
                    value={request}
                    onChange={(event) => {
                      onChangeRequest(event.target.value);
                      setDismissedSlashRequest(null);
                      setActiveTemplate(0);
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
                    role="combobox"
                    aria-autocomplete="list"
                    aria-haspopup="listbox"
                    aria-expanded={showSlashMenu}
                    aria-controls={showSlashMenu ? slashListId : undefined}
                    aria-activedescendant={
                      showSlashMenu ? `${slashListId}-${activeTemplate}` : undefined
                    }
                  />
                </div>

                <div className="functional-control-bar">
                  <div className="functional-left">
                    {busy ? (
                      <RunStatusIndicator phase={agentRunPhase} activityTrace={activityTrace} />
                    ) : null}
                  </div>

                  <div className="functional-right">
                    <Select
                      variant="compact"
                      placement={centered ? "below" : "above"}
                      value={selectedModelId}
                      onChange={setSelectedModelId}
                      options={models.map((model) => ({ value: model.id, label: model.name }))}
                      placeholder="选择模型"
                      disabled={locked || models.length === 0}
                      ariaLabel="选择智能体模型"
                    />

                    <IconButton
                      variant={canCancelRun ? "danger" : "primary"}
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
                    </IconButton>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        {centered && (
          <div className="center-suggestions">
            {copy.suggestions.map((suggestion) => (
              <Button
                variant="secondary"
                size="sm"
                key={suggestion}
                className="suggestion-chip"
                disabled={locked}
                title="填入输入框，确认后发送"
                onClick={() => composer.onProposePrompt(suggestion)}
              >
                {suggestion}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
