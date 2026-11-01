/** 独立预览的会话展示状态，不是 Harness 的执行记录或配置协议。 */
export interface PreviewWorkspace {
  id: string;
  name: string;
}
export interface PreviewModel {
  id: string;
  name: string;
  connectionId: string;
  enabled: boolean;
}
export interface PreviewUserMessage {
  id: number;
  text: string;
  modelId: string;
}
export interface WorkspaceThread {
  id: string;
  workspaceId: string;
  title: string;
  draft: string;
  modelId: string;
  messages: PreviewUserMessage[];
}
export interface WorkspaceState {
  workspaces: PreviewWorkspace[];
  models: PreviewModel[];
  threads: WorkspaceThread[];
  activeThreadId: string;
  nextThreadId: number;
  nextMessageId: number;
}
export type WorkspaceAction =
  | { type: "new-thread"; workspaceId: string }
  | { type: "select-thread"; threadId: string }
  | { type: "select-workspace"; workspaceId: string }
  | { type: "draft"; threadId: string; value: string }
  | { type: "select-model"; threadId: string; modelId: string }
  | { type: "set-model-enabled"; modelId: string; enabled: boolean }
  | { type: "send"; threadId: string };

export function createWorkspaceState(): WorkspaceState {
  return {
    workspaces: [
      { id: "workspace-default", name: "默认工作区" },
      { id: "workspace-design", name: "界面设计" },
    ],
    models: [
      { id: "atlas-chat", name: "Atlas Chat", connectionId: "atlas", enabled: true },
      { id: "cedar-chat", name: "Cedar Chat", connectionId: "cedar", enabled: true },
    ],
    threads: [
      {
        id: "thread-1",
        workspaceId: "workspace-default",
        title: "新会话",
        draft: "",
        modelId: "atlas-chat",
        messages: [],
      },
      {
        id: "thread-2",
        workspaceId: "workspace-design",
        title: "新会话",
        draft: "",
        modelId: "cedar-chat",
        messages: [],
      },
    ],
    activeThreadId: "thread-1",
    nextThreadId: 3,
    nextMessageId: 1,
  };
}

export function getActiveThread(state: WorkspaceState): WorkspaceThread {
  return state.threads.find((thread) => thread.id === state.activeThreadId)!;
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "new-thread": {
      if (!state.workspaces.some((workspace) => workspace.id === action.workspaceId)) return state;
      const thread: WorkspaceThread = {
        id: `thread-${state.nextThreadId}`,
        workspaceId: action.workspaceId,
        title: "新会话",
        draft: "",
        modelId: state.models.find((model) => model.enabled)?.id ?? "",
        messages: [],
      };
      return {
        ...state,
        threads: [thread, ...state.threads],
        activeThreadId: thread.id,
        nextThreadId: state.nextThreadId + 1,
      };
    }
    case "select-thread":
      return state.threads.some((thread) => thread.id === action.threadId)
        ? { ...state, activeThreadId: action.threadId }
        : state;
    case "select-workspace": {
      const target = state.threads.find((thread) => thread.workspaceId === action.workspaceId);
      return target ? { ...state, activeThreadId: target.id } : state;
    }
    case "set-model-enabled":
      // 隐藏当前模型不能暗中改选另一个；草稿和历史消息仍绑定原模型身份。
      return {
        ...state,
        models: state.models.map((model) =>
          model.id === action.modelId ? { ...model, enabled: action.enabled } : model,
        ),
      };
    case "draft":
      return {
        ...state,
        threads: state.threads.map((thread) =>
          thread.id === action.threadId ? { ...thread, draft: action.value } : thread,
        ),
      };
    case "select-model":
      if (!state.models.some((model) => model.id === action.modelId && model.enabled)) return state;
      return {
        ...state,
        threads: state.threads.map((thread) =>
          thread.id === action.threadId ? { ...thread, modelId: action.modelId } : thread,
        ),
      };
    case "send": {
      const thread = state.threads.find((item) => item.id === action.threadId);
      const text = thread?.draft.trim();
      if (
        !thread ||
        !text ||
        !state.models.some((model) => model.id === thread.modelId && model.enabled)
      )
        return state;
      const message: PreviewUserMessage = {
        id: state.nextMessageId,
        text,
        modelId: thread.modelId,
      };
      return {
        ...state,
        nextMessageId: state.nextMessageId + 1,
        threads: state.threads.map((item) =>
          item.id === thread.id
            ? {
                ...item,
                title: item.messages.length ? item.title : text.split(/\r?\n/, 1)[0],
                draft: "",
                messages: [...item.messages, message],
              }
            : item,
        ),
      };
    }
  }
}
