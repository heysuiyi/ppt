import type { AgentActivityItem } from "@shared/agent-activity";
import type { AgentQuestionResolved } from "@shared/agent-question";
import type { AgentRunPhase } from "@shared/agent-run-presentation";
import type { DisplayEvent } from "@shared/card-display-protocol";
import type { Presentation } from "@shared/presentation";
import type { SessionChatMessage } from "@shared/session";
import type { ManagedModel } from "../modelCatalog";

export type ChatMessage = SessionChatMessage;
export type QuestionEvent = Extract<DisplayEvent, { kind: "interaction.question-requested" }>;
export type CommandProposalEvent = Extract<DisplayEvent, { kind: "review.command-proposal" }>;
export type PatchEvent = Extract<DisplayEvent, { kind: "review.patch-ready" }>;
export type ArtifactEvent = Extract<DisplayEvent, { kind: "artifact.ready" }>;

export interface ChatWorkspaceSession {
  id: string;
  isLoading?: boolean;
  isSwitching?: boolean;
  conversationTitle?: string;
  messages: ChatMessage[];
}

export interface ChatRegionState {
  phase: "welcome" | "entering" | "conversation";
  availability: "ready" | "loading" | "switching";
  workspace: { kind: "draft"; path: string } | { kind: "bound"; path: string };
  focus: { kind: "main" } | { kind: "team-session"; sessionId: string };
}

export interface ChatWorkspaceRun {
  activityTrace: AgentActivityItem[];
  phase: AgentRunPhase;
  streamingMessageId?: string | null;
  busy: boolean;
  activeRunId?: string | null;
  onCancel?: () => void;
  isCancelling?: boolean;
  onRetry?: (messageId: string) => void;
}

export interface ChatWorkspaceComposer {
  request: string;
  onChangeRequest: (value: string) => void;
  onSubmitRequest: () => void;
  models: ManagedModel[];
  selectedModelId: string;
  onSelectModel: (value: string) => void;
  workspacePath: string;
  onPrepareWorkspace: () => void;
  onProposePrompt: (prompt: string) => void;
}

export interface ChatWorkspaceDeck {
  presentation?: Presentation;
  selectedSlideId?: string;
  isMirrorOpen: boolean;
  onToggleMirror: () => void;
  onOpenPreview: () => void;
  onExport: () => void;
  isExporting?: boolean;
  onFocusAffectedSlides?: (slideIds: string[]) => void;
}

export interface ChatWorkspaceActions {
  onResolveApproval: (event: CommandProposalEvent, approved: boolean) => void;
  onResolvePatch: (event: PatchEvent, accepted: boolean) => void;
  onResolveQuestion: (event: QuestionEvent, resolved: AgentQuestionResolved) => void;
  onResolveToolApproval?: (approvalId: string, approved: boolean) => void;
  onReviseOutline: (event: ArtifactEvent) => void;
  onUpdateMessageContent: (messageId: string, newContent: string) => void;
  notify: (message: string) => void;
}

export interface ChatWorkspaceProps {
  session: ChatWorkspaceSession;
  run: ChatWorkspaceRun;
  composer: ChatWorkspaceComposer;
  deck: ChatWorkspaceDeck;
  actions: ChatWorkspaceActions;
}

export interface PendingToolApprovalView {
  approvalId: string;
  toolName: string;
  reason: string;
  detail: string;
}

export interface ChatWorkspaceInputRuntime {
  pendingToolApproval: PendingToolApprovalView | null;
  canCancelRun: boolean;
  runStartedAt?: number;
}
