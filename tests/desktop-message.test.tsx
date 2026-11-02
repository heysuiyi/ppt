// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopMessage } from "../app/renderer/src/desktop/DesktopMessage";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  cleanup();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

describe("桌面消息复制", () => {
  it("等待剪贴板成功后才提示成功，保留 Markdown 原文而非 HTML", async () => {
    const pending = Promise.withResolvers<void>();
    const writeText = vi.fn(() => pending.promise);
    clipboard(writeText);
    const text = "## 标题\n\n**重点** 与 `code`";
    render(<DesktopMessage role="assistant" text={text} />);
    fireEvent.click(screen.getByRole("button", { name: "复制消息原文" }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
    expect(screen.getByRole("status").textContent).toBe("正在复制…");
    await act(async () => pending.resolve());
    expect(screen.getByRole("status").textContent).toBe("已复制到剪贴板");
  });

  it("剪贴板失败允许重试，重试成功后清除失败反馈", async () => {
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValueOnce(undefined);
    clipboard(writeText);
    render(<DesktopMessage role="user" text={"第一行\n第二行"} />);
    fireEvent.click(screen.getByRole("button", { name: "复制消息原文" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("复制失败，请重试"));
    fireEvent.click(screen.getByRole("button", { name: "复制消息原文" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("已复制到剪贴板"));
    expect(writeText).toHaveBeenLastCalledWith("第一行\n第二行");
  });

  it("切换消息后忽略旧复制结果，不把旧成功反馈带入新消息", async () => {
    const old = Promise.withResolvers<void>();
    clipboard(vi.fn(() => old.promise));
    const view = render(<DesktopMessage role="assistant" text="旧回复" />);
    fireEvent.click(screen.getByRole("button", { name: "复制消息原文" }));
    view.rerender(<DesktopMessage role="assistant" text="新回复" />);
    await act(async () => old.resolve());
    expect(screen.getByRole("status").textContent).toBe("");
    expect(
      (screen.getByRole("button", { name: "复制消息原文" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
