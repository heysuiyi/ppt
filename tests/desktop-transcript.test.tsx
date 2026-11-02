// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopTranscript } from "../app/renderer/src/desktop/DesktopTranscript";
import type { HarnessHistoryEntry, HarnessIdentity } from "../app/shared/harness-ipc";

afterEach(cleanup);

const identity: HarnessIdentity = { agentId: "a", threadId: "t", queryId: "q", runId: "r" };
const read: HarnessHistoryEntry = {
  role: "tool",
  tool: {
    name: "read",
    callId: "read",
    result: "recorded",
    status: "completed",
    display: { title: "README.md", input: [], output: ["safe document"] },
  },
};

describe("对话过程分组", () => {
  it("按用户轮次独立折叠，保留过程中间正文的次序且不隐藏最终回答", () => {
    const history: HarnessHistoryEntry[] = [
      { role: "user", text: "first request" },
      { role: "reasoning", text: "first thought" },
      read,
      { role: "assistant", text: "intermediate explanation" },
      { role: "reasoning", text: "second thought" },
      { role: "assistant", text: "first final answer" },
      { role: "user", text: "second request" },
      { role: "reasoning", text: "independent thought" },
      { role: "assistant", text: "second final answer" },
    ];
    const view = render(
      <DesktopTranscript
        sessionId="s"
        history={history}
        tools={[]}
        preview={null}
        status="completed"
      />,
    );
    const groups = screen.getAllByRole("region", { name: "执行过程" });
    const first = within(groups[0]);
    const steps = first.getByRole("button", { name: "过程步骤" });
    const members = view.container.querySelectorAll(".desktop-process__steps")[0];
    expect(members.textContent?.indexOf("README.md")).toBeLessThan(
      members.textContent!.indexOf("intermediate explanation"),
    );
    expect(members.textContent?.indexOf("intermediate explanation")).toBeLessThan(
      members.textContent!.indexOf("second thought"),
    );
    fireEvent.click(steps);
    expect(first.queryByRole("button", { name: "read 工具详情" })).toBeNull();
    expect(within(groups[1]).getByLabelText("思考").closest("[hidden]")).toBeNull();
    expect(screen.getByText("first final answer").closest("[hidden]")).toBeNull();
    fireEvent.click(first.getByRole("button", { name: "执行过程" }));
    expect(screen.getByText("second final answer").closest("[hidden]")).toBeNull();
    expect(screen.getByText("first request").closest("[hidden]")).toBeNull();
  });

  it("折叠步骤或整轮仍保留错误与未知外部影响，不能把失败操作概括成成功读取", () => {
    const history: HarnessHistoryEntry[] = [
      {
        role: "tool",
        tool: {
          name: "read",
          callId: "failed",
          result: "error",
          status: "unknown",
          effects: "unknown",
          error: { code: "UNCERTAIN", message: "check actual file first" },
        },
      },
      { role: "assistant", text: "inspect before retry" },
    ];
    render(
      <DesktopTranscript
        sessionId="s"
        history={history}
        tools={[]}
        preview={null}
        status="failed"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "过程步骤" }));
    const risk = screen.getByLabelText("过程风险");
    expect(risk.textContent).toContain("UNCERTAIN: check actual file first");
    expect(risk.textContent).toContain("外部影响未知");
    expect(screen.getByRole("button", { name: "过程步骤" }).textContent).not.toContain(
      "已读取文件",
    );
    fireEvent.click(screen.getByRole("button", { name: "执行过程" }));
    expect(risk.closest("[hidden]")).toBeNull();
    expect(screen.getByText("inspect before retry").closest("[hidden]")).toBeNull();
  });

  it("实时过程由持久历史接替后仍保留用户的折叠选择，新会话不继承折叠", () => {
    const view = render(
      <DesktopTranscript
        sessionId="s"
        history={[]}
        tools={[]}
        preview={{ identity, reasoning: "live thought\n", text: "" }}
        status="running"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "执行过程" }));
    view.rerender(
      <DesktopTranscript
        sessionId="s"
        history={[
          { role: "reasoning", text: "committed thought" },
          read,
          { role: "assistant", text: "committed answer" },
        ]}
        tools={[]}
        preview={null}
        status="completed"
      />,
    );
    expect(screen.getByRole("button", { name: "执行过程" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(screen.queryByRole("button", { name: "read 工具详情" })).toBeNull();
    expect(screen.getByText("committed answer").closest("[hidden]")).toBeNull();
    view.rerender(
      <DesktopTranscript
        sessionId="other"
        history={[read]}
        tools={[]}
        preview={null}
        status="completed"
      />,
    );
    expect(screen.getByRole("button", { name: "read 工具详情" })).toBeTruthy();
  });
});
