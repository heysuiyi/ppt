// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "../app/renderer/src/ui/components/markdown/Markdown";

function reading(content: string) {
  return (
    <div className="ui-root" data-ui-theme="light">
      <Markdown content={content} />
    </div>
  );
}

afterEach(cleanup);

describe("独立 UI Markdown 阅读", () => {
  it("以真实标题、段落和行内语义呈现内容", () => {
    const view = render(
      reading(
        [
          "# 一级标题",
          "## 二级标题",
          "### 三级标题",
          "#### 四级标题",
          "##### 五级标题",
          "###### 六级标题",
          "",
          "正文包含 **重点**、*强调*、~~已删除~~ 和 `inline()`。",
          "",
          "> 引用内容",
          "",
          "---",
        ].join("\n"),
      ),
    );

    for (let level = 1; level <= 6; level++) {
      expect(screen.getByRole("heading", { level }).textContent).toContain("级标题");
    }
    expect(screen.getByText("重点").tagName).toBe("STRONG");
    expect(screen.getByText("强调").tagName).toBe("EM");
    expect(screen.getByText("已删除").tagName).toBe("DEL");
    expect(screen.getByText("inline()").tagName).toBe("CODE");
    expect(screen.getByText("引用内容").closest("blockquote")).not.toBeNull();
    expect(view.container.querySelector("hr")).not.toBeNull();
  });

  it("保留列表层级、起始编号、任务状态和表格结构", () => {
    const view = render(
      reading(
        [
          "3. 第三项",
          "   - 嵌套项目",
          "4. 第四项",
          "",
          "- [x] 已处理",
          "- [ ] 待处理",
          "",
          "| 名称 | 数量 |",
          "| :--- | ---: |",
          "| 项目 A | 42 |",
        ].join("\n"),
      ),
    );

    expect(view.container.querySelector("ol")?.start).toBe(3);
    expect(screen.getByText("嵌套项目").closest("ul")?.parentElement?.tagName).toBe("LI");
    const checked = screen.getByRole<HTMLInputElement>("checkbox", { name: "已完成任务" });
    const pending = screen.getByRole<HTMLInputElement>("checkbox", { name: "未完成任务" });
    expect(checked.checked).toBe(true);
    expect(pending.checked).toBe(false);
    expect(checked.disabled && pending.disabled).toBe(true);
    const table = screen.getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["名称", "数量"]);
    expect(within(table).getByRole("cell", { name: "42" }).style.textAlign).toBe("right");
    expect(screen.getByRole("region", { name: "表格" }).contains(table)).toBe(true);
    expect(screen.getByRole("region", { name: "表格" }).tabIndex).toBe(0);
  });

  it("将恶意块级和行内 HTML 作为可读文字，不创建可执行 DOM", () => {
    const html =
      '<script>alert("unsafe")</script>\n\n<div><img src="https://tracking.invalid/pixel" onerror="alert(1)"></div>';
    const inline =
      '文字 <a href="javascript:alert(1)">伪链接</a> 和 <iframe src="https://tracking.invalid"></iframe>';
    const view = render(reading(`${html}\n\n${inline}`));

    expect(view.container.textContent).toContain(html.split("\n\n")[0]);
    expect(view.container.textContent).toContain(
      '<img src="https://tracking.invalid/pixel" onerror="alert(1)">',
    );
    expect(view.container.textContent).toContain(inline);
    expect(view.container.querySelector("script, img, iframe, a, [onerror]")).toBeNull();
  });

  it("只允许安全链接，并通过显式图片链接代替自动加载图片", () => {
    const view = render(
      reading(
        [
          '[正常](https://example.com/docs "说明") [邮件](mailto:reader@example.com) [锚点](#details)',
          "[脚本](javascript:alert%281%29) [实体脚本](jav&#x61;script:alert%281%29)",
          "[数据](data:text/html;base64,PHNjcmlwdD4=) [本地文件](file:///tmp/private)",
          "[参考链接][docs] ![远程示意图](https://tracking.invalid/diagram.png)",
          "![危险图片](javascript:alert%281%29) ![引用图片][picture]",
          "",
          "[docs]: https://example.com/reference",
          "[picture]: https://tracking.invalid/reference.png",
        ].join("\n"),
      ),
    );

    const external = screen.getByRole("link", { name: "正常" });
    expect(external.getAttribute("href")).toBe("https://example.com/docs");
    expect(external.getAttribute("title")).toBe("说明");
    expect(external.getAttribute("target")).toBe("_blank");
    expect(external.getAttribute("rel")).toContain("noopener");
    expect(external.getAttribute("rel")).toContain("noreferrer");
    expect(external.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.getByRole("link", { name: "邮件" }).getAttribute("href")).toBe(
      "mailto:reader@example.com",
    );
    expect(screen.getByRole("link", { name: "锚点" }).getAttribute("target")).toBeNull();
    expect(screen.getByRole("link", { name: "参考链接" }).getAttribute("href")).toBe(
      "https://example.com/reference",
    );
    for (const label of ["脚本", "实体脚本", "数据", "本地文件"]) {
      expect(screen.getByText(label).closest("a")).toBeNull();
    }
    expect(screen.getByRole("link", { name: "图片：远程示意图" }).getAttribute("href")).toBe(
      "https://tracking.invalid/diagram.png",
    );
    expect(screen.getByRole("link", { name: "图片：引用图片" }).getAttribute("href")).toBe(
      "https://tracking.invalid/reference.png",
    );
    expect(screen.getByText("图片：危险图片").closest("a")).toBeNull();
    expect(view.container.querySelector("img, video, audio, iframe, source")).toBeNull();
  });

  it("让代码保持可复制的字面文本，不将其中的 HTML 或链接解释为内容", () => {
    const source = 'const sample = "<img src=x onerror=alert(1)>";\n  return sample;';
    const view = render(reading(`\`\`\`tsx\n${source}\n\`\`\``));
    const pre = screen.getByLabelText("代码块");

    expect(pre.tagName).toBe("PRE");
    expect(pre.tabIndex).toBe(0);
    expect(pre.querySelector("code")?.textContent).toBe(`${source}\n`);
    expect(view.container.querySelector("img, a")).toBeNull();
  });

  it("不同回答的同名脚注跳转到各自的内容", () => {
    render(
      <div>
        <article aria-label="第一条回答">
          <Markdown content={"第一条[^note]\n\n[^note]: 第一条的注释"} />
        </article>
        <article aria-label="第二条回答">
          <Markdown content={"第二条[^note]\n\n[^note]: 第二条的注释"} />
        </article>
      </div>,
    );
    for (const name of ["第一条回答", "第二条回答"]) {
      const article = screen.getByRole("article", { name });
      const reference = within(article).getByRole("link", { name: "1" });
      const targetId = reference.getAttribute("href")!.slice(1);
      const target = document.getElementById(targetId);
      expect(target).not.toBeNull();
      expect(article.contains(target)).toBe(true);
    }
  });

  it("随流更新重新解析未闭合强调与代码块，不补造内容且可清空历史", () => {
    const view = render(reading("开始 **尚未结束"));
    expect(view.container.textContent).toBe("开始 **尚未结束");
    expect(view.container.querySelector("strong")).toBeNull();

    view.rerender(reading("开始 **已经结束**"));
    expect(screen.getByText("已经结束").tagName).toBe("STRONG");

    const code = 'const text = "<b>尚未结束";';
    view.rerender(reading(`\`\`\`ts\n${code}`));
    expect(screen.getByLabelText("代码块").querySelector("code")?.textContent).toBe(`${code}\n`);
    expect(view.container.querySelector("b")).toBeNull();

    view.rerender(reading(`\`\`\`ts\n${code}\n\`\`\`\n\n完成后的 **说明**`));
    expect(screen.getByLabelText("代码块").querySelector("code")?.textContent).toBe(`${code}\n`);
    expect(screen.getByText("说明").tagName).toBe("STRONG");
    expect(view.container.textContent).not.toContain("```");

    view.rerender(reading(""));
    expect(view.container.textContent).toBe("");
    expect(screen.queryByLabelText("代码块")).toBeNull();
  });
});
