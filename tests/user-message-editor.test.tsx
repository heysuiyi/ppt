import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UserMessageEditor } from "../app/renderer/src/components/UserMessageEditor";

describe("UserMessageEditor", () => {
  it("renders a stable inline editor with branch rerun guidance", () => {
    const html = renderToStaticMarkup(
      <UserMessageEditor
        value="把第二页改成时间线"
        busy={false}
        onChange={vi.fn()}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="编辑已发送的消息"');
    expect(html).toContain('aria-label="修改消息内容"');
    expect(html).toContain("提交后将从这里重新运行");
    expect(html).toContain("把第二页改成时间线");
    expect(html).toContain("提交修改");
  });

  it("disables submission for empty content and while the agent is running", () => {
    const render = (value: string, busy: boolean) =>
      renderToStaticMarkup(
        <UserMessageEditor
          value={value}
          busy={busy}
          onChange={vi.fn()}
          onCancel={vi.fn()}
          onSubmit={vi.fn()}
        />,
      );

    expect(render("   ", false)).toMatch(/<button[^>]*disabled=""[^>]*>提交修改<\/button>/);
    expect(render("有效消息", true)).toMatch(/<button[^>]*disabled=""[^>]*>提交修改<\/button>/);
    expect(render("有效消息", false)).not.toMatch(
      /<button[^>]*disabled=""[^>]*>提交修改<\/button>/,
    );
  });
});
