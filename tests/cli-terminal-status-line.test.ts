import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import type { TerminalView } from "../cli/terminal/renderer-contract.js";
import { contextLines } from "../cli/terminal/status-line.js";
import { visibleWidth } from "../cli/terminal/terminal-text.js";

const view: TerminalView = {
  phase: "idle",
  scene: "conversation",
  input: { purpose: "composer", status: "", hint: "" },
  composer: { draft: { text: "中文", cursor: 1 }, editable: true, submission: { enabled: true } },
  context: {
    workspace: "E:/Coding/ppt",
    threadId: "thread",
    model: "mimo-v2.6-flash",
    capabilities: "none",
  },
};

describe("status band safe layout", () => {
  it("preserves the model and workspace leaf while fitting a long Unicode workspace", () => {
    const long: TerminalView = {
      ...view,
      context: {
        ...view.context!,
        model: "MODEL",
        workspace: `E:/${"中文目录/".repeat(30)}目标👩‍💻`,
      },
    };
    const colored = contextLines(long, 39, true)[0]!;
    const plain = contextLines(long, 39, false)[0]!;
    expect(stripVTControlCharacters(colored)).toBe(plain);
    expect(visibleWidth(plain)).toBeLessThanOrEqual(39);
    expect(plain).toContain("MODEL");
    expect(plain).toContain("…");
    expect(plain.endsWith("目标👩‍💻")).toBe(true);
    expect(plain).not.toContain("�");
    expect(colored.endsWith("\x1b[22;39m")).toBe(true);
  });

  it("escapes untrusted model/path controls before coloring and keeps tiny layouts bounded", () => {
    const unsafe: TerminalView = {
      ...view,
      context: { ...view.context!, model: "MODEL\x1b[2J", workspace: "E:/中\x1b]52;c;PRIVATE\x07" },
    };
    const plain = contextLines(unsafe, 139, false)[0]!;
    const colored = contextLines(unsafe, 139, true)[0]!;
    expect(stripVTControlCharacters(colored)).toBe(plain);
    expect(plain).not.toMatch(/[\x00-\x1f\x7f]/u);
    expect(plain).toContain("\\x1b[2J");
    expect(plain).toContain("\\x1b]52;c;PRIVATE\\a");
    expect(contextLines(unsafe, 0, true)).toEqual([]);
    const tiny = contextLines(unsafe, 1, true)[0]!;
    expect(visibleWidth(stripVTControlCharacters(tiny))).toBeLessThanOrEqual(1);
    expect(contextLines({ ...view, context: undefined }, 79, true)).toEqual([]);
  });
});
