import { stripVTControlCharacters } from "node:util";
import type { RunIdentity } from "@agent-harness/core/protocol-values";
import { describe, expect, it } from "vitest";
import { canGroupRead, readToolGroupLines } from "../cli/terminal/read-tool-group.js";
import type { TerminalToolRecord } from "../cli/terminal/terminal-contract.js";
import { visibleWidth } from "../cli/terminal/terminal-text.js";

const identity: RunIdentity = {
  agentId: "agent",
  threadId: "thread",
  queryId: "query",
  runId: "run",
};

function read(index: number, title = `file-${index}.txt`): TerminalToolRecord {
  return {
    version: 1,
    type: "tool",
    identity,
    invocationIdentity: identity,
    callId: `call-${index}`,
    name: "read",
    toolVersion: "1",
    step: index,
    phase: "completed",
    status: "succeeded",
    effects: "none",
    display: {
      title,
      input: ["PRIVATE_INPUT"],
      summary: ["PRIVATE_SUMMARY"],
      output: ["PRIVATE_OUTPUT"],
    },
  };
}

function failed(index: number): TerminalToolRecord {
  return {
    ...read(index),
    phase: "completed",
    status: "failed",
    effects: "applied",
    error: { code: "PRIVATE_ERROR_CODE", message: "PRIVATE_ERROR_MESSAGE" },
  };
}

function unknown(index: number): TerminalToolRecord {
  return {
    ...read(index),
    phase: "completed",
    status: "unknown",
    effects: "unknown",
    error: { code: "PRIVATE_ERROR_CODE", message: "PRIVATE_ERROR_MESSAGE" },
  };
}

function frame(lines: readonly string[], columns: number): string[] {
  const plain = lines.map(stripVTControlCharacters);
  expect(plain.length).toBeGreaterThanOrEqual(3);
  expect(plain[0]).toMatch(/^╭.*╮$/u);
  expect(plain.at(-1)).toMatch(/^╰.*╯$/u);
  for (const line of plain.slice(1, -1)) expect(line).toMatch(/^│.*│$/u);
  for (const line of plain) expect(visibleWidth(line)).toBe(columns);
  return plain;
}

describe("safe consecutive read group presentation", () => {
  it("accepts only the installed read name, version and complete safe display shape", () => {
    expect(canGroupRead(read(1))).toBe(true);
    expect(canGroupRead({ ...read(1), phase: "started" })).toBe(true);
    for (const name of [
      "tools.read",
      "file_read",
      "Read",
      "glob",
      "grep",
      "write",
      "edit",
      "unknown",
    ])
      expect(canGroupRead({ ...read(1), name })).toBe(false);
    for (const toolVersion of [null, "0", "2", "01"])
      expect(canGroupRead({ ...read(1), toolVersion })).toBe(false);
    for (const display of [
      undefined,
      null,
      {},
      { title: "", input: [], output: [] },
      { title: " \n\t", input: [], output: [] },
      { title: 42, input: [], output: [] },
      { title: "safe", output: [] },
      { title: "safe", input: [] },
      { title: "safe", input: [42], output: [] },
      { title: "safe", input: [], output: [null] },
      { title: "safe", input: [], output: [], summary: "raw" },
      { title: "safe", input: [], output: [], summary: [false] },
    ]) {
      const tool = { ...read(1), display } as unknown as TerminalToolRecord;
      expect(canGroupRead(tool)).toBe(false);
      expect(readToolGroupLines([read(2), tool], 80, { color: false })).toEqual([]);
    }
    expect(readToolGroupLines([], 80, { color: false })).toEqual([]);
  });

  for (const columns of [40, 80, 120])
    for (const color of [false, true]) {
      it(`keeps ${columns}-column ${color ? "colored" : "plain"} frames closed and counts actual hidden calls`, () => {
        const tools = Array.from({ length: 8 }, (_, index) => read(index + 1));
        const lines = readToolGroupLines(tools, columns, { color });
        const text = frame(lines, columns).join("\n");
        expect(text).toContain("读取 8 项");
        expect(text).toContain("已完成 8");
        expect(text).toContain("file-8.txt");
        const shown = text.match(/#\d+/gu)?.length ?? 0;
        expect(text).toContain(`${tools.length - shown} 个目标未展开`);
        expect(text).toContain("Ctrl+O 查看最新工具");
        expect(text).toContain("/tools-output 逐个选择");
        expect(text).not.toContain("PRIVATE_");
        if (!color || process.env.NO_COLOR !== undefined)
          expect(lines.join("")).not.toContain("\x1b");
        else expect(lines.join("")).toContain("\x1b[");
      });

      it(`never exceeds finite row budgets at ${columns} columns with color=${color}`, () => {
        const tools = [read(1), read(2), read(3), read(4), failed(5), unknown(6)];
        for (let maxRows = 0; maxRows <= 20; maxRows += 1) {
          const lines = readToolGroupLines(tools, columns, { color, maxRows: maxRows + 0.75 });
          expect(lines.length).toBeLessThanOrEqual(maxRows);
          if (lines.length === 0) continue;
          const text = frame(lines, columns).join("\n");
          expect(text).toContain("#5 失败 · 已产生外部影响");
          expect(text).toContain("#6 结果未知 · 外部影响未知");
          expect(text).toContain("Ctrl+O 查看最新工具");
          expect(text).toContain("/tools-output 逐个选择");
          const shown = text.match(/#\d+/gu)?.length ?? 0;
          expect(text).toContain(`${tools.length - shown} 个目标未展开`);
        }
        expect(readToolGroupLines(tools, columns, { color, maxRows: 20 }).length).toBeGreaterThan(
          0,
        );
      });
    }

  it("keeps every failed/uncertain invocation and effect individually visible beyond the ordinary preview", () => {
    const tools: TerminalToolRecord[] = [
      read(1),
      read(2),
      read(3),
      read(4),
      failed(5),
      unknown(6),
      { ...read(7), phase: "completed", status: "succeeded", effects: "applied" },
      { ...read(8), phase: "completed", status: "succeeded", effects: "unknown" },
      { ...read(9), phase: "started" },
    ];
    const text = frame(readToolGroupLines(tools, 80, { color: false }), 80).join("\n");
    expect(text).toContain("失败 1");
    expect(text).toContain("结果未知 1");
    expect(text).toContain("执行中 1");
    expect(text).toContain("已完成 6");
    expect(text).toContain("已产生外部影响 2");
    expect(text).toContain("外部影响未知 2");
    expect(text).toContain("#5 失败 · 已产生外部影响 · file-5.txt");
    expect(text).toContain("#6 结果未知 · 外部影响未知 · file-6.txt");
    expect(text).toContain("#7 已完成 · 已产生外部影响 · file-7.txt");
    expect(text).toContain("#8 已完成 · 外部影响未知 · file-8.txt");
    const shown = text.match(/#\d+/gu)?.length ?? 0;
    expect(text).toContain(`${tools.length - shown} 个目标未展开`);
    expect(text).not.toContain("PRIVATE_");
    // A small viewport must fall back, never silently discard one risky item.
    expect(readToolGroupLines(tools, 80, { color: false, maxRows: 7 })).toEqual([]);
  });

  it("distinguishes repeated/truncated Unicode targets without terminal control injection", () => {
    const title = `${"目录/👩‍💻é/".repeat(20)}\x1b]8;;https://unsafe\x07\r\n\t\u202e`;
    for (const columns of [4, 5, 8, 20, 40, 80, 120]) {
      const text = frame(
        readToolGroupLines([read(1, title), read(2, title)], columns, { color: false }),
        columns,
      ).join("\n");
      expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202e]/u);
      if (columns >= 8) {
        expect(text).toContain("#1");
        expect(text).toContain("#2");
      }
    }
    const controls = "a\x1b[31m\x07\r\n\t\u202e";
    const text = frame(
      readToolGroupLines([read(1, controls), read(2, "other")], 120, { color: false }),
      120,
    ).join("\n");
    expect(text).toContain("\\x1b[31m\\a\\r\\n");
    expect(text).toContain("\\u202e");
  });

  it("never renders raw payloads even when display is missing or extra fields are supplied", () => {
    const tool = {
      ...read(1),
      input: { path: "PRIVATE_RAW_INPUT" },
      result: { content: "PRIVATE_RAW_OUTPUT" },
      replayState: { credentials: "PRIVATE_CREDENTIALS" },
    };
    expect(
      readToolGroupLines([{ ...tool, display: undefined }, read(2)], 80, { color: false }),
    ).toEqual([]);
    const text = readToolGroupLines([tool, read(2)], 80, { color: false }).join("\n");
    expect(text).not.toContain("PRIVATE_");
    expect(text).not.toContain("call-1");
  });

  it("treats omitted and non-finite row limits as unbounded and rejects impossible dimensions", () => {
    const tools = [read(1), failed(2), unknown(3)];
    const unbounded = readToolGroupLines(tools, 40, { color: false });
    expect(unbounded.length).toBeGreaterThan(0);
    for (const maxRows of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN])
      expect(readToolGroupLines(tools, 40, { color: false, maxRows })).toEqual(unbounded);
    for (const columns of [0, 1, 2, 3, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(readToolGroupLines(tools, columns, { color: false })).toEqual([]);
    expect(readToolGroupLines(tools, 40, { color: false, maxRows: -1 })).toEqual([]);
  });
});
