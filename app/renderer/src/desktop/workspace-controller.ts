import type {
  HarnessDesktopApi,
  HarnessDesktopEvent,
  HarnessError,
  HarnessIdentity,
  HarnessModel,
  HarnessReply,
  HarnessSnapshot,
  HarnessToolDisplay,
} from "../../../shared/harness-ipc";

/** 桌面新会话的固定能力配置；展示与签发请求使用同一来源。 */
export const NEW_SESSION_TOOLS_MODE = "read-write" as const;

export interface WorkspaceToolProgress {
  readonly identity: HarnessIdentity;
  readonly invocationIdentity?: HarnessIdentity;
  readonly step?: number;
  readonly callId: string;
  readonly name: string;
  readonly status: "dispatched" | "completed" | "failed" | "unknown";
  readonly display?: HarnessToolDisplay;
  readonly effects?: "none" | "applied" | "unknown";
  readonly error?: HarnessError;
}

export interface WorkspaceViewState {
  readonly snapshot: HarnessSnapshot | null;
  readonly models: readonly HarnessModel[];
  readonly drafts: Readonly<Record<string, string>>;
  readonly composingNew: boolean;
  readonly newModelId: string;
  readonly pending: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly preview: {
    readonly identity: HarnessIdentity;
    readonly text: string;
    readonly reasoning: string;
  } | null;
  readonly toolProgress: readonly WorkspaceToolProgress[];
}

export interface WorkspaceController {
  getState(): WorkspaceViewState;
  subscribe(listener: () => void): () => void;
  start(): () => void;
  refreshModels(): Promise<void>;
  setDraft(text: string): void;
  setNewModel(modelId: string): void;
  selectModel(modelId: string): Promise<void>;
  newSession(): void;
  chooseWorkspace(): Promise<void>;
  selectWorkspace(id: string): Promise<void>;
  selectSession(id: string): Promise<void>;
  send(): Promise<void>;
  resume(choiceId?: "allow" | "reject"): Promise<void>;
  cancel(): Promise<void>;
}

export function selectedSession(state: WorkspaceViewState) {
  return state.composingNew
    ? undefined
    : state.snapshot?.sessions.find((session) => session.id === state.snapshot?.selectedSessionId);
}

export function draftKey(state: WorkspaceViewState): string {
  return selectedSession(state)?.id ?? `new:${state.snapshot?.workspace?.id ?? "none"}`;
}

export function isRunning(state: WorkspaceViewState): boolean {
  return state.snapshot?.activeRun != null;
}

export function isLocked(state: WorkspaceViewState): boolean {
  return state.loading || state.pending || isRunning(state);
}

export function hasUnfinished(state: WorkspaceViewState): boolean {
  return Boolean(selectedSession(state)?.unfinished);
}

export function canSubmit(state: WorkspaceViewState): boolean {
  const session = selectedSession(state);
  const modelId = session ? session.modelId : state.newModelId;
  return Boolean(
    state.snapshot?.workspace &&
      !isLocked(state) &&
      !hasUnfinished(state) &&
      state.drafts[draftKey(state)]?.trim() &&
      state.models.some(
        (model) => model.id === modelId && model.availability?.state !== "unavailable",
      ),
  );
}

function sameRun(left: HarnessIdentity, right: HarnessIdentity): boolean {
  return (
    left.agentId === right.agentId &&
    left.threadId === right.threadId &&
    left.queryId === right.queryId &&
    left.runId === right.runId
  );
}

/** 仅保留安全展示投影与未提交草稿；恢复请求只引用宿主持久化身份。 */
export function createWorkspaceController(api: HarnessDesktopApi): WorkspaceController {
  let state: WorkspaceViewState = {
    snapshot: null,
    models: [],
    drafts: {},
    composingNew: false,
    newModelId: "",
    pending: false,
    loading: true,
    error: null,
    preview: null,
    toolProgress: [],
  };
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | undefined;
  let disposed = true;
  let generation = 0;
  let confirmedScope: string | undefined;
  type Request = { readonly generation: number; readonly scopeId: string };

  function admission(): Request | undefined {
    if (disposed || confirmedScope === undefined) return undefined;
    return { generation, scopeId: confirmedScope };
  }

  function isCurrent(request: Request): boolean {
    return !disposed && generation === request.generation && confirmedScope === request.scopeId;
  }

  function update(patch: Partial<WorkspaceViewState>) {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function applySnapshot(snapshot: HarnessSnapshot): boolean {
    if (disposed || snapshot.scopeId !== confirmedScope) return false;
    const previous = state.snapshot;
    if (previous?.scopeId === snapshot.scopeId && previous.revision > snapshot.revision)
      return false;
    const scopeChanged = previous !== null && previous.scopeId !== snapshot.scopeId;
    const active = snapshot.activeRun;
    const preview =
      !scopeChanged && active && state.preview && sameRun(active, state.preview.identity)
        ? state.preview
        : null;
    update({
      snapshot,
      models: snapshot.models,
      loading: false,
      preview,
      toolProgress:
        !scopeChanged && active
          ? state.toolProgress.filter((tool) => sameRun(tool.identity, active))
          : [],
      error: snapshot.error?.message ?? null,
      ...(!previous || scopeChanged
        ? {
            composingNew: !snapshot.selectedSessionId,
            newModelId: snapshot.defaultModelId ?? "",
          }
        : {}),
    });
    return true;
  }

  function accept<T>(reply: HarnessReply<T>, request: Request): T | undefined {
    if (!isCurrent(request)) return undefined;
    if (!reply.ok) {
      update({ error: reply.error.message });
      return undefined;
    }
    return reply.value;
  }

  async function initialize(current: number) {
    try {
      const reply = await api.snapshot();
      if (disposed || generation !== current) return;
      if (reply.ok) {
        confirmedScope = reply.value.scopeId;
        applySnapshot(reply.value);
      } else {
        update({ loading: false, error: reply.error.message });
      }
    } catch {
      if (disposed || generation !== current) return;
      update({ loading: false, error: "无法读取桌面会话，请稍后重新加载。" });
    }
  }

  async function refresh(request: Request, error = "无法读取桌面会话，请稍后重新加载。") {
    if (!isCurrent(request)) return;
    try {
      const value = accept(await api.snapshot(), request);
      if (value) applySnapshot(value);
    } catch {
      if (!isCurrent(request)) return;
      update({ loading: false, error });
    }
    if (isCurrent(request)) update({ loading: false });
  }

  function onEvent(event: HarnessDesktopEvent, request: Request) {
    if (!isCurrent(request)) return;
    if (event.type === "snapshot") {
      applySnapshot(event.snapshot);
      return;
    }
    const snapshot = state.snapshot;
    if (!snapshot || snapshot.scopeId !== event.scopeId) return;
    if (!snapshot.activeRun || !sameRun(snapshot.activeRun, event.identity)) return;
    if (event.type === "run.settled") {
      if (state.preview && sameRun(state.preview.identity, event.identity))
        update({ preview: null });
      // 工具完成事实保留到权威快照接替，避免结算事件与快照之间正文闪空。
      void refresh(request);
      return;
    }
    if (event.type === "tool.status") {
      const tool: WorkspaceToolProgress = {
        identity: event.identity,
        invocationIdentity: event.invocationIdentity,
        step: event.step,
        callId: event.callId,
        name: event.name,
        status: event.status,
        display: event.display,
        effects: event.effects,
        error: event.error,
      };
      const index = state.toolProgress.findIndex(
        (item) =>
          item.callId === event.callId &&
          item.step === event.step &&
          sameRun(
            item.invocationIdentity ?? item.identity,
            event.invocationIdentity ?? event.identity,
          ),
      );
      const toolProgress = [...state.toolProgress];
      if (index < 0) toolProgress.push(tool);
      else toolProgress[index] = tool;
      update({ toolProgress });
      return;
    }
    const previous =
      state.preview && sameRun(state.preview.identity, event.identity)
        ? state.preview
        : { identity: event.identity, text: "", reasoning: "" };
    update({
      preview: {
        identity: event.identity,
        text: previous.text + (event.reasoning ? "" : event.text),
        reasoning: previous.reasoning + (event.reasoning ? event.text : ""),
      },
    });
  }

  async function command(action: (request: Request) => Promise<void>) {
    const request = admission();
    if (!request || isLocked(state)) return;
    update({ pending: true, error: null });
    try {
      if (isCurrent(request)) await action(request);
    } catch {
      if (isCurrent(request))
        update({ error: "操作未完成。请检查当前会话状态；未发送的草稿已保留。" });
    } finally {
      if (isCurrent(request)) update({ pending: false });
    }
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      const current = ++generation;
      unsubscribe?.();
      disposed = false;
      confirmedScope = undefined;
      update({ loading: true, pending: false, error: null, preview: null, toolProgress: [] });
      const stopSubscription = api.subscribe((event) => {
        const request = admission();
        if (generation === current && request) onEvent(event, request);
      });
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        stopSubscription();
        if (generation !== current) return;
        disposed = true;
        generation += 1;
        confirmedScope = undefined;
        unsubscribe = undefined;
      };
      unsubscribe = stop;
      void initialize(current);
      return stop;
    },
    refreshModels: async () => {
      const request = admission();
      if (request) await refresh(request, "无法刷新可用模型，请返回设置检查连接。");
    },
    setDraft(text: string) {
      update({ drafts: { ...state.drafts, [draftKey(state)]: text } });
    },
    setNewModel(modelId: string) {
      if (
        !isLocked(state) &&
        state.composingNew &&
        state.models.some(
          (model) => model.id === modelId && model.availability?.state !== "unavailable",
        )
      ) {
        update({ newModelId: modelId });
      }
    },
    selectModel: (modelId: string) => {
      const session = selectedSession(state);
      const workspaceId = state.snapshot?.workspace?.id;
      if (
        !session ||
        hasUnfinished(state) ||
        state.snapshot?.status === "running" ||
        state.snapshot?.status === "waiting" ||
        modelId === session.modelId ||
        !state.models.some(
          (model) => model.id === modelId && model.availability?.state !== "unavailable",
        )
      )
        return Promise.resolve();
      return command(async (request) => {
        let reply: HarnessReply<HarnessSnapshot>;
        try {
          reply = await api.selectModel({ sessionId: session.id, modelId });
        } catch (error) {
          if (
            isCurrent(request) &&
            selectedSession(state)?.id === session.id &&
            state.snapshot?.workspace?.id === workspaceId
          )
            throw error;
          return;
        }
        if (
          !isCurrent(request) ||
          selectedSession(state)?.id !== session.id ||
          state.snapshot?.workspace?.id !== workspaceId
        )
          return;
        const value = accept(reply, request);
        if (value?.selectedSessionId === session.id && value.workspace?.id === workspaceId)
          applySnapshot(value);
      });
    },
    newSession() {
      if (!admission() || isLocked(state) || state.snapshot?.status === "waiting") return;
      update({
        composingNew: true,
        error: null,
        preview: null,
        toolProgress: [],
        newModelId: state.snapshot?.defaultModelId ?? "",
      });
    },
    chooseWorkspace: () =>
      command(async (request) => {
        if (state.snapshot?.status === "waiting") return;
        const originalWorkspaceId = state.snapshot?.workspace?.id;
        const value = accept(await api.chooseWorkspace(), request);
        if (value) {
          const changed = value.workspace?.id !== originalWorkspaceId;
          if (!applySnapshot(value)) return;
          if (changed) update({ composingNew: !value.selectedSessionId });
        }
      }),
    selectWorkspace: (id: string) =>
      command(async (request) => {
        if (state.snapshot?.status === "waiting") return;
        const value = accept(await api.selectWorkspace(id), request);
        if (value && applySnapshot(value)) {
          update({ composingNew: !value.selectedSessionId });
        }
      }),
    selectSession: (id: string) =>
      command(async (request) => {
        const value = accept(await api.selectSession(id), request);
        if (value && applySnapshot(value)) {
          update({ composingNew: false, preview: null });
        }
      }),
    send: () => {
      if (!canSubmit(state)) return Promise.resolve();
      const originalKey = draftKey(state);
      const draft = state.drafts[originalKey];
      const text = draft.trim();
      const targetSessionId = selectedSession(state)?.id;
      const modelId = state.newModelId;
      return command(async (request) => {
        let sessionId = targetSessionId;
        if (!sessionId) {
          const value = accept(
            await api.newSession({ modelId, toolsMode: NEW_SESSION_TOOLS_MODE }),
            request,
          );
          if (!value?.selectedSessionId || !applySnapshot(value)) return;
          sessionId = value.selectedSessionId;
          const drafts = { ...state.drafts, [sessionId]: state.drafts[originalKey] ?? draft };
          delete drafts[originalKey];
          update({ composingNew: false, drafts });
          if (!isCurrent(request)) return;
        }
        const identity = accept(await api.run({ sessionId, text }), request);
        if (identity) {
          const drafts = { ...state.drafts };
          if (drafts[sessionId] === draft) delete drafts[sessionId];
          if (drafts[originalKey] === draft) delete drafts[originalKey];
          update({ drafts });
          await refresh(request);
        }
      });
    },
    resume: (choiceId?: "allow" | "reject") =>
      command(async (request) => {
        const session = selectedSession(state);
        const unfinished = session?.unfinished;
        if (!session || !unfinished) return;
        const approval = state.snapshot?.pendingApproval;
        if (unfinished.status === "waiting") {
          if (
            !approval?.supported ||
            !choiceId ||
            !approval.choices.some((choice) => choice.id === choiceId) ||
            approval.queryId !== unfinished.queryId
          )
            return;
        } else if (choiceId !== undefined) return;
        const identity = accept(
          await api.resume({
            sessionId: session.id,
            queryId: unfinished.queryId,
            ...(unfinished.status === "waiting" && approval
              ? { interactionId: approval.interactionId, choiceId }
              : {}),
          }),
          request,
        );
        if (identity) await refresh(request);
      }),
    cancel: async () => {
      const request = admission();
      if (!request || state.pending || state.loading) return;
      const session = selectedSession(state);
      const active = state.snapshot?.activeRun;
      const queryId = active?.queryId ?? session?.unfinished?.queryId;
      if (!session || !queryId) return;
      update({ pending: true, error: null });
      if (!isCurrent(request)) return;
      try {
        const value = accept(
          await api.cancel({
            sessionId: session.id,
            queryId,
            ...(active ? { runId: active.runId } : {}),
          }),
          request,
        );
        if (value) applySnapshot(value);
      } catch {
        if (isCurrent(request)) update({ error: "取消未完成，请检查会话状态后再操作。" });
      } finally {
        if (isCurrent(request)) update({ pending: false });
      }
    },
  };
}
