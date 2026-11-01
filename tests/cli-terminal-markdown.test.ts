import { describe, expect, it } from "vitest";
import { markdownLines } from "../cli/terminal/terminal-markdown.js";
import { graphemes, visibleWidth } from "../cli/terminal/terminal-text.js";

const sgr = /\x1b\[[\d;]*m/g;

describe("terminal Markdown presentation", () => {
  it("renders nested inline styles, references and literal HTML without terminal actions", () => {
    const source = [
      "# Title",
      "",
      "**bold *nested* end** with `a_b` and ~~gone~~ [docs][ref].",
      "",
      "[ref]: https://example.com/docs",
      "",
      '<script>alert("x")</script>',
      "",
      "&#27;[2J [unsafe](javascript:alert) \x1b]52;c;secret\x07",
    ].join("\n");
    const styled = markdownLines(source, 100, true, true).join("\n");
    const plain = styled.replace(sgr, "");
    expect(plain).toContain("bold nested end with a_b and gone docs (https://example.com/docs).");
    expect(plain).toContain('<script>alert("x")</script>');
    expect(plain).toContain("\\x1b]52;c;secret\\a");
    expect(plain).toContain("unsafe (javascript:alert)");
    expect(plain).not.toContain("\x1b");
    expect(styled).toContain("\x1b[1;3m");
    expect(styled).toContain("\x1b[1m end\x1b[0m");
    expect(markdownLines(source, 100, true).join("\n")).not.toContain("\x1b");
  });

  it("keeps ordered, nested and task list continuations under their content", () => {
    const lines = markdownLines(
      "9. abcdefghijklmnop\n   - nested\n10. next\n\n- [x] complete\n- [ ] pending\n\n> **quote**",
      12,
      true,
    );
    expect(lines).toContain("9. abcdefghi");
    expect(lines).toContain("   jklmnop");
    expect(lines).toContain("   • nested");
    expect(lines).toContain("10. next");
    expect(lines).toContain("• [x] comple");
    expect(lines).toContain("      te");
    expect(lines).toContain("│ quote");
    expect(lines.every((line) => visibleWidth(line) <= 12)).toBe(true);
  });

  for (const width of [12, 20, 40, 80]) {
    it(`fits aligned CJK/emoji tables without losing cell text at ${width} columns`, () => {
      const source = "| 名称 | 值 |\n| :--- | ---: |\n| 中文👩‍💻é | 42 |\n| a\\|b | 7 |";
      const lines = markdownLines(source, width, true, true).map((line) => line.replace(sgr, ""));
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      const text = lines.join("\n");
      expect(text).toContain("👩‍💻");
      expect(text).toContain("42");
      if (width >= 20) {
        expect(text).toContain("a|b");
        expect(text).toContain("中文👩‍💻é");
        expect(lines.find((line) => line.includes("42"))).toMatch(/42 │$/u);
        expect(lines[0]).toMatch(/^┌.*┐$/u);
        expect(lines.at(-1)).toMatch(/^└.*┘$/u);
      }
    });
  }

  it("never invents a closing fence while streaming and preserves code in scrollback", () => {
    const code = `  const 文 = '👩‍💻';\t// ${"a".repeat(60)}`;
    const open = `~~~~ts\n${code}`;
    const partial = markdownLines(open, 20, true, true).map((line) => line.replace(sgr, ""));
    expect(partial.filter((line) => /^~{4}/.test(line))).toEqual(["~~~~ts"]);
    expect(partial.every((line) => visibleWidth(line) <= 20)).toBe(true);
    expect(partial.flatMap(graphemes)).toContain("👩‍💻");
    expect(markdownLines(`${open}\n~~~~`, 20)).toContain(code);
    expect(markdownLines(`${open}\n~~~~`, 20).at(-1)).toBe("~~~~");
    expect(markdownLines("```text\n**literal** [x](url)\n```", 80)).toContain(
      "**literal** [x](url)",
    );
  });

  it("retains loose-list markers and bounds tab expansion inside narrow code", () => {
    const lines = markdownLines("- first\n\n- second", 20, true);
    expect(lines).toEqual(["• first", "", "• second"]);
    const code = markdownLines("```\na\tb\n```", 2, true);
    expect(code.every((line) => visibleWidth(line) <= 2)).toBe(true);
    expect(code.slice(2, -2).join("")).toBe("a   b");
  });
});
