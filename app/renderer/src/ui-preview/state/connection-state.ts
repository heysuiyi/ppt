/** 仅预览内存状态；没有模型配置、凭据或真实执行协议。 */
export interface DemoConnection {
  id: string;
  name: string;
  address: string;
}
export interface ConnectionDraft {
  name: string;
  address: string;
  demoKey: "" | "demo-key";
}
export type FieldName = "name" | "address" | "demoKey";
export type FieldErrors = Partial<Record<FieldName, string>>;
export type LocalOutcome = "success" | "failure";
export interface OperationIdentity {
  targetId: string;
  editorId: number;
  operationId: number;
  generation: number;
}
export interface DeferredResult {
  identity: OperationIdentity;
  outcome: LocalOutcome;
}
export interface ConnectionEditor {
  id: number;
  targetId: string;
  draft: ConnectionDraft;
  errors: FieldErrors;
  phase: "editing" | "pending";
  operation: DeferredResult | null;
  failure: boolean;
}
export type LeaveIntent =
  | { kind: "close" }
  | { kind: "target"; targetId: string }
  | { kind: "page"; page: PreviewPage };
export type PreviewPage = "connection" | "foundations";
export interface ConnectionState {
  connections: DemoConnection[];
  page: PreviewPage;
  editor: ConnectionEditor | null;
  leave: LeaveIntent | null;
  generation: number;
  nextEditorId: number;
  nextOperationId: number;
  staleResults: DeferredResult[];
  ignoredResults: number;
  notice: string;
}
export type ConnectionAction =
  | { type: "open"; targetId: string }
  | { type: "change"; field: Exclude<FieldName, "demoKey">; value: string }
  | DemoKeyChangeAction
  | { type: "submit"; outcome: LocalOutcome; deferred: boolean }
  | { type: "complete"; result: DeferredResult }
  | { type: "leave"; intent: LeaveIntent }
  | { type: "stay" }
  | { type: "discard" }
  | { type: "reset" };

export interface DemoKeyChangeAction {
  type: "demo-key";
  value: "" | "demo-key";
  rejected: boolean;
}

/** 输入事件同步过滤后才 dispatch，非演示原文不能进入 React 更新队列。 */
export function demoKeyChange(value: string): DemoKeyChangeAction {
  return {
    type: "demo-key",
    value: value === "demo-key" ? "demo-key" : "",
    rejected: value !== "" && value !== "demo-key",
  };
}

export function createConnectionState(generation = 0): ConnectionState {
  return {
    connections: [
      { id: "atlas", name: "Atlas", address: "https://atlas.example.invalid/v1" },
      { id: "cedar", name: "Cedar", address: "https://cedar.example.invalid/v1" },
    ],
    page: "connection",
    editor: null,
    leave: null,
    generation,
    nextEditorId: 1,
    nextOperationId: 1,
    staleResults: [],
    ignoredResults: 0,
    notice: "",
  };
}

export function validateDraft(draft: ConnectionDraft): FieldErrors {
  const errors: FieldErrors = {};
  if (!draft.name.trim()) errors.name = "请输入显示名称。";
  try {
    const address = new URL(draft.address);
    if (!["https:", "http:"].includes(address.protocol) || !address.hostname) throw new Error();
  } catch {
    errors.address = "请输入完整的 http:// 或 https:// 地址。";
  }
  if (draft.demoKey !== "demo-key") errors.demoKey = "仅接受 demo-key。";
  return errors;
}

export function isEditorDirty(state: ConnectionState): boolean {
  if (!state.editor) return false;
  const baseline = state.connections.find((item) => item.id === state.editor!.targetId)!;
  return (
    state.editor.draft.name !== baseline.name ||
    state.editor.draft.address !== baseline.address ||
    state.editor.draft.demoKey !== ""
  );
}

function sameOperation(a: OperationIdentity, b: OperationIdentity): boolean {
  return (
    a.targetId === b.targetId &&
    a.editorId === b.editorId &&
    a.operationId === b.operationId &&
    a.generation === b.generation
  );
}

function invalidate(state: ConnectionState): ConnectionState {
  const editor = state.editor;
  if (!editor?.operation) return state;
  return {
    ...state,
    staleResults: [...state.staleResults, editor.operation],
    editor: { ...editor, phase: "editing", operation: null },
  };
}

function openEditor(state: ConnectionState, targetId: string): ConnectionState {
  const target = state.connections.find((item) => item.id === targetId);
  if (!target) return state;
  return {
    ...state,
    leave: null,
    notice: "",
    nextEditorId: state.nextEditorId + 1,
    editor: {
      id: state.nextEditorId,
      targetId: target.id,
      draft: { name: target.name, address: target.address, demoKey: "" },
      errors: {},
      phase: "editing",
      operation: null,
      failure: false,
    },
  };
}

function leaveNow(state: ConnectionState, intent: LeaveIntent): ConnectionState {
  if (intent.kind === "target") return openEditor(state, intent.targetId);
  return {
    ...state,
    editor: null,
    leave: null,
    notice: "",
    ...(intent.kind === "page" ? { page: intent.page } : {}),
  };
}

export function connectionReducer(
  state: ConnectionState,
  action: ConnectionAction,
): ConnectionState {
  switch (action.type) {
    case "open":
      return state.editor ? state : openEditor(state, action.targetId);
    case "change": {
      if (!state.editor || state.editor.phase === "pending" || state.leave) return state;
      return {
        ...state,
        editor: {
          ...state.editor,
          failure: false,
          draft: { ...state.editor.draft, [action.field]: action.value },
          errors: { ...state.editor.errors, [action.field]: undefined },
        },
      };
    }
    case "demo-key": {
      if (!state.editor || state.editor.phase === "pending" || state.leave) return state;
      return {
        ...state,
        editor: {
          ...state.editor,
          failure: false,
          draft: { ...state.editor.draft, demoKey: action.value },
          errors: {
            ...state.editor.errors,
            demoKey: action.rejected ? "仅接受 demo-key，其他输入已清除。" : undefined,
          },
        },
      };
    }
    case "submit": {
      if (!state.editor || state.editor.phase === "pending" || state.leave) return state;
      const errors = validateDraft(state.editor.draft);
      if (Object.keys(errors).length)
        return { ...state, editor: { ...state.editor, errors, failure: false } };
      const result: DeferredResult = {
        identity: {
          targetId: state.editor.targetId,
          editorId: state.editor.id,
          operationId: state.nextOperationId,
          generation: state.generation,
        },
        outcome: action.outcome,
      };
      const pending: ConnectionState = {
        ...state,
        nextOperationId: state.nextOperationId + 1,
        editor: {
          ...state.editor,
          errors: {},
          failure: false,
          phase: "pending",
          operation: result,
        },
      };
      // 非暂缓也经过相同完成裁决；无计时器、网络请求或未清理 Promise。
      return action.deferred ? pending : connectionReducer(pending, { type: "complete", result });
    }
    case "complete": {
      const operation = state.editor?.operation;
      if (
        !operation ||
        !sameOperation(operation.identity, action.result.identity) ||
        state.generation !== action.result.identity.generation
      ) {
        return {
          ...state,
          staleResults: state.staleResults.filter(
            (item) => !sameOperation(item.identity, action.result.identity),
          ),
          ignoredResults: state.ignoredResults + 1,
        };
      }
      if (operation.outcome === "failure")
        return {
          ...state,
          editor: { ...state.editor!, phase: "editing", operation: null, failure: true },
        };
      const editor = state.editor!;
      return {
        ...state,
        editor: null,
        leave: null,
        connections: state.connections.map((item) =>
          item.id === editor.targetId
            ? { ...item, name: editor.draft.name.trim(), address: editor.draft.address.trim() }
            : item,
        ),
        notice: "示例已更新",
      };
    }
    case "leave": {
      if (state.leave) return state;
      const invalidated = invalidate(state);
      return isEditorDirty(invalidated)
        ? { ...invalidated, leave: action.intent }
        : leaveNow(invalidated, action.intent);
    }
    case "stay":
      return { ...state, leave: null };
    case "discard":
      return state.leave ? leaveNow(state, state.leave) : state;
    case "reset": {
      const invalidated = invalidate(state);
      // 保留安全身份的故障注入样本，释放后必须被世代拒绝；不保留任何草稿或回调。
      return {
        ...createConnectionState(state.generation + 1),
        staleResults: invalidated.staleResults,
        nextEditorId: state.nextEditorId,
        nextOperationId: state.nextOperationId,
      };
    }
  }
}
