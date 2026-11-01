import { describe, expect, it } from "vitest";
import {
  type ConnectionState,
  createConnectionState,
  demoKeyChange,
  isEditorDirty,
  connectionReducer as reduce,
} from "../app/renderer/src/ui-preview/state/connection-state";

function validEditor(): ConnectionState {
  let state = reduce(createConnectionState(), { type: "open" });
  state = reduce(state, demoKeyChange("demo-key"));
  return state;
}

describe("本地连接编辑生命周期", () => {
  it("字段无效不提交，非演示 Key 不进入可保留状态", () => {
    let state = reduce(createConnectionState(), { type: "open" });
    state = reduce(state, { type: "change", field: "name", value: "  " });
    state = reduce(state, { type: "change", field: "address", value: "not-an-address" });
    const rejected = demoKeyChange("not-a-demo-credential");
    expect(JSON.stringify(rejected)).not.toContain("not-a-demo-credential");
    expect(rejected.rejected).toBe(true);
    state = reduce(state, rejected);
    expect(state.editor!.draft.demoKey).toBe("");
    expect(JSON.stringify(state)).not.toContain("not-a-demo-credential");
    state = reduce(state, { type: "submit", outcome: "success", deferred: false });
    expect(Object.keys(state.editor!.errors).sort()).toEqual(["address", "demoKey", "name"]);
    expect(state.editor!.phase).toBe("editing");
    expect(state.connections[0].name).toBe("Atlas · 示例连接");
  });

  it("模拟失败保留输入，修正成功只更新目标名称/地址而不保留 Key", () => {
    let state = validEditor();
    state = reduce(state, { type: "change", field: "name", value: "  revised atlas  " });
    state = reduce(state, { type: "submit", outcome: "failure", deferred: false });
    expect(state.editor!.failure).toBe(true);
    expect(state.editor!.draft.name).toBe("  revised atlas  ");
    expect(state.editor!.draft.demoKey).toBe("demo-key");
    expect(state.connections[0].name).toBe("Atlas · 示例连接");
    state = reduce(state, {
      type: "change",
      field: "address",
      value: "https://revised.example.invalid/v2",
    });
    state = reduce(state, { type: "submit", outcome: "success", deferred: false });
    expect(state.editor).toBeNull();
    expect(state.connections).toEqual([
      { id: "atlas", name: "revised atlas", address: "https://revised.example.invalid/v2" },
      { id: "cedar", name: "Cedar · 示例连接", address: "https://cedar.example.invalid/v1" },
    ]);
    expect(JSON.stringify(state)).not.toContain("demo-key");
  });

  it("脏导航先确认，继续编辑保留对象和草稿，放弃后完成原导航", () => {
    let state = reduce(validEditor(), { type: "change", field: "name", value: "未提交名称" });
    expect(isEditorDirty(state)).toBe(true);
    state = reduce(state, { type: "leave", intent: { kind: "target", targetId: "cedar" } });
    expect(state.selectedId).toBe("atlas");
    state = reduce(state, { type: "stay" });
    expect(state.editor!.draft.name).toBe("未提交名称");
    expect(state.selectedId).toBe("atlas");
    state = reduce(state, { type: "leave", intent: { kind: "target", targetId: "cedar" } });
    state = reduce(state, { type: "discard" });
    expect(state.selectedId).toBe("cedar");
    expect(state.editor).toBeNull();
    expect(state.connections[0].name).toBe("Atlas · 示例连接");
  });

  it("取消等待后继续编辑不复活旧操作，晚到成功不能覆盖草稿", () => {
    let state = reduce(validEditor(), { type: "submit", outcome: "success", deferred: true });
    const old = state.editor!.operation!;
    state = reduce(state, { type: "leave", intent: { kind: "close" } });
    state = reduce(state, { type: "stay" });
    expect(state.editor!.phase).toBe("editing");
    state = reduce(state, { type: "change", field: "name", value: "继续编辑的新内容" });
    state = reduce(state, { type: "complete", result: old });
    expect(state.editor!.draft.name).toBe("继续编辑的新内容");
    expect(state.editor!.operation).toBeNull();
    expect(state.ignoredResults).toBe(1);
    expect(state.connections[0].name).toBe("Atlas · 示例连接");
  });

  it("旧编辑的成功不能关闭同一目标重开的新实例或完成其新操作", () => {
    let state = reduce(validEditor(), { type: "submit", outcome: "success", deferred: true });
    const old = state.editor!.operation!;
    state = reduce(state, { type: "leave", intent: { kind: "close" } });
    state = reduce(state, { type: "discard" });
    state = reduce(state, { type: "open" });
    state = reduce(state, demoKeyChange("demo-key"));
    state = reduce(state, { type: "change", field: "name", value: "新实例" });
    state = reduce(state, { type: "submit", outcome: "success", deferred: true });
    const current = state.editor!.operation!;
    state = reduce(state, { type: "complete", result: old });
    expect(state.editor!.operation).toEqual(current);
    expect(state.editor!.draft.name).toBe("新实例");
    state = reduce(state, { type: "complete", result: current });
    expect(state.editor).toBeNull();
    expect(state.connections[0].name).toBe("新实例");
  });

  it("reset 推进世代且清草稿，旧结果不能收养新的等待", () => {
    let state = reduce(validEditor(), { type: "submit", outcome: "success", deferred: true });
    const old = state.editor!.operation!;
    state = reduce(state, { type: "reset" });
    expect(state.editor).toBeNull();
    expect(state.generation).toBe(1);
    state = reduce(state, { type: "open" });
    state = reduce(state, demoKeyChange("demo-key"));
    state = reduce(state, { type: "submit", outcome: "success", deferred: true });
    const current = state.editor!.operation!;
    state = reduce(state, {
      type: "complete",
      result: { ...old, identity: { ...current.identity, generation: old.identity.generation } },
    });
    expect(state.editor!.operation).toEqual(current);
    expect(state.connections[0].name).toBe("Atlas · 示例连接");
  });

  it("一次等待只接受一份提交，输入和结果选择不能改写派发身份", () => {
    let state = reduce(validEditor(), { type: "submit", outcome: "failure", deferred: true });
    const first = state.editor!.operation!;
    state = reduce(state, { type: "submit", outcome: "success", deferred: true });
    state = reduce(state, { type: "change", field: "name", value: "等待中不应改变" });
    expect(state.editor!.operation).toEqual(first);
    expect(state.editor!.draft.name).toBe("Atlas · 示例连接");
    state = reduce(state, { type: "complete", result: first });
    expect(state.editor!.failure).toBe(true);
  });
});
