import { describe, expect, it } from "vitest";
import {
  createWorkspaceState,
  getActiveThread,
  workspaceReducer as reduce,
} from "../app/renderer/src/ui-preview/state/workspace-state";

describe("工作区会话的本地交互", () => {
  it("切换工作区与会话保留各自草稿和模型，发送只更新指定会话", () => {
    let state = createWorkspaceState();
    const first = getActiveThread(state);
    const second = state.threads.find((thread) => thread.workspaceId !== first.workspaceId)!;
    const model = state.models.find((item) => item.id !== first.modelId)!;
    state = reduce(state, {
      type: "draft",
      threadId: first.id,
      value: "  确认工作区边界\n保留后续任务  ",
    });
    state = reduce(state, { type: "select-model", threadId: first.id, modelId: model.id });
    state = reduce(state, { type: "select-workspace", workspaceId: second.workspaceId });
    state = reduce(state, { type: "draft", threadId: second.id, value: "另一个工作区的草稿" });
    state = reduce(state, { type: "select-thread", threadId: first.id });
    expect(getActiveThread(state).draft).toBe("  确认工作区边界\n保留后续任务  ");
    expect(getActiveThread(state).modelId).toBe(model.id);
    state = reduce(state, { type: "send", threadId: first.id });
    expect(getActiveThread(state).messages.map(({ text, modelId }) => ({ text, modelId }))).toEqual(
      [{ text: "确认工作区边界\n保留后续任务", modelId: model.id }],
    );
    expect(getActiveThread(state).title).toBe("确认工作区边界");
    expect(getActiveThread(state).draft).toBe("");
    expect(state.threads.find((thread) => thread.id === second.id)!.draft).toBe(
      "另一个工作区的草稿",
    );
    expect(state.threads.find((thread) => thread.id === second.id)!.messages).toEqual([]);
  });

  it("新会话不覆盖未发送输入，旧输入事件仍绑定原会话", () => {
    let state = createWorkspaceState();
    const original = getActiveThread(state);
    state = reduce(state, { type: "draft", threadId: original.id, value: "原会话未发送内容" });
    state = reduce(state, { type: "new-thread", workspaceId: original.workspaceId });
    const current = getActiveThread(state);
    state = reduce(state, { type: "draft", threadId: current.id, value: "新会话内容" });
    state = reduce(state, { type: "draft", threadId: original.id, value: "原会话的最后一次输入" });
    expect(getActiveThread(state).draft).toBe("新会话内容");
    state = reduce(state, { type: "send", threadId: original.id });
    expect(getActiveThread(state).messages).toEqual([]);
    expect(getActiveThread(state).draft).toBe("新会话内容");
    const submitted = state.threads.find((thread) => thread.id === original.id)!;
    expect(submitted.messages.map((message) => message.text)).toEqual(["原会话的最后一次输入"]);
    expect(submitted.draft).toBe("");
  });

  it("隐藏当前模型不替换身份或丢草稿，明确重选后才能提交，历史模型不被改写", () => {
    let state = createWorkspaceState();
    const thread = getActiveThread(state);
    const other = state.models.find((model) => model.id !== thread.modelId)!;
    state = reduce(state, { type: "draft", threadId: thread.id, value: "首条消息" });
    state = reduce(state, { type: "send", threadId: thread.id });
    state = reduce(state, { type: "draft", threadId: thread.id, value: "待发送草稿" });
    state = reduce(state, { type: "set-model-enabled", modelId: thread.modelId, enabled: false });
    const unavailable = state;
    state = reduce(state, { type: "send", threadId: thread.id });
    expect(state).toEqual(unavailable);
    expect(getActiveThread(state).modelId).toBe(thread.modelId);
    expect(getActiveThread(state).draft).toBe("待发送草稿");
    state = reduce(state, { type: "select-model", threadId: thread.id, modelId: other.id });
    state = reduce(state, { type: "send", threadId: thread.id });
    expect(getActiveThread(state).messages.map(({ text, modelId }) => ({ text, modelId }))).toEqual(
      [
        { text: "首条消息", modelId: thread.modelId },
        { text: "待发送草稿", modelId: other.id },
      ],
    );
    const submitted = state;
    state = reduce(state, { type: "send", threadId: thread.id });
    expect(state).toEqual(submitted);
  });
});
