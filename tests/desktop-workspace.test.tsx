// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopWorkspace } from "../app/renderer/src/desktop/DesktopWorkspace";
import {
  createWorkspaceController,
  draftKey,
  type WorkspaceController,
} from "../app/renderer/src/desktop/workspace-controller";
import { UiProvider } from "../app/renderer/src/ui/provider/UiProvider";
import type {
  HarnessDesktopApi,
  HarnessDesktopEvent,
  HarnessIdentity,
  HarnessReply,
  HarnessSnapshot,
} from "../app/shared/harness-ipc";

const identity: HarnessIdentity = {
  agentId: "agent",
  threadId: "thread",
  queryId: "query",
  runId: "run",
};
function ok<T>(value: T): HarnessReply<T> {
  return { ok: true, value };
}
function snapshot(patch: Partial<HarnessSnapshot> = {}): HarnessSnapshot {
  return {
    scopeId: "scope",
    revision: 1,
    workspace: { id: "workspace", label: "Work", path: "E:/work" },
    recentWorkspaces: [{ id: "workspace", label: "Work", path: "E:/work" }],
    models: [{ id: "original", label: "Original" }],
    defaultModelId: "original",
    sessions: [
      {
        id: "session",
        label: "Existing",
        modelId: "original",
        toolsMode: "read-only",
        history: [],
      },
    ],
    selectedSessionId: "session",
    selectedModelId: "original",
    toolsMode: "read-only",
    status: "completed",
    activeRun: null,
    pendingApproval: null,
    error: null,
    ...patch,
  };
}

function host(initial: HarnessSnapshot) {
  let current = initial;
  let listener: ((event: HarnessDesktopEvent) => void) | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const api: HarnessDesktopApi = {
    snapshot: vi.fn(async () => ok(current)),
    models: vi.fn(async () => ok(current.models)),
    sessions: vi.fn(async () => ok(current.sessions)),
    chooseWorkspace: vi.fn(async () => ok(current)),
    selectWorkspace: vi.fn(async () => ok(current)),
    newSession: vi.fn(async () => ok(current)),
    selectSession: vi.fn(async () => ok(current)),
    run: vi.fn(async () => ok(identity)),
    setDefaultModel: vi.fn(async () => ok(current)),
    resume: vi.fn(async () => ok(identity)),
    cancel: vi.fn(async () => ok(current)),
    subscribe: vi.fn((callback) => {
      listener = callback;
      return unsubscribe;
    }),
  };
  return {
    api,
    unsubscribe,
    publish(next: HarnessSnapshot) {
      current = next;
      listener?.({ type: "snapshot", snapshot: next });
    },
    emit(event: HarnessDesktopEvent) {
      listener?.(event);
    },
    setSnapshot(next: HarnessSnapshot) {
      current = next;
    },
  };
}

function Workspace({ controller }: { controller: WorkspaceController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const navigationRef = useRef<HTMLButtonElement>(null);
  useEffect(() => controller.start(), [controller]);
  return (
    <UiProvider theme="dark">
      <DesktopWorkspace
        state={state}
        controller={controller}
        onSettings={() => {}}
        theme="dark"
        onThemeChange={() => {}}
        settingsRef={settingsRef}
        navigationRef={navigationRef}
      />
    </UiProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("真实桌面工作区的安全交互", () => {
  it("原生目录快照先于命令回包时仍进入可用的新会话草稿", async () => {
    const bridge = host(snapshot());
    const choosing = Promise.withResolvers<HarnessReply<HarnessSnapshot>>();
    vi.mocked(bridge.api.chooseWorkspace).mockReturnValueOnce(choosing.promise);
    const controller = createWorkspaceController(bridge.api);
    render(<Workspace controller={controller} />);
    await waitFor(() => expect(controller.getState().loading).toBe(false));
    act(() => controller.setDraft("原会话的未发送草稿"));
    const next = snapshot({
      revision: 2,
      workspace: { id: "other", label: "Other", path: "E:/other" },
      sessions: [],
      selectedSessionId: null,
      selectedModelId: null,
      status: "idle",
    });
    await act(async () => {
      const pending = controller.chooseWorkspace();
      bridge.publish(next);
      choosing.resolve(ok(next));
      await pending;
    });
    expect(controller.getState().composingNew).toBe(true);
    expect(controller.getState().drafts.session).toBe("原会话的未发送草稿");
    expect(draftKey(controller.getState())).toBe("new:other");
    expect((screen.getByRole("textbox", { name: "任务输入" }) as HTMLTextAreaElement).value).toBe(
      "",
    );
  });

  it("同名调用跨步骤分别显示结果，持久快照接替实时结果而不重复", async () => {
    const running = snapshot({
      status: "running",
      activeRun: identity,
      sessions: [
        {
          ...snapshot().sessions[0],
          unfinished: { queryId: "query", status: "running" },
        },
      ],
    });
    const bridge = host(running);
    const controller = createWorkspaceController(bridge.api);
    render(<Workspace controller={controller} />);
    await waitFor(() => expect(controller.getState().loading).toBe(false));
    const firstDisplay = { title: "first.txt", input: [], output: ["first-safe-result"] };
    const secondDisplay = { title: "second.txt", input: [], output: ["second-safe-result"] };
    act(() => {
      bridge.emit({
        type: "tool.status",
        scopeId: "scope",
        identity,
        invocationIdentity: identity,
        step: 1,
        callId: "reused-call",
        name: "read",
        status: "completed",
        effects: "none",
        display: firstDisplay,
      });
      bridge.emit({
        type: "tool.status",
        scopeId: "scope",
        identity,
        invocationIdentity: identity,
        step: 2,
        callId: "reused-call",
        name: "read",
        status: "completed",
        effects: "none",
        display: secondDisplay,
      });
    });
    expect(screen.getByText("first-safe-result")).toBeTruthy();
    expect(screen.getByText("second-safe-result")).toBeTruthy();
    act(() =>
      bridge.publish({
        ...running,
        revision: 2,
        sessions: [
          {
            ...running.sessions[0],
            history: [
              {
                role: "tool",
                tool: {
                  callId: "reused-call",
                  name: "read",
                  result: "recorded",
                  identity,
                  step: 1,
                  status: "completed",
                  effects: "none",
                  display: firstDisplay,
                },
              },
            ],
          },
        ],
      }),
    );
    expect(screen.getByText("first-safe-result")).toBeTruthy();
    expect(screen.getByText("second-safe-result")).toBeTruthy();
    const handoff = Promise.withResolvers<HarnessReply<HarnessSnapshot>>();
    vi.mocked(bridge.api.snapshot).mockReturnValueOnce(handoff.promise);
    act(() =>
      bridge.emit({
        type: "run.settled",
        scopeId: "scope",
        identity,
        status: "completed",
      }),
    );
    expect(screen.getByText("first-safe-result")).toBeTruthy();
    expect(screen.getByText("second-safe-result")).toBeTruthy();
    act(() =>
      bridge.publish(
        snapshot({
          revision: 3,
          sessions: [
            {
              ...running.sessions[0],
              unfinished: undefined,
              history: [
                {
                  role: "tool",
                  tool: {
                    callId: "reused-call",
                    name: "read",
                    result: "recorded",
                    identity,
                    step: 1,
                    status: "completed",
                    effects: "none",
                    display: firstDisplay,
                  },
                },
                {
                  role: "tool",
                  tool: {
                    callId: "reused-call",
                    name: "read",
                    result: "recorded",
                    identity,
                    step: 2,
                    status: "completed",
                    effects: "none",
                    display: secondDisplay,
                  },
                },
              ],
            },
          ],
        }),
      ),
    );
    await act(async () => handoff.resolve(ok(controller.getState().snapshot!)));
    expect(screen.getByText("first-safe-result")).toBeTruthy();
    expect(screen.getByText("second-safe-result")).toBeTruthy();
    expect(screen.queryByLabelText("工具状态 read")).toBeNull();
  });

  it("同一发送按钮切换为停止，运行中编辑和回车不误发，停止后保留草稿", async () => {
    const bridge = host(snapshot());
    const controller = createWorkspaceController(bridge.api);
    render(<Workspace controller={controller} />);
    await waitFor(() => expect(controller.getState().loading).toBe(false));
    const input = screen.getByRole("textbox", { name: "任务输入" });
    const action = screen.getByRole("button", { name: "发送任务" });
    act(() =>
      bridge.publish(
        snapshot({
          revision: 2,
          status: "running",
          activeRun: identity,
          sessions: [
            {
              ...snapshot().sessions[0],
              unfinished: { queryId: "query", status: "running" },
            },
          ],
        }),
      ),
    );
    expect(screen.getByRole("button", { name: "停止任务" })).toBe(action);
    expect(action.hasAttribute("disabled")).toBe(false);
    fireEvent.change(input, { target: { value: "下一条任务\n保留草稿" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(bridge.api.run).not.toHaveBeenCalled();
    expect(bridge.api.cancel).not.toHaveBeenCalled();
    const { promise, resolve: release } = Promise.withResolvers<HarnessReply<HarnessSnapshot>>();
    vi.mocked(bridge.api.cancel).mockReturnValueOnce(promise);
    fireEvent.click(action);
    expect(action.hasAttribute("disabled")).toBe(true);
    fireEvent.click(action);
    expect(bridge.api.cancel).toHaveBeenCalledTimes(1);
    expect(bridge.api.cancel).toHaveBeenCalledWith({
      sessionId: "session",
      queryId: "query",
      runId: "run",
    });
    await act(async () => release(ok(snapshot({ revision: 3, status: "cancelled" }))));
    expect(screen.getByRole("button", { name: "发送任务" })).toBe(action);
    expect(action.hasAttribute("disabled")).toBe(false);
    expect((input as HTMLTextAreaElement).value).toBe("下一条任务\n保留草稿");
  });

  it("待审批时同一停止按钮取消原请求，不提交审批回答", async () => {
    const bridge = host(
      snapshot({
        status: "waiting",
        sessions: [
          {
            ...snapshot().sessions[0],
            unfinished: { queryId: "query", status: "waiting" },
          },
        ],
      }),
    );
    const controller = createWorkspaceController(bridge.api);
    render(<Workspace controller={controller} />);
    const action = await screen.findByRole("button", { name: "停止任务" });
    fireEvent.click(action);
    await waitFor(() =>
      expect(bridge.api.cancel).toHaveBeenCalledWith({
        sessionId: "session",
        queryId: "query",
      }),
    );
    expect(bridge.api.resume).not.toHaveBeenCalled();
    expect(bridge.api.run).not.toHaveBeenCalled();
  });

  it("waiting 只提交持久化审批身份，未知交互不自动批准", async () => {
    const waiting = snapshot({
      status: "waiting",
      sessions: [
        {
          id: "session",
          label: "Existing",
          modelId: "original",
          toolsMode: "read-only",
          history: [],
          unfinished: { queryId: "query", status: "waiting" },
        },
      ],
      pendingApproval: {
        queryId: "query",
        interactionId: "approval",
        supported: true,
        summary: "读取工作区文件？",
        choices: [
          { id: "allow", label: "同意" },
          { id: "reject", label: "不同意" },
        ],
      },
    });
    const bridge = host(waiting);
    const controller = createWorkspaceController(bridge.api);
    render(<Workspace controller={controller} />);
    await screen.findByRole("button", { name: "批准" });
    expect(bridge.api.resume).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() =>
      expect(bridge.api.resume).toHaveBeenCalledWith({
        sessionId: "session",
        queryId: "query",
        interactionId: "approval",
        choiceId: "reject",
      }),
    );
    act(() =>
      bridge.publish({
        ...waiting,
        revision: 2,
        pendingApproval: { ...waiting.pendingApproval!, supported: false },
      }),
    );
    expect(screen.queryByRole("button", { name: "批准" })).toBeNull();
    expect(screen.getByText(/未自动批准/)).toBeTruthy();
    await act(() => controller.resume("allow"));
    expect(bridge.api.resume).toHaveBeenCalledTimes(1);
  });

  it("发送失败保留完整草稿，异常对象不暴露到界面", async () => {
    const bridge = host(snapshot());
    vi.mocked(bridge.api.run).mockRejectedValueOnce(new Error("private-token-sdk-detail"));
    const controller = createWorkspaceController(bridge.api);
    render(<Workspace controller={controller} />);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "任务输入" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "任务输入" }), {
      target: { value: "  未发送的草稿\n保留格式  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
    await screen.findByRole("alert");
    expect((screen.getByRole("textbox", { name: "任务输入" }) as HTMLTextAreaElement).value).toBe(
      "  未发送的草稿\n保留格式  ",
    );
    expect(screen.queryByText(/private-token-sdk-detail/)).toBeNull();
    expect(bridge.api.run).toHaveBeenCalledWith({
      sessionId: "session",
      text: "未发送的草稿\n保留格式",
    });
  });

  it("刷新模型配置不替换历史绑定或丢失草稿", async () => {
    const bridge = host(snapshot());
    const controller = createWorkspaceController(bridge.api);
    render(<Workspace controller={controller} />);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "当前模型" }).textContent).toContain("Original"),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "任务输入" }), {
      target: { value: "保留草稿" },
    });
    bridge.setSnapshot(
      snapshot({
        revision: 2,
        defaultModelId: "replacement",
        models: [{ id: "replacement", label: "Replacement" }],
      }),
    );
    await act(() => controller.refreshModels());
    expect(screen.getByRole("combobox", { name: "当前模型" }).textContent).toContain("original");
    expect(screen.getByRole("combobox", { name: "当前模型" }).hasAttribute("disabled")).toBe(true);
    expect((screen.getByRole("textbox", { name: "任务输入" }) as HTMLTextAreaElement).value).toBe(
      "保留草稿",
    );
    expect(screen.getByRole("button", { name: "发送任务" }).hasAttribute("disabled")).toBe(true);
    await act(() => controller.send());
    expect(bridge.api.run).not.toHaveBeenCalled();
    expect(bridge.api.newSession).not.toHaveBeenCalled();
  });

  it("流式输出只作临时预览，完成时以权威历史替换并清理监听", async () => {
    const running = snapshot({
      status: "running",
      activeRun: identity,
      sessions: [
        {
          id: "session",
          label: "Existing",
          modelId: "original",
          toolsMode: "none",
          history: [],
          unfinished: { queryId: "query", status: "running" },
        },
      ],
    });
    const bridge = host(running);
    const controller = createWorkspaceController(bridge.api);
    const view = render(<Workspace controller={controller} />);
    await waitFor(() => expect(controller.getState().loading).toBe(false));
    act(() => {
      bridge.emit({
        type: "text.delta",
        scopeId: "other",
        identity,
        text: "wrong-window",
        reasoning: false,
      });
      bridge.emit({
        type: "text.delta",
        scopeId: "scope",
        identity,
        text: "临时未结算",
        reasoning: false,
      });
      bridge.emit({
        type: "tool.status",
        scopeId: "scope",
        identity,
        callId: "call",
        name: "read_file",
        status: "dispatched",
      });
    });
    expect(screen.getByLabelText("临时输出预览").textContent).toContain("临时未结算");
    expect(screen.queryByText("wrong-window")).toBeNull();
    expect(screen.getByRole("button", { name: "新会话" }).hasAttribute("disabled")).toBe(true);
    act(() =>
      bridge.publish(
        snapshot({
          revision: 2,
          sessions: [
            {
              id: "session",
              label: "Existing",
              modelId: "original",
              toolsMode: "none",
              history: [{ role: "assistant", text: "权威完整正文" }],
            },
          ],
        }),
      ),
    );
    expect(screen.queryByLabelText("临时输出预览")).toBeNull();
    expect(screen.queryByLabelText("工具状态 read_file")).toBeNull();
    expect(screen.getByText("权威完整正文")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "继续任务" })).toBeNull();
    await act(() => controller.resume());
    expect(bridge.api.resume).not.toHaveBeenCalled();
    view.unmount();
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("重启后持久 running 无活动Run时允许显式继续，但拒绝新输入", async () => {
    const bridge = host(
      snapshot({
        status: "running",
        activeRun: null,
        sessions: [
          {
            id: "session",
            label: "Existing",
            modelId: "original",
            toolsMode: "none",
            history: [],
            unfinished: { queryId: "saved-query", status: "running" },
          },
        ],
      }),
    );
    const controller = createWorkspaceController(bridge.api);
    render(<Workspace controller={controller} />);
    const resume = await screen.findByRole("button", { name: "继续任务" });
    expect(bridge.api.resume).not.toHaveBeenCalled();
    act(() => controller.setDraft("不要建立第二个请求"));
    expect(screen.getByRole("button", { name: "停止任务" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(resume);
    await waitFor(() =>
      expect(bridge.api.resume).toHaveBeenCalledWith({
        sessionId: "session",
        queryId: "saved-query",
      }),
    );
    expect(bridge.api.run).not.toHaveBeenCalled();
    expect(controller.getState().drafts[draftKey(controller.getState())]).toBe(
      "不要建立第二个请求",
    );
  });

  it("首发创建真实会话后若运行失败，草稿迁移到该会话而不是丢失", async () => {
    const bridge = host(snapshot({ sessions: [], selectedSessionId: null }));
    const created = snapshot({ revision: 2 });
    vi.mocked(bridge.api.newSession).mockResolvedValueOnce(ok(created));
    vi.mocked(bridge.api.run).mockResolvedValueOnce({
      ok: false,
      error: { code: "MODEL_UNAVAILABLE", message: "绑定模型暂不可用" },
    });
    const controller = createWorkspaceController(bridge.api);
    render(<Workspace controller={controller} />);
    await waitFor(() => expect(controller.getState().loading).toBe(false));
    fireEvent.change(screen.getByRole("textbox", { name: "任务输入" }), {
      target: { value: "新会话草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
    await screen.findByText("绑定模型暂不可用");
    expect(controller.getState().composingNew).toBe(false);
    expect((screen.getByRole("textbox", { name: "任务输入" }) as HTMLTextAreaElement).value).toBe(
      "新会话草稿",
    );
  });

  it.each(["initial", "initial-error", "models", "models-error"] as const)(
    "%s 旧快照跨卸载重订阅不能替换新 scope",
    async (source) => {
      const bridge = host(snapshot({ scopeId: "old" }));
      const delayed = Promise.withResolvers<HarnessReply<HarnessSnapshot>>();
      if (source.startsWith("initial"))
        vi.mocked(bridge.api.snapshot).mockReturnValueOnce(delayed.promise);
      const controller = createWorkspaceController(bridge.api);
      const first = render(<Workspace controller={controller} />);
      let refreshing: Promise<void> | undefined;
      if (source.startsWith("models")) {
        await waitFor(() => expect(controller.getState().loading).toBe(false));
        vi.mocked(bridge.api.snapshot).mockReturnValueOnce(delayed.promise);
        act(() => {
          refreshing = controller.refreshModels();
        });
      }
      first.unmount();
      bridge.setSnapshot(snapshot({ scopeId: "new", revision: 1 }));
      render(<Workspace controller={controller} />);
      await waitFor(() => expect(controller.getState().snapshot?.scopeId).toBe("new"));
      fireEvent.change(screen.getByRole("textbox", { name: "任务输入" }), {
        target: { value: "新代草稿" },
      });
      await act(async () => {
        if (source.endsWith("error")) delayed.reject(new Error("old-snapshot-error"));
        else
          delayed.resolve(
            ok(
              snapshot({
                scopeId: "old",
                revision: 999,
                models: [{ id: "old-model", label: "Old" }],
              }),
            ),
          );
        await refreshing;
      });
      expect(controller.getState().snapshot?.scopeId).toBe("new");
      expect(controller.getState().models[0].id).toBe("original");
      expect(controller.getState().loading).toBe(false);
      expect((screen.getByRole("textbox", { name: "任务输入" }) as HTMLTextAreaElement).value).toBe(
        "新代草稿",
      );
      expect(bridge.api.cancel).not.toHaveBeenCalled();
    },
  );

  it("确认 scope 后拒绝未知 scope 的事件、刷新和切换回包", async () => {
    const bridge = host(snapshot());
    const controller = createWorkspaceController(bridge.api);
    render(<Workspace controller={controller} />);
    await waitFor(() => expect(controller.getState().loading).toBe(false));
    fireEvent.change(screen.getByRole("textbox", { name: "任务输入" }), {
      target: { value: "当前选择草稿" },
    });
    const foreign = snapshot({
      scopeId: "unknown",
      revision: 1000,
      selectedSessionId: null,
      sessions: [],
      models: [{ id: "foreign", label: "Foreign" }],
    });
    act(() => bridge.publish(foreign));
    await act(() => controller.refreshModels());
    await act(() => controller.selectWorkspace("foreign-workspace"));
    await act(() => controller.selectSession("foreign-session"));
    await act(() => controller.chooseWorkspace());
    expect(controller.getState().snapshot?.scopeId).toBe("scope");
    expect(controller.getState().snapshot?.selectedSessionId).toBe("session");
    expect(controller.getState().composingNew).toBe(false);
    expect(controller.getState().models[0].id).toBe("original");
    expect((screen.getByRole("textbox", { name: "任务输入" }) as HTMLTextAreaElement).value).toBe(
      "当前选择草稿",
    );
  });

  it.each([
    "chooseWorkspace",
    "selectWorkspace",
    "selectSession",
    "newSession",
    "run",
    "resume",
    "cancel",
  ] as const)("%s 旧异常和 finally 不清理新代在途命令", async (method) => {
    const initial =
      method === "newSession"
        ? snapshot({ sessions: [], selectedSessionId: null })
        : method === "resume" || method === "cancel"
          ? snapshot({
              status: "running",
              activeRun: method === "cancel" ? identity : null,
              sessions: [
                {
                  ...snapshot().sessions[0],
                  unfinished: { queryId: "query", status: "running" },
                },
              ],
            })
          : snapshot();
    const bridge = host(initial);
    const old = Promise.withResolvers<never>();
    vi.mocked(bridge.api[method]).mockReturnValueOnce(old.promise);
    const controller = createWorkspaceController(bridge.api);
    const first = render(<Workspace controller={controller} />);
    await waitFor(() => expect(controller.getState().loading).toBe(false));
    let previous: Promise<void> = Promise.resolve();
    act(() => {
      controller.setDraft("旧代任务");
      previous =
        method === "chooseWorkspace"
          ? controller.chooseWorkspace()
          : method === "selectWorkspace"
            ? controller.selectWorkspace("other")
            : method === "selectSession"
              ? controller.selectSession("other")
              : method === "resume"
                ? controller.resume()
                : method === "cancel"
                  ? controller.cancel()
                  : controller.send();
    });
    expect(controller.getState().pending).toBe(true);
    first.unmount();
    bridge.setSnapshot(snapshot({ scopeId: "new" }));
    render(<Workspace controller={controller} />);
    await waitFor(() => expect(controller.getState().snapshot?.scopeId).toBe("new"));
    const current = Promise.withResolvers<HarnessReply<HarnessIdentity>>();
    vi.mocked(bridge.api.run).mockReturnValueOnce(current.promise);
    fireEvent.change(screen.getByRole("textbox", { name: "任务输入" }), {
      target: { value: "新代任务" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
    expect(controller.getState().pending).toBe(true);
    await act(async () => {
      old.reject(new Error("old-generation-private-error"));
      await previous;
    });
    expect(controller.getState().pending).toBe(true);
    expect(controller.getState().error).toBeNull();
    expect(controller.getState().snapshot?.scopeId).toBe("new");
    expect((screen.getByRole("textbox", { name: "任务输入" }) as HTMLTextAreaElement).value).toBe(
      "新代任务",
    );
    await act(async () => {
      current.resolve({
        ok: false,
        error: { code: "MODEL_UNAVAILABLE", message: "新代模型不可用" },
      });
    });
    expect(controller.getState().pending).toBe(false);
    expect(screen.getByText("新代模型不可用")).toBeTruthy();
  });

  it.each(["newSession", "run"] as const)(
    "%s 旧成功回包不能迁移或删除重订阅后的草稿",
    async (method) => {
      const bridge = host(
        snapshot({
          ...(method === "newSession" ? { sessions: [], selectedSessionId: null } : {}),
        }),
      );
      const created = Promise.withResolvers<HarnessReply<HarnessSnapshot>>();
      const run = Promise.withResolvers<HarnessReply<HarnessIdentity>>();
      if (method === "newSession")
        vi.mocked(bridge.api.newSession).mockReturnValueOnce(created.promise);
      else vi.mocked(bridge.api.run).mockReturnValueOnce(run.promise);
      const controller = createWorkspaceController(bridge.api);
      const first = render(<Workspace controller={controller} />);
      await waitFor(() => expect(controller.getState().loading).toBe(false));
      let sending: Promise<void> = Promise.resolve();
      act(() => {
        controller.setDraft("相同文本也不属于旧命令");
        sending = controller.send();
      });
      first.unmount();
      bridge.setSnapshot(snapshot({ scopeId: "new" }));
      render(<Workspace controller={controller} />);
      await waitFor(() => expect(controller.getState().snapshot?.scopeId).toBe("new"));
      fireEvent.change(screen.getByRole("textbox", { name: "任务输入" }), {
        target: { value: "相同文本也不属于旧命令" },
      });
      await act(async () => {
        if (method === "newSession") created.resolve(ok(snapshot({ revision: 2 })));
        else run.resolve(ok(identity));
        await sending;
      });
      expect(controller.getState().snapshot?.scopeId).toBe("new");
      expect(controller.getState().drafts.session).toBe("相同文本也不属于旧命令");
      expect(bridge.api.run).toHaveBeenCalledTimes(method === "run" ? 1 : 0);
    },
  );

  it("晚到旧 Run 结算必须匹配完整身份，不能清预览或刷新当前 Run", async () => {
    const running = snapshot({ status: "running", activeRun: identity });
    const bridge = host(running);
    const controller = createWorkspaceController(bridge.api);
    render(<Workspace controller={controller} />);
    await waitFor(() => expect(controller.getState().loading).toBe(false));
    act(() => {
      bridge.emit({
        type: "text.delta",
        scopeId: "scope",
        identity,
        text: "当前预览",
        reasoning: false,
      });
      bridge.emit({
        type: "tool.status",
        scopeId: "scope",
        identity,
        callId: "call",
        name: "read",
        status: "dispatched",
      });
    });
    const reads = vi.mocked(bridge.api.snapshot).mock.calls.length;
    bridge.setSnapshot(snapshot({ revision: 2 }));
    await act(async () => {
      for (const oldIdentity of [
        { ...identity, agentId: "old-agent" },
        { ...identity, threadId: "old-thread" },
        { ...identity, queryId: "old-query" },
        { ...identity, runId: "old-run" },
      ])
        bridge.emit({
          type: "run.settled",
          scopeId: "scope",
          identity: oldIdentity,
          status: "completed",
        });
      bridge.emit({ type: "run.settled", scopeId: "old-scope", identity, status: "completed" });
    });
    expect(screen.getByLabelText("临时输出预览").textContent).toContain("当前预览");
    expect(screen.getByLabelText("工具状态 read")).toBeTruthy();
    expect(controller.getState().snapshot?.activeRun).toEqual(identity);
    expect(bridge.api.snapshot).toHaveBeenCalledTimes(reads);
  });

  it("首发创建与运行等待期间的最新编辑保留，重复发送仅提交原任务一次", async () => {
    const bridge = host(snapshot({ sessions: [], selectedSessionId: null }));
    const created = Promise.withResolvers<HarnessReply<HarnessSnapshot>>();
    const run = Promise.withResolvers<HarnessReply<HarnessIdentity>>();
    vi.mocked(bridge.api.newSession).mockReturnValueOnce(created.promise);
    vi.mocked(bridge.api.run).mockReturnValueOnce(run.promise);
    const controller = createWorkspaceController(bridge.api);
    render(<Workspace controller={controller} />);
    await waitFor(() => expect(controller.getState().loading).toBe(false));
    const input = screen.getByRole("textbox", { name: "任务输入" });
    fireEvent.change(input, { target: { value: "  实际提交  " } });
    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
    fireEvent.change(input, { target: { value: "创建期间的新草稿" } });
    await act(() => controller.send());
    await act(async () => created.resolve(ok(snapshot({ revision: 2 }))));
    expect(bridge.api.newSession).toHaveBeenCalledTimes(1);
    expect(bridge.api.run).toHaveBeenCalledWith({ sessionId: "session", text: "实际提交" });
    expect(controller.getState().drafts.session).toBe("创建期间的新草稿");
    fireEvent.change(input, { target: { value: "运行期间的最终草稿" } });
    await act(() => controller.send());
    act(() => {
      bridge.publish(snapshot({ revision: 3, status: "running", activeRun: identity }));
      bridge.emit({
        type: "text.delta",
        scopeId: "scope",
        identity,
        text: "首段只显示一次",
        reasoning: false,
      });
    });
    expect(screen.getByLabelText("临时输出预览").textContent).toContain("首段只显示一次");
    act(() =>
      bridge.publish(
        snapshot({
          revision: 4,
          sessions: [
            { ...snapshot().sessions[0], history: [{ role: "assistant", text: "权威完成正文" }] },
          ],
        }),
      ),
    );
    await act(async () => run.resolve(ok(identity)));
    expect(bridge.api.run).toHaveBeenCalledTimes(1);
    expect(controller.getState().snapshot?.revision).toBe(4);
    expect(screen.queryByLabelText("临时输出预览")).toBeNull();
    expect(screen.getByText("权威完成正文")).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("运行期间的最终草稿");
  });

  it("重复审批在途只接受当前持久化交互，新交互不沿用旧回答", async () => {
    const waiting = snapshot({
      status: "waiting",
      sessions: [
        {
          ...snapshot().sessions[0],
          unfinished: { queryId: "query", status: "waiting" },
        },
      ],
      pendingApproval: {
        queryId: "query",
        interactionId: "first",
        supported: true,
        summary: "首次审批",
        choices: [
          { id: "allow", label: "同意" },
          { id: "reject", label: "拒绝" },
        ],
      },
    });
    const bridge = host(waiting);
    const reply = Promise.withResolvers<HarnessReply<HarnessIdentity>>();
    vi.mocked(bridge.api.resume).mockReturnValueOnce(reply.promise);
    const controller = createWorkspaceController(bridge.api);
    render(<Workspace controller={controller} />);
    const approve = await screen.findByRole("button", { name: "批准" });
    fireEvent.click(approve);
    fireEvent.click(approve);
    await act(() => controller.resume("reject"));
    expect(bridge.api.resume).toHaveBeenCalledTimes(1);
    expect(bridge.api.resume).toHaveBeenLastCalledWith({
      sessionId: "session",
      queryId: "query",
      interactionId: "first",
      choiceId: "allow",
    });
    act(() =>
      bridge.publish({
        ...waiting,
        revision: 2,
        pendingApproval: {
          ...waiting.pendingApproval!,
          interactionId: "second",
          summary: "第二次审批",
        },
      }),
    );
    await act(async () => reply.resolve(ok(identity)));
    expect(bridge.api.resume).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(bridge.api.resume).toHaveBeenCalledTimes(2));
    expect(bridge.api.resume).toHaveBeenLastCalledWith({
      sessionId: "session",
      queryId: "query",
      interactionId: "second",
      choiceId: "reject",
    });
  });
});
