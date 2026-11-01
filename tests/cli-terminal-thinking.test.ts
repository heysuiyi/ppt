import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { visibleWidth } from "../cli/terminal/terminal-text.js";
import { renderThinkingBlock } from "../cli/terminal/thinking-block.js";

// 思考是轻量折叠文本，不应借用文件工具的卡框或在默认视图泄露折叠正文。
describe("borderless public thinking", () => {
  it("keeps collapsed previews to one line even in a one-row viewport", () => {
    const block = renderThinkingBlock("THOUGHT_BODY", 40, {
      color: false,
      live: true,
      maxRows: 1,
    });
    expect(block.lines).toHaveLength(1);
    expect(block.lines[0]).toContain("▸");
    expect(block.lines[0]).toContain("Ctrl+T");
    expect(block.lines.join("\n")).not.toMatch(/[╭╮╰╯│─]/u);
    expect(block.lines.join("\n")).not.toContain("THOUGHT_BODY");
  });

  for (const width of [40, 80, 120]) {
    for (const color of [false, true]) {
      it(`pages indented thought text within ${width} columns, color=${color}`, () => {
        const source = Array.from({ length: 17 }, (_, index) => `ROW_${index}_中文👩‍💻é`);
        const first = renderThinkingBlock(source.join("\n"), width, {
          color,
          expanded: true,
          maxRows: 6,
        });
        const visible: string[] = [];
        for (let page = 0; page < first.pages; page += 1) {
          const block = renderThinkingBlock(source.join("\n"), width, {
            color,
            expanded: true,
            maxRows: 6,
            page,
          });
          const lines = block.lines.map(stripVTControlCharacters);
          expect(lines.length).toBeLessThanOrEqual(6);
          expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
          expect(lines[0]).toContain("▾");
          expect(lines.join("\n")).not.toMatch(/[╭╮╰╯│─]/u);
          expect(lines.at(-1)).toContain("Esc");
          expect(lines.slice(1, -1).every((line) => line.startsWith("  "))).toBe(true);
          visible.push(...lines.slice(1, -1).map((line) => line.slice(2)));
          if (!color) expect(block.lines.join("\n")).not.toContain("\x1b");
        }
        expect(visible).toEqual(source);
      });
    }
  }
});
