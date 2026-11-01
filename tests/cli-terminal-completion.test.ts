import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { renderCommandCompletions } from "../cli/terminal/completion-list.js";
import type { TerminalSelectorView } from "../cli/terminal/renderer-contract.js";
import { visibleWidth } from "../cli/terminal/terminal-text.js";

describe("slash completion visual-row viewport", () => {
  it("keeps a two-row selected tail item together and scrolls to the visual endpoint", () => {
    const items = [
      { id: "one", label: "/one", description: "SHORT" },
      { id: "two", label: "/two", description: "中".repeat(30) },
      { id: "three", label: "/three", description: "SHORT" },
      { id: "last", label: "/last", description: `WRAPPED_START${"中".repeat(18)}WRAPPED_END` },
    ];
    const selector: TerminalSelectorView = { title: "", query: "/", items, selectedId: "last" };
    const lines = renderCommandCompletions(selector, 60, 3, true).map(stripVTControlCharacters);
    expect(lines).toHaveLength(3);
    const selected = lines.findIndex((line) => line.includes("/last"));
    expect(selected).toBeGreaterThanOrEqual(0);
    expect(lines[selected]).toContain("WRAPPED_START");
    expect(lines[selected + 1]).toContain("WRAPPED_END");
    expect(lines.at(-1)?.endsWith("█")).toBe(true);
    expect(lines.every((line) => visibleWidth(line) === 60)).toBe(true);
  });

  it("bounds oversized unicode descriptions, escapes terminal controls and keeps narrow commands selectable", () => {
    const selector: TerminalSelectorView = {
      title: "",
      query: "/",
      selectedId: "wide",
      items: [
        { id: "wide", label: "/wide", description: `\x1b]52;c;SECRET\x07 ${"中👩‍💻é".repeat(40)}` },
      ],
    };
    const lines = renderCommandCompletions(selector, 60, 10, false);
    expect(lines).toHaveLength(2);
    expect(lines.join("")).not.toMatch(/[\x00-\x1f\x7f]/u);
    expect(lines[0]).toContain("\\x1b]52;c;SECRET\\a");
    expect(lines.at(-1)?.endsWith("…")).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
    expect(lines.join("")).not.toContain("�");
    const narrow = renderCommandCompletions(selector, 39, 3, false);
    expect(narrow).toHaveLength(1);
    expect(narrow[0]).toContain("/wide");
    expect(narrow[0]).not.toContain("SECRET");
    expect(renderCommandCompletions(selector, 39, 0, false)).toEqual([]);
  });
});
