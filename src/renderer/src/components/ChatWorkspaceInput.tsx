import type React from "react";
import type {
  ChatWorkspaceActions,
  ChatWorkspaceComposer,
  ChatWorkspaceInputRuntime,
  ChatWorkspaceRun,
  ChatWorkspaceViewState,
} from "./chat-workspace-types";
import { UnifiedAgentInput } from "./UnifiedAgentInput";

interface ChatWorkspaceInputProps {
  view: ChatWorkspaceViewState;
  composer: ChatWorkspaceComposer;
  run: ChatWorkspaceRun;
  actions: ChatWorkspaceActions;
  runtime: ChatWorkspaceInputRuntime;
}

export const ChatWorkspaceInput: React.FC<ChatWorkspaceInputProps> = ({
  view,
  composer,
  run,
  actions,
  runtime,
}) => (
  <UnifiedAgentInput
    request={composer.request}
    onChangeRequest={composer.onChangeRequest}
    onSubmitRequest={composer.onSubmitRequest}
    busy={run.busy}
    models={composer.models}
    selectedModelId={composer.selectedModelId}
    setSelectedModelId={composer.onSelectModel}
    layoutMode={view.phase === "welcome" ? "center" : "bottom"}
    pendingToolApproval={runtime.pendingToolApproval}
    onResolveToolApproval={actions.onResolveToolApproval}
    canCancelRun={runtime.canCancelRun}
    onCancelRun={run.onCancel}
    isCancellingRun={run.isCancelling ?? false}
    workspacePath={composer.workspacePath}
    workspaceBound={view.workspaceBound}
    disabled={view.inputDisabled}
    onPrepareWorkspace={composer.onPrepareWorkspace}
    agentRunPhase={run.phase}
    activityTrace={run.activityTrace}
    runStartedAt={runtime.runStartedAt}
  />
);
