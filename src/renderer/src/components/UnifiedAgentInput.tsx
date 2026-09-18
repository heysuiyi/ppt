import type { AgentActivityItem } from "@shared/agent-activity";
import type { AgentRunPhase } from "@shared/agent-run-presentation";
import { getWorkspaceLabel } from "@shared/workspace";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { EnvironmentCardHost } from "../cards/hosts/EnvironmentCardHost";
import { PermissionCardHost } from "../cards/hosts/PermissionCardHost";
import type { ManagedModel } from "../modelCatalog";
import { CheckIcon, ChevronDownIcon, SendIcon, StopIcon } from "./Icons";
import { RunStatusIndicator } from "./RunStatusIndicator";
import type { PendingToolApproval } from "./ToolApprovalOverlay";

interface UnifiedAgentInputProps {
  request: string;
  onChangeRequest: (value: string) => void;
  onSubmitRequest: () => void;
  busy: boolean;
  models: ManagedModel[];
  selectedModelId: string;
  setSelectedModelId: (value: string) => void;
  layoutMode: "center" | "bottom";
  pendingToolApproval?: PendingToolApproval | null;
  onResolveToolApproval?: (approvalId: string, approved: boolean) => void;
  canCancelRun?: boolean;
  onCancelRun?: () => void;
  isCancellingRun?: boolean;
  workspacePath?: string;
  workspaceBound?: boolean;
  disabled?: boolean;
  onPrepareWorkspace?: () => void;
  agentRunPhase?: AgentRunPhase;
  activityTrace?: AgentActivityItem[];
  runStartedAt?: number;
}

function resizeTextarea(textarea: HTMLTextAreaElement) {
  const minHeight = Number.parseFloat(getComputedStyle(textarea).minHeight) || 52;
  textarea.style.height = "auto";
  const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), 180);
  textarea.style.height = `${nextHeight}px`;
}

export const UnifiedAgentInput: React.FC<UnifiedAgentInputProps> = ({
  request,
  onChangeRequest,
  onSubmitRequest,
  busy,
  models,
  selectedModelId,
  setSelectedModelId,
  layoutMode,
  pendingToolApproval = null,
  onResolveToolApproval,
  canCancelRun = false,
  onCancelRun,
  isCancellingRun = false,
  workspacePath = "",
  workspaceBound = false,
  disabled = false,
  onPrepareWorkspace,
  agentRunPhase = "idle",
  activityTrace = [],
  runStartedAt,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const selectedModel = models.find((model) => model.id === selectedModelId) ?? models[0];
  const isPermissionGateOpen = Boolean(pendingToolApproval && onResolveToolApproval);

  const handleSend = () => {
    if (busy || disabled || !request.trim() || models.length === 0) return;
    onSubmitRequest();
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
      className={`unified-agent-input-container ${layoutMode === "center" ? "center-focal-mode" : "bottom-anchored-mode"}`}
      data-ui-region="composer"
    >
      {layoutMode === "center" ? (
        <div className="center-welcome-header">
          <h1 className="center-welcome-title">Agent PPT</h1>
          <p className="center-welcome-subtitle">
            说明受众、场景和核心结论，从零生成一套演示文稿。
          </p>
        </div>
      ) : null}

      <div className="unified-agent-input-stack">
        <EnvironmentCardHost
          ready={layoutMode !== "center" || Boolean(workspacePath) || workspaceBound}
          onPrepare={onPrepareWorkspace}
          disabled={busy || disabled}
        />
        {layoutMode === "center" && (workspacePath || workspaceBound) && (
          <div className="composer-workspace" aria-label="项目目录">
            <span className="composer-workspace-label">
              {workspaceBound ? "已绑定目录" : "保存目录"}
            </span>
            <span className="composer-workspace-path" title={workspacePath}>
              {workspacePath ? getWorkspaceLabel(workspacePath) : "托管空间"}
            </span>
            {!workspaceBound && onPrepareWorkspace && (
              <button
                type="button"
                className="sandbox-preflight-btn"
                disabled={busy || disabled}
                onClick={onPrepareWorkspace}
              >
                更换
              </button>
            )}
          </div>
        )}
        <div
          className="double-deck-panel-card unified-agent-input-shell"
          data-action-state={isPermissionGateOpen ? "permission" : busy ? "running" : "composing"}
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
                layoutMode === "center"
                  ? "例如：做一份面向管理层的季度汇报，8 页左右…"
                  : "继续描述修改目标，或提出新的演示需求…"
              }
              readOnly={busy || disabled}
              autoFocus
              rows={layoutMode === "center" ? 3 : 2}
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
                className={`model-tier-select-wrapper${modelMenuOpen ? " is-open" : ""}${busy || disabled || models.length === 0 ? " is-disabled" : ""}`}
              >
                <button
                  type="button"
                  className="mini-model-select"
                  disabled={busy || disabled || models.length === 0}
                  aria-haspopup="listbox"
                  aria-expanded={modelMenuOpen}
                  onClick={() => setModelMenuOpen((open) => !open)}
                >
                  <span>{selectedModel?.name ?? "选择模型"}</span>
                  <ChevronDownIcon size={12} className="model-tier-select-icon" />
                </button>

                {modelMenuOpen && !busy && !disabled && models.length > 0 ? (
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
                    : busy || disabled || !request.trim() || models.length === 0
                }
                className={
                  canCancelRun
                    ? "stop-cta-btn"
                    : `send-cta-btn${
                        !busy && !disabled && request.trim() && models.length > 0 ? " is-ready" : ""
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
  );
};
