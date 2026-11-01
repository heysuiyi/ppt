import { Buffer } from "node:buffer";
import type { AgentRunResult } from "@agent-harness/core/agent-contract";
import { AgentError } from "@agent-harness/core/protocol-errors";
import type { RunIdentity } from "@agent-harness/core/protocol-values";
import type { RuntimeEvent } from "@agent-harness/core/session/session-events";
import { describe, expect, it, vi } from "vitest";
import { composerContentWidth } from "../cli/terminal/composer-layout.js";
import { createTerminalRenderer } from "../cli/terminal/interactive-renderer.js";
import { createPreviewBuffer } from "../cli/terminal/preview-buffer.js";
import type { TerminalOutputMode, TerminalView } from "../cli/terminal/renderer-contract.js";
import type { TerminalToolRecord } from "../cli/terminal/terminal-contract.js";
import { markdownLines } from "../cli/terminal/terminal-markdown.js";
import {
  projectTerminalEvent,
  projectTerminalResult,
  projectTerminalSettlement,
  terminalError,
} from "../cli/terminal/terminal-projection.js";
import {
  graphemes,
  sanitizeTerminalText,
  visibleWidth,
  wrapTerminalText,
} from "../cli/terminal/terminal-text.js";

const identity: RunIdentity = {
  agentId: "agent",
  threadId: "thread",
  queryId: "query",
  runId: "run",
};
const unsupported = () => ({ support: "unsupported" as const });
const idle: TerminalView = {
  phase: "idle",
  scene: "home",
  input: {
    purpose: "composer",
    status: "",
    hint: "",
  },
  composer: {
    draft: { text: "中文👩‍💻é", cursor: 4 },
    editable: true,
    submission: { enabled: true },
  },
  context: { workspace: "C:/项目", threadId: "thread", model: "MiMo", capabilities: "files" },
};

function delta(
  text: string,
  requestId = "request",
  contentIndex = 0,
  run = identity,
): RuntimeEvent {
  return {
    kind: "stream",
    type: "model.delta",
    identity: run,
    step: 1,
    requestId,
    contentIndex,
    delta: { type: "text", text },
  };
}

function capture(mode: TerminalOutputMode, width = 80, rows = 24, color = false) {
  const output: string[] = [];
  const error: string[] = [];
  const failures: unknown[] = [];
  const size = { columns: width, rows };
  const renderer = createTerminalRenderer({
    mode,
    color,
    columns: () => size.columns,
    rows: () => size.rows,
    writeOutput: async (text) => {
      output.push(text);
    },
    writeError: async (text) => {
      error.push(text);
    },
    onOutputError: (failure) => {
      failures.push(failure);
    },
  });
  void renderer.beginRun(identity);
  return { renderer, output, error, size, failures };
}

interface TerminalScreen {
  readonly lines: readonly string[];
  readonly row: number;
  readonly column: number;
  readonly cursorVisible: boolean;
  readonly scrollback: readonly string[];
  readonly alternateScreen: boolean;
}

/** Tracks cells, cursor and DEC 1049 buffers; an optional height also models scrollback. */
function terminalState(
  writes: readonly string[],
  savedHistory: readonly string[] = [],
  rows = Number.POSITIVE_INFINITY,
): TerminalScreen {
  let lines: string[][] = [[]];
  let row = 0;
  let column = 0;
  let cursorVisible = true;
  let scrollback = Array.from(savedHistory);
  let primary: { lines: string[][]; row: number; column: number; scrollback: string[] } | undefined;
  const text = writes.join("");
  for (let index = 0; index < text.length; ) {
    const windowControl = /^\x1b\](?:0;[^\x07]*|9;4;[03];?)\x07/u.exec(text.slice(index));
    if (windowControl) {
      index += windowControl[0].length;
      continue;
    }
    const control = /^\x1b\[([?\d;]*)([A-Za-z])/.exec(text.slice(index));
    if (control) {
      const amount = Number(control[1]) || 1;
      switch (control[2]) {
        case "A":
          row = Math.max(0, row - amount);
          break;
        case "B":
          row = Math.min(rows - 1, row + amount);
          break;
        case "C":
          column += amount;
          break;
        case "H": {
          const [targetRow, targetColumn] = control[1]!.split(";").map(Number);
          row = Math.min(rows - 1, Math.max(0, (targetRow || 1) - 1));
          column = Math.max(0, (targetColumn || 1) - 1);
          break;
        }
        case "J":
          if (control[1] === "2") {
            for (let line = 0; line < lines.length; line++) lines[line] = [];
          }
          if (control[1] === "3") scrollback = [];
          break;
        case "K":
          lines[row] = [];
          break;
        case "h":
        case "l":
          for (const mode of control[1]!.replace(/^\?/u, "").split(";")) {
            if (mode === "25") cursorVisible = control[2] === "h";
            if (mode !== "1049") continue;
            if (control[2] === "h" && !primary) {
              primary = { lines, row, column, scrollback };
              lines = [[]];
              row = 0;
              column = 0;
              scrollback = [];
            } else if (control[2] === "l" && primary) {
              ({ lines, row, column, scrollback } = primary);
              primary = undefined;
            }
          }
          break;
      }
      index += control[0].length;
      continue;
    }
    const character = text[index]!;
    if (character === "\r") {
      column = 0;
      index += 1;
      continue;
    }
    if (character === "\n") {
      row += 1;
      if (row >= rows) {
        const retired = lines.shift()?.join("") ?? "";
        if (!primary) scrollback.push(retired);
        lines[rows - 1] = [];
        row = rows - 1;
      }
      index += 1;
      continue;
    }
    const chunk = /^[^\x1b\r\n]+/.exec(text.slice(index))?.[0];
    if (!chunk) throw new Error("Unsupported terminal control in captured output");
    for (const cluster of graphemes(chunk)) {
      lines[row] ??= [];
      const line = lines[row];
      while (line.length < column) line.push(" ");
      line[column] = cluster;
      const width = visibleWidth(cluster);
      for (let cell = 1; cell < width; cell += 1) line[column + cell] = "";
      column += width;
    }
    index += chunk.length;
  }
  return {
    lines: Array.from(lines, (line) => line?.join("") ?? ""),
    row,
    column,
    cursorVisible,
    scrollback,
    alternateScreen: primary !== undefined,
  };
}

function terminalScreen(writes: readonly string[]): string {
  return terminalState(writes).lines.join("\n");
}

function textBeforeCell(line: string, column: number): string {
  let width = 0;
  let text = "";
  for (const cluster of graphemes(line)) {
    if (width >= column) break;
    text += cluster;
    width += visibleWidth(cluster);
  }
  return text;
}

function cellAt(line: string, column: number): string | undefined {
  let width = 0;
  for (const cluster of graphemes(line)) {
    if (width === column) return cluster;
    width += visibleWidth(cluster);
    if (width > column) return undefined;
  }
  return undefined;
}

function composerFrame(screen: TerminalScreen, columns: number) {
  const header = screen.lines.slice(0, screen.row).findLastIndex((line) => line.startsWith("s › "));
  const top = header >= 0 ? header : screen.row - 1;
  expect(top).toBeGreaterThanOrEqual(0);
  const body: string[] = [];
  for (const line of screen.lines.slice(top + 1)) {
    if (
      visibleWidth(line) !== columns - 1 ||
      !(body.length === 0 ? line.startsWith("╰─ ") : line.startsWith("   "))
    )
      break;
    body.push(line);
  }
  const bottom = top + body.length;
  expect(body.length).toBeGreaterThanOrEqual(1);
  expect(body.length).toBeLessThanOrEqual(6);
  expect(screen.row).toBeGreaterThan(top);
  expect(screen.column).toBeGreaterThan(0);
  expect(screen.column).toBeLessThan(columns - 3);
  expect(screen.cursorVisible).toBe(true);
  return { top, bottom, body };
}

const failedTool: TerminalToolRecord = {
  version: 1,
  type: "tool",
  identity,
  invocationIdentity: {
    agentId: "agent",
    threadId: "thread",
    queryId: "query",
    runId: "original-run",
  },
  callId: "call",
  name: "file.write",
  toolVersion: null,
  step: 1,
  phase: "completed",
  status: "failed",
  effects: "applied",
  error: { code: "FAILED", message: "safe failure" },
};

describe("terminal safe projection", () => {
  it("preserves original output/content positions and excludes all private or textless content", () => {
    const result: AgentRunResult = {
      status: "completed",
      identity,
      output: [
        { role: "user", content: [{ type: "text", text: "not assistant" }] },
        { role: "assistant", content: [{ type: "reasoning", text: "public reasoning" }] },
        {
          role: "assistant",
          content: [
            { type: "tool-call", callId: "x", name: "tool", input: { secret: "private input" } },
            { type: "text", text: "authority\x1b]0;injected\x07" },
            { type: "text", text: "" },
          ],
          replayState: {
            providerId: "p",
            modelId: "m",
            format: "f",
            version: 1,
            data: "private replay",
          },
        },
      ],
    };
    const records = projectTerminalResult(result, unsupported);
    expect(records.find((record) => record.type === "assistant.message")).toMatchObject({
      type: "assistant.message",
      messageIndex: 2,
      content: [{ contentIndex: 1, text: "authority\\x1b]0;injected\\a" }],
    });
    expect(JSON.stringify(records)).not.toMatch(/private|not assistant/);
    const settlement = projectTerminalSettlement(result, unsupported);
    expect(settlement.records).toEqual(records);
    expect(settlement.timeline).toEqual([
      { type: "reasoning", messageIndex: 1, contentIndex: 0, text: "public reasoning" },
      { type: "tool", callId: "x" },
      { type: "text", messageIndex: 2, contentIndex: 1, text: "authority\\x1b]0;injected\\a" },
    ]);
    expect(JSON.stringify(settlement)).not.toMatch(/private|not assistant/);
  });

  it("projects failed/applied and original invocation without payloads", () => {
    const event: RuntimeEvent = {
      kind: "fact",
      type: "tool.completed",
      identity,
      step: 2,
      invocation: {
        identity: failedTool.invocationIdentity,
        call: {
          type: "tool-call",
          callId: "call",
          name: "file.write",
          input: { secret: "PRIVATE" },
        },
        toolVersion: null,
        state: "dispatched",
      },
      completion: {
        status: "failed",
        effects: "applied",
        error: { code: "FAILED", message: "safe" },
        modelContent: [{ type: "text", text: "PRIVATE" }],
        presentation: { type: "private", version: 1, data: "PRIVATE" },
      },
    };
    const record = projectTerminalEvent(event, unsupported);
    expect(record).toMatchObject({
      type: "tool",
      status: "failed",
      effects: "applied",
      invocationIdentity: { runId: "original-run" },
    });
    expect(JSON.stringify(record)).not.toContain("PRIVATE");
    expect(projectTerminalEvent(delta("not a record"), unsupported)).toBeUndefined();
  });

  it("never serializes native errors or SDK error data", () => {
    expect(
      terminalError(
        Object.assign(new Error("API_KEY_PRIVATE"), { code: "SDK", request: "PRIVATE" }),
      ),
    ).toEqual({ code: "TERMINAL_OPERATION_FAILED", message: expect.any(String) });
    expect(JSON.stringify(terminalError(new Error("PRIVATE")))).not.toContain("PRIVATE");
    expect(terminalError(new AgentError("KNOWN", "safe\r\b"))).toEqual({
      code: "KNOWN",
      message: "safe\\r\\b",
    });
    const sdk = { code: "SDK_PRIVATE", message: "Bearer API_KEY_PRIVATE", key: "API_KEY_PRIVATE" };
    expect(terminalError(sdk)).toEqual({
      code: "TERMINAL_OPERATION_FAILED",
      message: expect.any(String),
    });
    expect(JSON.stringify(terminalError(sdk))).not.toMatch(/SDK_PRIVATE|API_KEY_PRIVATE|Bearer/);
    expect(terminalError({ code: "SDK_PRIVATE", message: "API_KEY_PRIVATE" })).toEqual(
      terminalError(new Error("PRIVATE")),
    );
  });

  it("preserves already-public Core protocol errors through event, result and renderer boundaries", async () => {
    const error = { code: "PUBLIC_FAILURE", message: "Safe protocol message\r\x1b" };
    const sanitized = { code: "PUBLIC_FAILURE", message: "Safe protocol message\\r\\x1b" };
    const event = projectTerminalEvent(
      { kind: "fact", type: "run.failed", identity, error },
      unsupported,
    );
    expect(event).toMatchObject({ type: "progress", phase: "run.failed", error: sanitized });
    const result = projectTerminalResult({ status: "failed", identity, error }, unsupported);
    expect(result).toEqual([
      { version: 1, type: "query.result", identity, status: "failed", error: sanitized },
    ]);
    const { renderer, output } = capture("jsonl");
    for (const record of result) await renderer.record(record);
    expect(JSON.parse(output.join(""))).toMatchObject({ error: sanitized });
    await renderer.close();
  });

  it("shows only owner/type/version for unsupported interactions", () => {
    const result: AgentRunResult = {
      status: "waiting",
      identity,
      interaction: {
        id: "approval",
        owner: "plugin",
        payload: { type: "unknown", version: 4, data: { key: "PRIVATE" } },
      },
    };
    expect(projectTerminalResult(result, unsupported)).toEqual([
      {
        version: 1,
        type: "query.result",
        identity,
        status: "waiting",
        interaction: {
          interactionId: "approval",
          owner: "plugin",
          payloadType: "unknown",
          payloadVersion: 4,
        },
        display: { support: "unsupported" },
      },
    ]);
  });
});

describe("bounded provisional text", () => {
  it("separates public reasoning from text while ignoring inputs and stale events", () => {
    const buffer = createPreviewBuffer(identity);
    buffer.update(delta("one"));
    buffer.update(delta("two", "other", 2));
    buffer.update(
      delta("STALE", "request", 0, {
        agentId: "other",
        threadId: "thread",
        queryId: "query",
        runId: "run",
      }),
    );
    buffer.update({
      kind: "stream",
      type: "model.delta",
      identity,
      step: 1,
      requestId: "request",
      contentIndex: 4,
      delta: { type: "reasoning", text: "PUBLIC_REASONING" },
    });
    expect(buffer.previews.map((part) => [part.requestId, part.contentIndex, part.text])).toEqual([
      ["request", 0, "one"],
      ["other", 2, "two"],
      ["request", 4, "PUBLIC_REASONING"],
    ]);
    buffer.update({ kind: "fact", type: "step.committed", identity, step: 1, historyRevision: 1 });
    expect(buffer.previews.find((part) => part.contentIndex === 4)?.reasoning).toBe(true);
    buffer.update({ kind: "fact", type: "run.waiting", identity, interactionId: "approval" });
    expect(buffer.previews).toHaveLength(0);
  });

  it("retains a shared 64KiB UTF8 tail at character boundaries, never caps final output", () => {
    const buffer = createPreviewBuffer(identity);
    buffer.update(delta("中".repeat(20000)));
    buffer.update(delta("👩‍💻".repeat(10000), "second", 1));
    const previews = buffer.previews;
    expect(
      previews.reduce((total, part) => total + Buffer.byteLength(part.text), 0),
    ).toBeLessThanOrEqual(65536);
    expect(previews.every((part) => part.truncated && !part.text.includes("�"))).toBe(true);
    const text = "完整".repeat(40000);
    const records = projectTerminalResult(
      {
        status: "completed",
        identity,
        output: [{ role: "assistant", content: [{ type: "text", text }] }],
      },
      unsupported,
    );
    expect(records[0]).toMatchObject({ content: [{ text }] });
  });
});

describe("interactive conversation presentation", () => {
  it.each([
    [40, false],
    [80, false],
    [120, false],
    [40, true],
    [80, true],
    [120, true],
  ] as const)(
    "separates live and restored message blocks at %s columns (color=%s)",
    async (columns, color) => {
      const conversation: TerminalView = { ...idle, scene: "conversation" };
      const user = `USER_START\n中文👩‍💻é\t${"长".repeat(columns)}\nUSER_END \x1b[41m`;
      const answer = "ANSWER_START\n\n```ts\nconst value = 1;\n```";
      const live = capture("tui", columns, 24, color);
      await live.renderer.bindSession(conversation, []);
      const boundary = live.output.length;
      await live.renderer.user(user);
      const userWrites = live.output.slice(boundary).join("");
      const paintedRows = userWrites.split("\r\n").filter((line) => /\x1b\[48[;:]/u.test(line));
      if (color) {
        expect(paintedRows.some((line) => line.includes("USER_START"))).toBe(true);
        expect(paintedRows.every((line) => line.endsWith("\x1b[0m"))).toBe(true);
      } else {
        expect(paintedRows).toEqual([]);
        expect(userWrites).not.toMatch(/\x1b\[[\d;]*m/u);
      }
      expect(userWrites).not.toContain("\x1b[41m");
      await live.renderer.beginRun(identity);
      await live.renderer.preview([
        {
          identity,
          step: 1,
          requestId: "message",
          contentIndex: 0,
          text: answer,
          truncated: false,
        },
      ]);
      await live.renderer.view(conversation);
      const preview = terminalState(live.output);
      const userEnd = preview.lines.findIndex((line) => line.includes("USER_END"));
      const answerStart = preview.lines.findIndex((line) => line.includes("ANSWER_START"));
      expect(answerStart).toBeGreaterThan(userEnd + 1);
      await live.renderer.settle(
        projectTerminalSettlement(
          {
            status: "completed",
            identity,
            output: [{ role: "assistant", content: [{ type: "text", text: answer }] }],
          },
          unsupported,
        ),
      );
      await live.renderer.close();
      const current = terminalState(live.output);
      expect(current.lines.join("\n")).not.toMatch(/You:|Assistant:/u);
      expect(current.lines.join("\n")).toContain("const value = 1;");
      expect(
        current.lines.slice(0, userEnd + 1).every((line) => visibleWidth(line) < columns),
      ).toBe(true);
      const restored = capture("tui", columns, 24, color);
      await restored.renderer.bindSession(conversation, [
        { role: "user", text: user },
        { role: "assistant", text: answer },
      ]);
      await restored.renderer.close();
      const history = terminalScreen(restored.output);
      expect(history).toContain("USER_START");
      expect(history).toContain("ANSWER_START");
      expect(history).toContain("const value = 1;");
      expect(history.indexOf("USER_START")).toBeLessThan(history.indexOf("ANSWER_START"));
    },
  );

  it("clears old screen and scrollback once and preserves the new conversation through resize", async () => {
    const { renderer, output, size } = capture("tui");
    await renderer.view(idle);
    const entered = terminalState(["OLD_SHELL_OUTPUT\r\n", ...output], ["OLD_SCROLLBACK"]);
    expect(entered.lines.join("\n")).not.toContain("OLD_SHELL_OUTPUT");
    expect(entered.scrollback).toEqual([]);
    await renderer.user("CONVERSATION_TO_KEEP");
    size.columns = 40;
    size.rows = 12;
    await renderer.view(idle);
    expect(terminalScreen(output)).toContain("CONVERSATION_TO_KEEP");
    await renderer.view(idle);
    await renderer.close();
    const retired = terminalScreen(output);
    expect(retired.match(/CONVERSATION_TO_KEEP/g)).toHaveLength(1);
  });

  it.each(["tui", "plain"] as const)(
    "keeps execution records out of the %s conversation without dropping the answer",
    async (mode) => {
      const { renderer, output, error } = capture(mode);
      await renderer.view(idle);
      await renderer.record({
        version: 1,
        type: "session",
        threadId: "PRIVATE_DIAGNOSTIC_THREAD",
      });
      await renderer.user("USER_QUESTION");
      const events: RuntimeEvent[] = [
        { kind: "fact", type: "run.started", identity },
        { kind: "fact", type: "step.committed", identity, step: 0, historyRevision: 1 },
        { kind: "fact", type: "step.started", identity, step: 1 },
        { kind: "fact", type: "run.completed", identity },
      ];
      for (const event of events) {
        const record = projectTerminalEvent(event, unsupported);
        if (record) await renderer.record(record);
      }
      await renderer.record({
        version: 1,
        type: "assistant.message",
        identity,
        messageIndex: 0,
        content: [{ contentIndex: 0, text: "AUTHORITATIVE_ANSWER" }],
      });
      await renderer.record({ version: 1, type: "query.result", identity, status: "completed" });
      await renderer.view(idle);
      await renderer.close();
      const conversation =
        mode === "tui" ? terminalScreen(output) : output.join("") + error.join("");
      expect(conversation).toContain("USER_QUESTION");
      expect(conversation).toContain("AUTHORITATIVE_ANSWER");
      expect(conversation).not.toMatch(
        /run\.started|step\.committed|step\.started|run\.completed|Query completed|PRIVATE_DIAGNOSTIC_THREAD/,
      );
    },
  );

  it.each(["user", "history"] as const)(
    "retires the welcome once on send and does not replay it when binding %s content",
    async (source) => {
      const { renderer, output } = capture("tui");
      await renderer.view(idle);
      const initialPrompt = terminalState(output).lines.find((line) =>
        line.includes("AGENT HARNESS"),
      )!;
      if (source === "user") await renderer.user("EXISTING_MESSAGE");
      else
        await renderer.bindSession({ ...idle, scene: "conversation" }, [
          { role: "assistant", text: "EXISTING_MESSAGE" },
        ]);
      await renderer.view(idle);
      const screen = terminalScreen(output);
      expect(screen).toContain("EXISTING_MESSAGE");
      if (source === "user") expect(screen.split(initialPrompt)).toHaveLength(2);
      else expect(screen).not.toContain(initialPrompt);
      await renderer.close();
    },
  );

  it.each([
    [40, 12, false],
    [80, 24, true],
    [120, 30, false],
  ] as const)(
    "centers the welcome and keeps input anchored through completion in %sx%s",
    async (columns, rows, color) => {
      const { renderer, output } = capture("tui", columns, rows, color);
      await renderer.view(idle);
      const initial = terminalState(output);
      const brand = initial.lines.find((line) => line.includes("AGENT HARNESS"))!;
      const padding = brand.length - brand.trimStart().length;
      const free = columns - 1 - visibleWidth(brand.trim());
      expect(Math.abs(padding * 2 - free)).toBeLessThanOrEqual(1);
      const items = Array.from({ length: 12 }, (_, index) => ({
        id: `cmd-${index}`,
        label: `/cmd-${index}`,
        description: `DESCRIPTION_${index}`,
      }));
      const completing: TerminalView = {
        ...idle,
        completion: { title: "COMMANDS", query: "/", items, selectedId: items[0]!.id },
      };
      await renderer.view(completing);
      const open = terminalState(output);
      const frame = composerFrame(open, columns);
      const first = open.lines.findIndex((line) => line.includes("/cmd-0"));
      expect(first).toBeGreaterThan(frame.bottom);
      if (columns > 42) expect(open.lines[first]).toContain("DESCRIPTION_0");
      expect(cellAt(open.lines[open.row]!, open.column)).toBe(
        cellAt(initial.lines[initial.row]!, initial.column),
      );
      await renderer.view({
        ...completing,
        completion: { ...completing.completion!, selectedId: items[11]!.id },
      });
      const last = terminalState(output);
      if (columns > 42)
        expect(last.lines.find((line) => line.includes("/cmd-11"))).toContain("DESCRIPTION_11");
      else expect(last.lines.some((line) => line.includes("/cmd-11"))).toBe(true);
      expect(last.cursorVisible).toBe(true);
      expect(last.lines.every((line) => visibleWidth(line) < columns)).toBe(true);
      await renderer.view(idle);
      const restored = terminalState(output);
      expect(composerFrame(restored, columns).body).toEqual(composerFrame(initial, columns).body);
      expect(restored.lines.join("\n")).not.toContain("/cmd-");
      if (!color) expect(output.join("")).not.toMatch(/\x1b\[[\d;]*m/);
      await renderer.close();
    },
  );

  it.each([40, 100])(
    "keeps context above the draft and local actions at %s columns",
    async (columns) => {
      const { renderer, output } = capture("tui", columns, 12);
      await renderer.user("EXISTING_CONVERSATION");
      await renderer.view({
        ...idle,
        phase: "running",
        input: { purpose: "composer", status: "执行中", hint: "Esc取消 · 草稿不排队" },
        context: {
          model: "MODEL",
          workspace: "C:/work",
          threadId: "thread",
          capabilities: "read-only",
        },
        composer: {
          draft: { text: "DRAFT", cursor: 3 },
          editable: true,
          submission: { enabled: false, reason: "busy" },
        },
      });
      const screen = terminalState(output);
      const contextRow = screen.lines.findIndex((line) => line.includes("MODEL"));
      const active = screen.lines.slice(contextRow).filter((line) => line.trim());
      expect(contextRow).toBeGreaterThanOrEqual(0);
      expect(contextRow).toBeLessThan(screen.row);
      expect(screen.lines[contextRow]).toContain("work");
      composerFrame(screen, columns);
      expect(cellAt(screen.lines[screen.row]!, screen.column)).toBe("F");
      expect(active.at(-1)).toContain("Esc");
      expect(active.every((line) => visibleWidth(line) < columns)).toBe(true);
      await renderer.close();
    },
  );
});

describe("production renderer modes", () => {
  it("keeps print stdout authoritative and all progress/errors on stderr", async () => {
    const { renderer, output, error } = capture("print");
    await renderer.view(idle);
    await renderer.preview([
      { identity, step: 1, requestId: "req", contentIndex: 0, text: "PREVIEW", truncated: false },
    ]);
    await renderer.user("USER");
    await renderer.record(failedTool);
    for (const record of projectTerminalResult(
      {
        status: "completed",
        identity,
        output: [{ role: "assistant", content: [{ type: "text", text: "actual\n正文" }] }],
      },
      unsupported,
    ))
      await renderer.record(record);
    await renderer.close();
    expect(output.join("")).toBe("actual\n正文\n");
    expect(error.join("")).toContain("safe failure");
    expect(output.join("") + error.join("")).not.toContain("PREVIEW");
  });

  it("encodes records only as strict JSONL and strips extra structural payloads", async () => {
    const { renderer, output } = capture("jsonl");
    await renderer.view(idle);
    await renderer.preview([
      {
        identity,
        step: 1,
        requestId: "req",
        contentIndex: 0,
        text: "PRIVATE_DELTA",
        truncated: false,
      },
    ]);
    await renderer.user("PRIVATE_USER");
    await renderer.bindSession({ ...idle, scene: "conversation" }, [
      { role: "assistant", text: "PRIVATE_HISTORY" },
    ]);
    await renderer.beginRun(identity);
    await renderer.message("diagnostic");
    await renderer.record(
      Object.assign({}, failedTool, {
        rawSdk: "PRIVATE_RAW",
        presentation: { data: "PRIVATE_RAW" },
      }),
    );
    await renderer.close();
    await renderer.record({
      version: 1,
      type: "process.finished",
      exitCode: 1,
      reason: "failure",
      stage: "close",
    });
    const encoded = output.join("");
    const records = encoded
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.type)).toEqual(["tool", "process.finished"]);
    expect(encoded).not.toMatch(/PRIVATE|\x1b/);
    expect(records[0]).toMatchObject({ status: "failed", effects: "applied" });
  });

  for (const columns of [40, 80, 120])
    it(`redraws only mutable viewport at ${columns} columns and corrects preview`, async () => {
      const { renderer, output, size } = capture("tui", columns);
      await renderer.view(idle);
      const started = output.length;
      await renderer.user("immutable history");
      await renderer.preview([
        {
          identity,
          step: 1,
          requestId: "req",
          contentIndex: 0,
          text: "WRONG_PREVIEW",
          truncated: false,
        },
      ]);
      size.columns = columns === 40 ? 80 : 40;
      await renderer.view(idle);
      const final = projectTerminalResult(
        {
          status: "completed",
          identity,
          output: [{ role: "assistant", content: [{ type: "text", text: "CORRECT_AUTHORITY" }] }],
        },
        unsupported,
      );
      for (const record of [...final, ...final]) await renderer.record(record);
      await renderer.close();
      const screen = terminalScreen(output);
      expect(screen).toContain("immutable history");
      expect(screen).toContain("CORRECT_AUTHORITY");
      expect(screen).not.toContain("WRONG_PREVIEW");
      expect(output.join("").match(/CORRECT_AUTHORITY/g)).toHaveLength(1);
      expect(output.join("")).not.toMatch(/\x1b\[\?(?:47|1047|1049)h/);
      expect(output.slice(started).join("")).not.toMatch(/\x1b\[[23]J/);
    });

  it("replaces tool parameters with bounded results and keeps every detail reachable", async () => {
    const { renderer, output } = capture("tui", 80, 24);
    await renderer.view({ ...idle, scene: "conversation" });
    const base = {
      version: 1 as const,
      type: "tool" as const,
      identity,
      invocationIdentity: identity,
      callId: "read-notes",
      name: "read",
      toolVersion: "1",
      step: 1,
    };
    const input = ["path: notes.txt", "offset: 4"];
    await renderer.record({
      ...base,
      phase: "started",
      display: { title: "notes.txt", input, output: [] },
    });
    expect(terminalScreen(output)).toContain("notes.txt");
    expect(terminalScreen(output)).toContain("offset: 4");
    const resultLines = Array.from({ length: 80 }, (_, index) => `line-${index}-content`);
    await renderer.record({
      ...base,
      phase: "completed",
      status: "succeeded",
      effects: "none",
      display: { title: "notes.txt", input, output: resultLines },
    });
    const collapsed = terminalScreen(output);
    expect(collapsed).toContain("line-0-content");
    expect(collapsed).toContain("line-8-content");
    expect(collapsed).not.toContain("line-79-content");
    expect(collapsed).not.toContain("offset: 4");
    expect(renderer.tools()[0]?.description).toContain("notes.txt");
    await renderer.toggleTool();
    expect(terminalScreen(output)).toContain("offset: 4");
    const seen = new Set<string>();
    for (let page = 0; page < 40 && seen.size < resultLines.length; page += 1) {
      const screen = terminalScreen(output);
      for (const line of resultLines) if (screen.includes(line)) seen.add(line);
      await renderer.toggleTool();
    }
    expect([...seen].sort()).toEqual([...resultLines].sort());
    await renderer.dismissDetail();
    await renderer.record({ version: 1, type: "query.result", identity, status: "completed" });
    const archived = terminalScreen(output);
    expect(archived).toContain("notes.txt");
    expect(archived).toContain("line-0-content");
    expect(archived).not.toContain("line-79-content");
    await renderer.close();
  });

  for (const [columns, rows] of [
    [40, 12],
    [80, 24],
    [120, 40],
  ] as const)
    it(`keeps complete tool frames through live overflow, details and resize at ${columns}x${rows}`, async () => {
      const { renderer, output, size } = capture("tui", columns, rows);
      await renderer.view({ ...idle, scene: "conversation" });
      const assertFrames = (): void => {
        const screen = terminalState(output).lines;
        let inside = false;
        let frames = 0;
        for (const line of screen) {
          if (line.startsWith("╭")) {
            expect(inside).toBe(false);
            inside = true;
            expect(line.endsWith("╮")).toBe(true);
          } else if (line.startsWith("╰") && line.endsWith("╯")) {
            expect(inside).toBe(true);
            expect(line.endsWith("╯")).toBe(true);
            inside = false;
            frames += 1;
          } else if (inside) {
            expect(line).toMatch(/^[│├].*[│┤]$/u);
          }
          if (inside || (line.startsWith("╰") && line.endsWith("╯")))
            expect(visibleWidth(line)).toBe(size.columns - 1);
        }
        expect(inside).toBe(false);
        expect(frames).toBeGreaterThan(0);
      };
      for (let index = 0; index < 4; index += 1) {
        await renderer.record({
          version: 1,
          type: "tool",
          identity,
          invocationIdentity: identity,
          callId: `framed-${index}`,
          name: "read",
          toolVersion: "1",
          step: index + 1,
          phase: "completed",
          status: "succeeded",
          effects: "none",
          display: {
            title: `nested/中文-${index}/notes.txt`,
            input: ["offset: 0"],
            summary: ["2000 bytes"],
            output: Array.from(
              { length: 60 },
              (_, line) => `result-${index}-${line} 中文 ${"body ".repeat(20)}`,
            ),
          },
        });
        assertFrames();
      }
      expect(terminalScreen(output)).toContain("中文-3");
      await renderer.toggleTool();
      assertFrames();
      for (let page = 0; page < 4; page += 1) {
        await renderer.toggleTool();
        assertFrames();
      }
      size.columns = columns === 40 ? 80 : 40;
      size.rows = 12;
      await renderer.view({ ...idle, scene: "conversation" });
      assertFrames();
      await renderer.dismissDetail();
      assertFrames();
      await renderer.close();
    });

  it("keeps failed/applied and unknown effects visible through tool selection", async () => {
    const { renderer, output } = capture("tui");
    await renderer.view(idle);
    await renderer.record(failedTool);
    await renderer.toggleTool();
    expect(terminalScreen(output)).toContain("safe failure");
    expect(terminalScreen(output)).toContain("外部影响");
    await renderer.record({
      version: 1,
      type: "tool",
      identity,
      invocationIdentity: identity,
      callId: "other",
      name: "other",
      toolVersion: "1",
      step: 2,
      phase: "completed",
      status: "unknown",
      effects: "unknown",
      error: { code: "UNKNOWN", message: "result uncertain" },
    });
    const items = renderer.tools();
    expect(items).toHaveLength(2);
    await renderer.selectTool(items[1]!.id);
    expect(terminalScreen(output)).toContain("result uncertain");
    expect(terminalScreen(output)).toContain("外部影响未知");
    await renderer.close();
  });

  it("degrades tiny dimensions to safe plain editable state without echoing secrets", async () => {
    const { renderer, output, error, size } = capture("tui", 30);
    await renderer.view(idle);
    expect(output.join("")).toBe("");
    expect(error.join("")).toContain("> 中文👩‍💻é");
    await renderer.view({
      ...idle,
      prompt: { text: "API key", secret: true },
      composer: { ...idle.composer, draft: { text: "MUST_NOT_ECHO", cursor: 13 } },
    });
    expect(output.join("") + error.join("")).not.toContain("MUST_NOT_ECHO");
    size.columns = 80;
    await renderer.view(idle);
    expect(output.join("")).toContain("中文");
    await renderer.close();
  });

  for (const [columns, rows] of [
    [40, 12],
    [80, 24],
    [140, 40],
  ] as const) {
    it(`preserves selector context and selection in ${columns}x${rows}`, async () => {
      const { renderer, output } = capture("tui", columns, rows);
      const items = Array.from({ length: 30 }, (_, index) => ({
        id: String(index),
        label: `choice-${index}`,
        description: "中文👩‍💻".repeat(20),
      }));
      for (const selected of [0, 14, 29]) {
        await renderer.view({
          ...idle,
          input: {
            purpose: "selector",
            status: "CATALOG_ACTIVITY",
            hint: "↑↓ 选择 · Enter 确认 · Escape 返回",
          },
          feedback: { kind: "notice", message: "LOCAL_NOTICE" },
          context: { ...idle.context!, modelStatus: "MODEL_STATE" },
          selector: {
            title: "MODEL_PICKER",
            query: "choice",
            items,
            selectedId: String(selected),
          },
        });
        const screen = terminalState(output);
        const text = screen.lines.join("\n");
        expect(text).toContain("MODEL_PICKER");
        expect(text).toContain("choice");
        expect(text).toContain(`› choice-${selected}`);
        expect(text).toContain(`${selected + 1}/30`);
        expect(text).toContain("MODEL_STATE");
        expect(text).toContain("LOCAL_NOTICE");
        expect(screen.lines.length).toBeLessThan(rows);
        expect(screen.lines.every((line) => visibleWidth(line) < columns)).toBe(true);
        expect(screen.cursorVisible).toBe(false);
      }
      await renderer.close();
    });

    it(`places the cursor before a wrapped wide grapheme in ${columns}x${rows}`, async () => {
      const { renderer, output } = capture("tui", columns, rows);
      const prefix = "a".repeat(composerContentWidth(columns - 1) - 1);
      await renderer.view({
        ...idle,
        composer: {
          ...idle.composer,
          draft: { text: `${prefix}中👩‍💻é`, cursor: prefix.length },
        },
      });
      const screen = terminalState(output);
      expect(screen.lines[screen.row]).toContain("中👩‍💻é");
      composerFrame(screen, columns);
      expect(cellAt(screen.lines[screen.row]!, screen.column)).toBe("中");
      expect(screen.cursorVisible).toBe(true);
      expect(screen.lines.length).toBeLessThan(rows);
      expect(screen.lines.every((line) => visibleWidth(line) < columns)).toBe(true);
      await renderer.close();
    });

    it(`retains the confirmation action and input cursor for long prompts in ${columns}x${rows}`, async () => {
      const { renderer, output } = capture("tui", columns, rows);
      await renderer.view({
        ...idle,
        context: { ...idle.context!, modelStatus: "local configuration ready" },
        prompt: {
          text: `TARGET_MODEL ${"会话绑定说明".repeat(20)}\n风险：RISK_WRITE · Esc返回\n输入/返回：/confirm · /cancel\nTYPE_CONFIRMATION_TOKEN`,
          secret: false,
        },
        composer: { ...idle.composer, draft: { text: "answer", cursor: 6 } },
      });
      const screen = terminalState(output);
      const active = screen.lines.slice(-rows + 1).join("\n");
      expect(active).toContain("TARGET_MODEL");
      expect(active).toContain("TYPE_CONFIRMATION_TOKEN");
      const reachableAboveInput = screen.lines.slice(0, screen.row).join("\n");
      expect(reachableAboveInput).toContain("RISK_WRITE");
      expect(reachableAboveInput).toContain("/confirm");
      expect(reachableAboveInput).toContain("/cancel");
      if (columns === 40) expect(active).toContain("完整提示可回看历史");
      expect(screen.lines[screen.row]).toContain("answer");
      composerFrame(screen, columns);
      expect(
        textBeforeCell(screen.lines[screen.row]!, screen.column).trimEnd().endsWith("answer"),
      ).toBe(true);
      expect(cellAt(screen.lines[screen.row]!, screen.column)).toBe(" ");
      expect(screen.cursorVisible).toBe(true);
      expect(screen.lines.every((line) => visibleWidth(line) < columns)).toBe(true);
      await renderer.close();
    });
  }

  it("keeps secret drafts out of active and plain views across resize", async () => {
    const { renderer, output, error, size } = capture("tui", 40, 12);
    const view: TerminalView = {
      ...idle,
      prompt: { text: "SECRET_PROMPT", secret: true },
      composer: { ...idle.composer, draft: { text: "PRIVATE_DRAFT", cursor: 13 } },
    };
    await renderer.view({
      ...view,
      composer: { ...view.composer, draft: { text: "", cursor: 0 } },
    });
    const empty = terminalState(output);
    composerFrame(empty, 40);
    await renderer.view(view);
    const screen = terminalState(output);
    composerFrame(screen, 40);
    expect(screen.lines.join("\n")).toContain("SECRET_PROMPT");
    expect([screen.row, screen.column]).toEqual([empty.row, empty.column]);
    expect(cellAt(screen.lines[screen.row]!, screen.column)).toBe(" ");
    size.columns = 30;
    await renderer.view(view);
    size.columns = 80;
    size.rows = 24;
    await renderer.view(view);
    const restored = terminalState(output);
    composerFrame(restored, 80);
    expect(cellAt(restored.lines[restored.row]!, restored.column)).toBe(" ");
    expect(output.join("") + error.join("")).not.toContain("PRIVATE_DRAFT");
    await renderer.close();
  });
});

describe("grouped model selector fullscreen panel", () => {
  const action = { id: "configure", label: "+ 添加/配置连接" };
  const groups = [
    { id: "all", label: "All · 全部连接" },
    { id: "vendor:a", label: "连接甲 👩‍💻" },
    { id: "vendor:b", label: "连接乙" },
  ];
  const models = Array.from({ length: 24 }, (_, index) => ({
    id: `model-${index}`,
    label: `模型 ${index}${index === 23 ? " · 当前 · 不可用" : ""}`,
    description: `连接甲 · ${"超长本地状态👩‍💻".repeat(20)}\x1b]52;c;SECRET\x07`,
  }));
  const selector: NonNullable<TerminalView["selector"]> = {
    title: "Models",
    query: "模型",
    items: [...models, action],
    selectedId: "model-23",
    navigation: { groups, selectedGroupId: "vendor:a", pane: "models", action },
  };
  const chat: TerminalView = {
    ...idle,
    input: { ...idle.input, status: "CHAT_STATUS" },
    activity: "CHAT_ACTIVITY",
    feedback: { kind: "notice", message: "CHAT_NOTICE" },
    context: {
      workspace: "CHAT_WORKSPACE",
      threadId: "CHAT_THREAD",
      model: "CHAT_MODEL",
      capabilities: "CHAT_CAPABILITIES",
    },
    composer: { ...idle.composer, draft: { text: "DRAFT_STAYS", cursor: 5 } },
  };

  function panelFrame(screen: TerminalScreen, columns: number, rows: number): void {
    expect(screen.alternateScreen).toBe(true);
    const lines = screen.lines.filter((line, index) => index < rows - 1 || line.trim() !== "");
    expect(lines).toHaveLength(rows - 1);
    expect(lines.every((line) => visibleWidth(line) === columns - 1)).toBe(true);
    expect(lines[0]).toMatch(/^╭.*╮$/u);
    expect(lines.at(-1)).toMatch(/^╰.*╯$/u);
    for (const line of lines.slice(1, -1)) expect(line).toMatch(/^[│├].*[│┤]$/u);
    expect(screen.cursorVisible).toBe(false);
    expect(lines.join("\n")).not.toMatch(/CHAT_|DRAFT_STAYS/u);
    if (columns >= 80) {
      const divider = Array.from({ length: columns - 3 }, (_, index) => index + 1).find(
        (column) => cellAt(lines[1]!, column) === "│",
      );
      expect(divider).toBeDefined();
      const groupRow = lines.find((line) =>
        textBeforeCell(line, divider!).includes(groups[1]!.label),
      );
      expect(groupRow).toBeDefined();
      for (const line of lines.slice(1, rows - 4)) expect(cellAt(line, divider!)).toBe("│");
    }
  }

  for (const [columns, rows] of [
    [40, 12],
    [80, 24],
  ] as const)
    for (const color of [false, true])
      it(`fills an isolated closed frame with visible selection at ${columns}x${rows}, color=${color}`, async () => {
        const { renderer, output } = capture("tui", columns, rows, color);
        await renderer.bindSession(chat, [{ role: "assistant", text: "CHAT_BODY" }]);
        await renderer.view({ ...chat, selector });
        let screen = terminalState(output);
        panelFrame(screen, columns, rows);
        expect(screen.lines.join("\n")).toContain(models[23]!.label);
        expect(screen.lines.join("\n")).toContain(`› ${models[23]!.label}`);
        expect(screen.lines.join("\n")).toContain(action.label);
        expect(output.join("")).not.toContain("\x1b]52");
        expect(/\x1b\[[\d;]*m/.test(output.join(""))).toBe(color);
        const modelsPane = screen.lines;
        await renderer.view({
          ...chat,
          selector: { ...selector, navigation: { ...selector.navigation!, pane: "groups" } },
        });
        screen = terminalState(output);
        panelFrame(screen, columns, rows);
        expect(screen.lines.join("\n")).toContain(groups[1]!.label);
        expect(screen.lines.join("\n")).toContain(`› ${groups[1]!.label}`);
        expect(screen.lines.join("\n")).toContain(action.label);
        expect(screen.lines).not.toEqual(modelsPane);
        await renderer.close();
        expect(terminalState(output).alternateScreen).toBe(false);
        expect(terminalState(output).cursorVisible).toBe(true);
      });

  it("keeps few-model panels full height and updates independent details through resize", async () => {
    const { renderer, output, size } = capture("tui", 80, 24);
    const choices = [
      { id: "ready", label: "模型甲 · 当前", description: "READY_STATUS" },
      { id: "locked", label: "模型乙 · 不可用", description: "LOCKED_STATUS" },
      action,
    ] as const;
    const few = { ...selector, query: "", items: choices, selectedId: "ready" };
    await renderer.view({ ...chat, selector: few });
    let screen = terminalState(output);
    panelFrame(screen, 80, 24);
    expect(screen.lines.join("\n")).toContain(choices[0].description);
    expect(screen.lines.join("\n")).not.toContain(choices[1].description);
    expect(screen.lines.join("\n")).toContain(choices[1].label);
    const listRow = screen.lines.findIndex((line) => line.includes(choices[0].label));
    const detailRow = screen.lines.findIndex((line) => line.includes(choices[0].description));
    expect(detailRow).toBeGreaterThan(listRow);
    expect(screen.lines[detailRow]).not.toContain(choices[0].label);
    for (const [columns, rows, selectedId] of [
      [40, 12, "locked"],
      [80, 24, "ready"],
    ] as const) {
      size.columns = columns;
      size.rows = rows;
      await renderer.view({ ...chat, selector: { ...few, selectedId } });
      screen = terminalState(output);
      panelFrame(screen, columns, rows);
      const selected = selectedId === "ready" ? choices[0] : choices[1];
      const other = selectedId === "ready" ? choices[1] : choices[0];
      expect(screen.lines.join("\n")).toContain(selected.label);
      expect(screen.lines.join("\n")).toContain(selected.description);
      expect(screen.lines.join("\n")).not.toContain(other.description);
      expect(screen.lines.join("\n")).toContain(action.label);
    }
    await renderer.close();
  });

  it("keeps a long connection identity and its count readable when width permits", async () => {
    const { renderer, output } = capture("tui", 120, 24);
    const connection = { id: "vendor:a", label: "MiMo Token Plan 中国", description: "32 个模型" };
    await renderer.view({
      ...chat,
      selector: {
        ...selector,
        navigation: { ...selector.navigation!, groups: [groups[0]!, connection, groups[2]!] },
      },
    });
    const screen = terminalState(output);
    const row = screen.lines.find((line) => line.includes(connection.label));
    expect(row).toContain(connection.description);
    expect(screen.lines.every((line) => visibleWidth(line) === 119)).toBe(true);
    await renderer.close();
  });

  it("keeps empty-search configuration reachable and exits/reenters around plain fallback", async () => {
    const { renderer, output, error, size } = capture("tui", 80, 24);
    const empty = { ...selector, query: "NO_MATCH", items: [action], selectedId: null };
    await renderer.view(chat);
    const primary = terminalState(output);
    await renderer.view({ ...chat, selector: empty });
    panelFrame(terminalState(output), 80, 24);
    expect(terminalScreen(output)).toContain("NO_MATCH");
    expect(terminalScreen(output)).toContain(action.label);
    expect(terminalScreen(output)).not.toContain(models[23]!.label);
    await renderer.view({ ...chat, selector: { ...empty, selectedId: action.id } });
    panelFrame(terminalState(output), 80, 24);
    expect(terminalScreen(output)).toContain(action.label);
    for (const [columns, rows] of [
      [30, 24],
      [80, 11],
    ] as const) {
      size.columns = columns;
      size.rows = rows;
      await renderer.view({
        ...chat,
        selector: { ...empty, navigation: { ...empty.navigation!, pane: "groups" } },
      });
      expect(terminalState(output).alternateScreen).toBe(false);
      expect(terminalState(output).scrollback).toEqual(primary.scrollback);
      const fallback = error.join("");
      expect(fallback).toContain("1. All");
      expect(fallback).toContain("2. 连接甲");
      expect(fallback).toContain("/groups");
      expect(fallback).toContain("/connect");
      expect(fallback).toContain("/cancel");
      expect(fallback).toContain(action.label);
      expect(fallback).not.toContain("\x1b");
      const plainOutput = output.length;
      await renderer.view({
        ...chat,
        selector: { ...empty, navigation: { ...empty.navigation!, pane: "groups" } },
      });
      expect(output.slice(plainOutput).join("")).not.toContain("\x1b");
      size.columns = 80;
      size.rows = 24;
      await renderer.view({ ...chat, selector: empty });
      panelFrame(terminalState(output), 80, 24);
      expect(terminalScreen(output)).not.toContain("1. All");
    }
    await renderer.view(chat);
    expect(terminalState(output)).toEqual(primary);
    await renderer.close();
  });

  it("sanitizes panel fields without letting model or search controls move the display", async () => {
    const { renderer, output } = capture("tui", 80, 24, true);
    await renderer.view({
      ...chat,
      feedback: { kind: "input", message: "SAFE_NOTICE\x1b]52;c;SECRET\x07" },
      selector: {
        ...selector,
        title: "Models\x1b]52;c;SECRET\x07",
        query: "q\x1b[999C",
        items: [
          {
            id: "unsafe",
            label: "SAFE_MODEL\u202e",
            description: "SAFE_DETAIL\x1b[999C",
          },
          action,
        ],
        selectedId: "unsafe",
      },
    });
    const screen = terminalState(output);
    panelFrame(screen, 80, 24);
    expect(screen.lines.join("\n")).toContain("SAFE_MODEL");
    expect(screen.lines.join("\n")).toContain("SAFE_DETAIL");
    expect(screen.lines.join("\n")).toContain("SAFE_NOTICE");
    expect(output.join("")).not.toMatch(/\x1b\]52|\x1b\[999C|\u202e/u);
    await renderer.close();
  });

  it("restores main history, draft, caret and scrollback without archiving the panel", async () => {
    const { renderer, output } = capture("tui", 80, 24);
    const history = Array.from({ length: 40 }, (_, index) => ({
      role: "assistant" as const,
      text: `CHAT_BODY_${index}`,
    }));
    await renderer.bindSession(chat, history);
    const before = terminalState(output, [], 24);
    expect(before.scrollback.length).toBeGreaterThan(0);
    expect(before.lines.join("\n")).toContain("DRAFT_STAYS");
    for (const pane of ["models", "groups", "models"] as const) {
      await renderer.view({
        ...chat,
        selector: { ...selector, navigation: { ...selector.navigation!, pane } },
      });
      const screen = terminalState(output, [], 24);
      panelFrame(screen, 80, 24);
      expect(screen.scrollback).toEqual([]);
    }
    await renderer.view(chat);
    const restored = terminalState(output, [], 24);
    expect(restored).toEqual(before);
    expect(restored.scrollback.join("\n")).not.toContain(action.label);
    await renderer.view({ ...chat, selector });
    await renderer.message("CHAT_DEFERRED_LOG");
    panelFrame(terminalState(output, [], 24), 80, 24);
    await renderer.view(chat);
    const withLog = terminalState(output, [], 24);
    expect([...withLog.scrollback, ...withLog.lines].join("\n")).toContain("CHAT_DEFERRED_LOG");
    expect(withLog.lines.join("\n")).toContain("DRAFT_STAYS");
    expect(withLog.cursorVisible).toBe(true);
    expect(cellAt(withLog.lines[withLog.row]!, withLog.column)).toBe(
      cellAt(before.lines[before.row]!, before.column),
    );
    await renderer.close();
  });

  it("closes an active panel like the main screen, including cursor and history restoration", async () => {
    const normal = capture("tui", 80, 24);
    const panel = capture("tui", 80, 24);
    const history = Array.from({ length: 40 }, (_, index) => ({
      role: "assistant" as const,
      text: `CHAT_BODY_${index}`,
    }));
    await normal.renderer.bindSession(chat, history);
    await panel.renderer.bindSession(chat, history);
    await panel.renderer.view({ ...chat, selector });
    panelFrame(terminalState(panel.output, [], 24), 80, 24);
    await normal.renderer.close();
    await panel.renderer.close();
    const closed = terminalState(panel.output, [], 24);
    expect(closed).toEqual(terminalState(normal.output, [], 24));
    expect(closed.alternateScreen).toBe(false);
    expect(closed.cursorVisible).toBe(true);
    expect([...closed.scrollback, ...closed.lines].join("\n")).toContain("CHAT_BODY_39");
    expect([...closed.scrollback, ...closed.lines].join("\n")).not.toContain(action.label);
  });
});

describe("terminal Unicode and content safety", () => {
  it("wraps visible columns without splitting graphemes", () => {
    const text = "中👩‍💻é".repeat(30);
    for (const columns of [40, 80, 120]) {
      const lines = wrapTerminalText(text, columns);
      expect(lines.join("")).toBe(text);
      expect(lines.every((line) => visibleWidth(line) <= columns)).toBe(true);
      expect(lines.flatMap(graphemes)).toEqual(graphemes(text));
    }
  });

  it("escapes cursor/OSC/bidi controls and preserves fenced code content", () => {
    expect(sanitizeTerminalText("x\x1b]52;c;key\x07\b\r\u202e\ny")).toBe(
      "x\\x1b]52;c;key\\a\\b\\r\\u202e\ny",
    );
    const code = `  const 文 = '👩‍💻';\t// ${"a".repeat(100)}`;
    const markdown = `# Heading\n\n- list with \`inline\`\n\`\`\`ts\n${code}\n\`\`\``;
    expect(markdownLines(markdown, 40)).toContain(code);
  });
});

describe("stable mutable terminal viewport", () => {
  for (const columns of [40, 80, 120])
    it(`leaves the empty input caret row free of hint text at ${columns} columns`, async () => {
      const { renderer, output } = capture("tui", columns, 24);
      const empty = {
        ...idle,
        scene: "conversation" as const,
        composer: {
          ...idle.composer,
          draft: { text: "", cursor: 0 },
        },
      };
      const assertEmptyTail = (): void => {
        const screen = terminalState(output);
        const line = screen.lines[screen.row]!;
        for (let column = screen.column; column < columns - 2; column += 1)
          expect(cellAt(line, column)).toBe(" ");
        expect(screen.cursorVisible).toBe(true);
      };
      await renderer.view(empty);
      assertEmptyTail();
      await renderer.view({
        ...empty,
        composer: {
          ...empty.composer,
          draft: { text: "h", cursor: 1 },
        },
      });
      const typed = terminalState(output);
      expect(textBeforeCell(typed.lines[typed.row]!, typed.column).trimEnd().endsWith("h")).toBe(
        true,
      );
      await renderer.view(empty);
      assertEmptyTail();
      await renderer.close();
    });

  it("keeps the input and draft anchored when startup activity gives way to model context", async () => {
    const { renderer, output } = capture("tui");
    const draft = { text: "BOOT_DRAFT", cursor: 4 };
    await renderer.view({
      ...idle,
      phase: "starting",
      scene: "startup",
      context: undefined,
      activity: "INITIALIZING",
      composer: { ...idle.composer, draft, submission: { enabled: false, reason: "not-ready" } },
    });
    const starting = terminalState(output);
    const before = composerFrame(starting, 80);
    await renderer.view({ ...idle, scene: "home", composer: { ...idle.composer, draft } });
    const ready = terminalState(output);
    const after = composerFrame(ready, 80);
    expect(after.top).toBe(before.top);
    expect([ready.row, ready.column]).toEqual([starting.row, starting.column]);
    expect(ready.lines[ready.row]).toContain(draft.text);
    expect(cellAt(ready.lines[ready.row]!, ready.column)).toBe("_");
    await renderer.close();
  });

  it("writes nothing for identical frames and moves only the caret when text is unchanged", async () => {
    const { renderer, output } = capture("tui");
    await renderer.view(idle);
    const initial = terminalState(output);
    const count = output.length;
    await renderer.view({ ...idle });
    expect(output).toHaveLength(count);
    expect(terminalState(output)).toEqual(initial);
    await renderer.view({
      ...idle,
      composer: { ...idle.composer, draft: { ...idle.composer.draft, cursor: 1 } },
    });
    const moved = terminalState(output);
    expect(moved.lines).toEqual(initial.lines);
    expect(moved.row).toBe(initial.row);
    composerFrame(moved, 80);
    expect(cellAt(moved.lines[moved.row]!, moved.column)).toBe("文");
    expect(moved.cursorVisible).toBe(true);
    expect(output.slice(count).join("")).not.toContain("\x1b[2K");
    await renderer.close();
  });

  it("takes one dimensions snapshot per frame", async () => {
    let columnReads = 0;
    let rowReads = 0;
    const writes: string[] = [];
    const renderer = createTerminalRenderer({
      mode: "tui",
      color: false,
      columns: () => {
        columnReads += 1;
        return 80;
      },
      rows: () => {
        rowReads += 1;
        return 24;
      },
      writeOutput: async (text) => {
        writes.push(text);
      },
      writeError: async () => {},
      onOutputError: () => {},
    });
    await renderer.view(idle);
    expect(columnReads).toBe(1);
    expect(rowReads).toBe(1);
    expect(terminalState(writes).cursorVisible).toBe(true);
    await renderer.close();
  });

  it("keeps the caret's row in a closed six-row viewport without changing drafts on resize", async () => {
    const { renderer, output, size } = capture("tui", 80, 24);
    const source = Array.from({ length: 12 }, (_, index) => `DRAFT_ROW_${index}_中文`);
    const text = source.join("\n");
    for (const [columns, rows] of [
      [80, 24],
      [40, 12],
      [120, 30],
    ]) {
      size.columns = columns!;
      size.rows = rows!;
      for (const index of [0, 6, 11]) {
        const cursor = graphemes(source.slice(0, index + 1).join("\n")).length;
        const draft = { text, cursor };
        await renderer.view({ ...idle, composer: { ...idle.composer, draft } });
        const screen = terminalState(output);
        const frame = composerFrame(screen, columns!);
        expect(screen.lines[screen.row]).toContain(source[index]);
        expect(
          textBeforeCell(screen.lines[screen.row]!, screen.column)
            .trimEnd()
            .endsWith(source[index]!),
        ).toBe(true);
        expect(cellAt(screen.lines[screen.row]!, screen.column)).toBe(" ");
        expect(frame.body.length).toBeLessThan(source.length);
        if (rows! >= 24) expect(frame.body).toHaveLength(6);
        expect(screen.lines[frame.bottom + 1]).toMatch(/[↑↓]/u);
        expect(screen.lines.findLastIndex((line) => line.trim().length > 0)).toBeLessThan(
          rows! - 1,
        );
        expect(screen.lines.every((line) => visibleWidth(line) < columns!)).toBe(true);
        expect(draft).toEqual({ text, cursor });
      }
    }
    await renderer.close();
  });

  it("keeps completion below the editable draft, including a wrapped tab caret", async () => {
    const { renderer, output } = capture("tui", 42, 12);
    const draft = { text: `${"a".repeat(38)}\tZ`, cursor: 39 };
    const view: TerminalView = {
      ...idle,
      input: {
        purpose: "completion",
        status: "选择命令",
        hint: "Enter 接受补全 · Escape 返回草稿",
      },
      composer: { ...idle.composer, draft },
      completion: {
        title: "COMMAND_CHOICES",
        query: "/m",
        items: [{ id: "/model", label: "/model", description: "SWITCH_MODELS" }],
        selectedId: "/model",
      },
    };
    await renderer.view(view);
    const screen = terminalState(output);
    const text = screen.lines.join("\n");
    expect(text).toContain("/model");
    const frame = composerFrame(screen, 42);
    expect(frame.body.join("")).toContain("a".repeat(composerContentWidth(41)));
    expect(cellAt(screen.lines[screen.row]!, screen.column)).toBe("Z");
    expect(screen.cursorVisible).toBe(true);
    const candidate = screen.lines.findIndex((line) => line.includes("/model"));
    expect(candidate).toBeGreaterThan(frame.bottom);
    expect(screen.lines[candidate]).toContain("SWITCH_MODELS");
    expect(screen.lines.every((line) => visibleWidth(line) < 42)).toBe(true);
    await renderer.view({
      ...view,
      feedback: { kind: "input", message: "INPUT_NOTICE" },
      context: { ...idle.context!, modelStatus: "MODEL_STATE" },
    });
    const crowded = terminalState(output);
    expect(crowded.lines.join("\n")).toContain("/model");
    const crowdedFrame = composerFrame(crowded, 42);
    expect(crowded.lines.findIndex((line) => line.includes("/model"))).toBeGreaterThan(
      crowdedFrame.bottom,
    );
    expect(cellAt(crowded.lines[crowded.row]!, crowded.column)).toBe("Z");
    expect(crowded.cursorVisible).toBe(true);
    await renderer.close();
  });

  it("preserves safe approval context and the selected response at narrow height", async () => {
    const { renderer, output } = capture("tui", 40, 12);
    const interaction: NonNullable<TerminalView["interaction"]> = {
      reference: {
        interactionId: "approval-full-id-0123456789",
        owner: "files",
        payloadType: "write",
        payloadVersion: 1,
      },
      display: {
        support: "supported",
        summary: `SAFE_SUMMARY ${"摘要正文".repeat(80)} SUMMARY_END`,
        confirmation: "interaction-id",
        choices: [
          { id: "yes", label: "ALLOW_WRITE", responseType: "answer" },
          { id: "no", label: "DENY_WRITE", responseType: "reject" },
        ],
      },
    };
    await renderer.view({
      ...idle,
      phase: "waiting",
      input: {
        purpose: "interaction",
        status: "尚未批准",
        hint: "↑↓ 选择 · Enter 确认 · Escape 返回",
      },
      interaction,
      selector: {
        title: "APPROVAL",
        query: "",
        items: interaction.display.support === "supported" ? interaction.display.choices : [],
        selectedId: "no",
      },
    });
    const screen = terminalState(output);
    const active = screen.lines.slice(-11).join("\n");
    expect(active).toContain("SAFE_SUMMARY");
    expect(active).toContain("DENY_WRITE");
    expect(active).toContain("完整交互 ID");
    expect(active).toContain("历史");
    expect(screen.lines.join("\n")).toContain("SUMMARY_END");
    expect(screen.lines.join("\n")).toContain(interaction.reference.interactionId);
    expect(screen.cursorVisible).toBe(false);
    const before = output.length;
    await renderer.view({
      ...idle,
      phase: "waiting",
      interaction: Object.assign({}, interaction, {
        display: {
          support: "unsupported" as const,
          summary: "PRIVATE_SUMMARY",
          data: "PRIVATE_DATA",
        },
      }),
    });
    expect(output.slice(before).join("")).not.toMatch(/PRIVATE_SUMMARY|PRIVATE_DATA/);
    expect(terminalScreen(output)).toContain("files/write@1");
    await renderer.close();
  });

  it("keeps approval risk and the confirmation token reachable above a narrow text frame", async () => {
    const { renderer, output } = capture("tui", 40, 12);
    const token = "approval-id-123";
    await renderer.view({
      ...idle,
      phase: "waiting",
      input: {
        purpose: "interaction",
        status: "等待明确审批",
        hint: "Esc等待 · Enter回答 · ^C取消",
      },
      interaction: {
        reference: {
          interactionId: token,
          owner: "files",
          payloadType: "write",
          payloadVersion: 1,
        },
        display: {
          support: "supported",
          summary: "RISK_EXTERNAL_WRITE",
          confirmation: "interaction-id",
          choices: [{ id: "allow", label: "ALLOW_WRITE", responseType: "answer" }],
        },
      },
      prompt: { text: `请输入完整交互 ID：${token}`, secret: false },
      composer: { ...idle.composer, draft: { text: token, cursor: 5 } },
    });
    const screen = terminalState(output);
    const frame = composerFrame(screen, 40);
    const active = screen.lines.slice(-11).join("\n");
    expect(active).toContain("RISK_EXTERNAL_WRITE");
    expect(active).toContain(token);
    expect(screen.lines.slice(0, frame.top).join("\n")).toContain("RISK_EXTERNAL_WRITE");
    expect(screen.lines.slice(0, frame.top).join("\n")).toContain("完整交互 ID");
    expect(cellAt(screen.lines[screen.row]!, screen.column)).toBe(token[5]);
    expect(screen.lines.every((line) => visibleWidth(line) < 40)).toBe(true);
    await renderer.close();
  });

  it("clears removed tail rows and resized activity without rewriting native history", async () => {
    const { renderer, output, size } = capture("tui", 80, 24);
    await renderer.view(idle);
    await renderer.user("IMMUTABLE_HISTORY");
    const initial = terminalState(output);
    const historyEnd = initial.lines.findIndex((line) => line.includes("IMMUTABLE_HISTORY")) + 1;
    const history = initial.lines.slice(0, historyEnd);
    const expanded: TerminalView = {
      ...idle,
      composer: {
        ...idle.composer,
        draft: { text: "DRAFT_TOP\nDRAFT_MIDDLE\nDRAFT_TAIL", cursor: 32 },
      },
    };
    await renderer.view(expanded);
    expect(terminalScreen(output)).toContain("DRAFT_TAIL");
    const boundary = output.length;
    await renderer.view({
      ...idle,
      composer: { ...idle.composer, draft: { text: "short", cursor: 5 } },
    });
    let screen = terminalState(output);
    expect(screen.lines.slice(0, history.length)).toEqual(history);
    expect(screen.lines.join("\n")).not.toMatch(/DRAFT_TOP|DRAFT_MIDDLE|DRAFT_TAIL/);
    expect(output.slice(boundary).join("")).not.toContain("IMMUTABLE_HISTORY");
    size.columns = 40;
    size.rows = 12;
    await renderer.view(idle);
    screen = terminalState(output);
    expect(screen.lines.slice(0, history.length)).toEqual(history);
    expect(screen.lines.join("\n")).not.toContain("short");
    expect(screen.lines.slice(history.length).every((line) => visibleWidth(line) < 40)).toBe(true);
    expect(screen.cursorVisible).toBe(true);
    await renderer.close();
    expect(terminalScreen(output)).toContain("IMMUTABLE_HISTORY");
  });

  it("coalesces previews and never resurrects provisional text after final output or close", async () => {
    vi.useFakeTimers();
    try {
      const { renderer, output } = capture("tui");
      await renderer.view(idle);
      await renderer.preview([
        {
          identity,
          step: 1,
          requestId: "request",
          contentIndex: 0,
          text: "TEMP_0",
          truncated: false,
        },
      ]);
      await renderer.record({
        version: 1,
        type: "progress",
        identity,
        phase: "step.committed",
        step: 1,
        historyRevision: 1,
      });
      expect(terminalScreen(output)).toContain("TEMP_0");
      const start = output.length;
      for (let index = 1; index < 30; index += 1)
        await renderer.preview([
          {
            identity,
            step: 1,
            requestId: "request",
            contentIndex: 0,
            text: `TEMP_${index}`,
            truncated: false,
          },
        ]);
      expect(output).toHaveLength(start);
      await vi.advanceTimersByTimeAsync(16);
      expect(output).toHaveLength(start + 1);
      expect(terminalScreen(output)).toContain("TEMP_29");
      const finalBoundary = output.length;
      await renderer.preview([
        {
          identity,
          step: 1,
          requestId: "request",
          contentIndex: 0,
          text: "LATE_TEMP",
          truncated: false,
        },
      ]);
      for (const record of projectTerminalResult(
        {
          status: "completed",
          identity,
          output: [{ role: "assistant", content: [{ type: "text", text: "FINAL_RESPONSE" }] }],
        },
        unsupported,
      ))
        await renderer.record(record);
      await renderer.preview([
        {
          identity,
          step: 1,
          requestId: "request",
          contentIndex: 0,
          text: "STALE_TEMP",
          truncated: false,
        },
      ]);
      await vi.advanceTimersByTimeAsync(32);
      expect(output.slice(finalBoundary).join("")).not.toMatch(/LATE_TEMP|STALE_TEMP|TEMP_29/);
      expect(output.join("").match(/FINAL_RESPONSE/g)).toHaveLength(1);
      expect(terminalScreen(output)).not.toContain("TEMP_");
      await renderer.preview([
        {
          identity: { ...identity, runId: "next" },
          step: 1,
          requestId: "next",
          contentIndex: 0,
          text: "AFTER_CLOSE",
          truncated: false,
        },
      ]);
      await renderer.close();
      const closedCount = output.length;
      await vi.advanceTimersByTimeAsync(32);
      expect(output).toHaveLength(closedCount);
      expect(terminalScreen(output)).toContain("FINAL_RESPONSE");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains only the latest preview while an output write is blocked", async () => {
    vi.useFakeTimers();
    try {
      const gate = Promise.withResolvers<void>();
      let blocked = false;
      const output: string[] = [];
      const failures: unknown[] = [];
      const renderer = createTerminalRenderer({
        mode: "tui",
        color: false,
        columns: () => 80,
        rows: () => 24,
        writeOutput: async (text) => {
          output.push(text);
          if (blocked) await gate.promise;
        },
        writeError: async () => {},
        onOutputError: (error) => {
          failures.push(error);
        },
      });
      await renderer.view(idle);
      await renderer.beginRun(identity);
      blocked = true;
      const preview = (index: number) => [
        {
          identity,
          step: 1,
          requestId: "request",
          contentIndex: 0,
          text: `PENDING_${index}`,
          truncated: false,
        },
      ];
      await renderer.preview(preview(0));
      await vi.advanceTimersByTimeAsync(16);
      const count = output.length;
      for (let index = 1; index <= 20; index += 1) {
        await renderer.preview(preview(index));
        await vi.advanceTimersByTimeAsync(16);
      }
      expect(output).toHaveLength(count);
      blocked = false;
      gate.resolve();
      await vi.advanceTimersByTimeAsync(32);
      expect(output.join("").match(/PENDING_\d+/g)).toEqual(["PENDING_0", "PENDING_20"]);
      expect(terminalScreen(output)).toContain("PENDING_20");
      expect(failures).toEqual([]);
      await renderer.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports timed preview write failures through the output failure boundary", async () => {
    vi.useFakeTimers();
    try {
      const failure = new Error("write failed");
      const failures: unknown[] = [];
      let failWrites = false;
      const renderer = createTerminalRenderer({
        mode: "tui",
        color: false,
        columns: () => 80,
        rows: () => 24,
        writeOutput: async () => {
          if (failWrites) throw failure;
        },
        writeError: async () => {},
        onOutputError: (error) => {
          failures.push(error);
        },
      });
      await renderer.view(idle);
      await renderer.beginRun(identity);
      failWrites = true;
      await renderer.preview([
        {
          identity,
          step: 1,
          requestId: "request",
          contentIndex: 0,
          text: "preview",
          truncated: false,
        },
      ]);
      await vi.advanceTimersByTimeAsync(16);
      expect(failures).toEqual([failure]);
      failWrites = false;
      await renderer.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dismisses tool details one layer at a time and retains failure and waiting context", async () => {
    const { renderer, output } = capture("tui");
    await renderer.view(idle);
    expect(await renderer.dismissDetail()).toBe(false);
    await renderer.record(failedTool);
    await renderer.toggleTool();
    expect(await renderer.dismissDetail()).toBe(true);
    expect(await renderer.dismissDetail()).toBe(false);
    for (const status of ["completed", "cancelled", "interrupted"] as const)
      await renderer.record({ version: 1, type: "query.result", identity, status });
    await renderer.record({
      version: 1,
      type: "query.result",
      identity,
      status: "failed",
      error: { code: "QUERY_FAILURE", message: "authoritative failure" },
    });
    await renderer.record({
      version: 1,
      type: "query.result",
      identity,
      status: "waiting",
      interaction: {
        interactionId: "WAITING_ID",
        owner: "owner",
        payloadType: "approval",
        payloadVersion: 1,
      },
      display: { support: "unsupported" },
    });
    await renderer.view(idle);
    await renderer.close();
    const history = terminalScreen(output);
    for (const result of ["safe failure", "QUERY_FAILURE", "authoritative failure", "WAITING_ID"])
      expect(history).toContain(result);
  });
});

describe("session and ordered turn handoff", () => {
  it.each([40, 80, 120])(
    "keeps startup and home continuous and retires one welcome at %s columns",
    async (columns) => {
      const { renderer, output } = capture("tui", columns);
      await renderer.view({
        ...idle,
        scene: "startup",
        phase: "starting",
        activity: "INITIALIZING",
        composer: { ...idle.composer, submission: { enabled: false, reason: "not-ready" } },
      });
      const startup = terminalState(output);
      const brand = startup.lines.find((line) => line.includes("AGENT HARNESS"))!;
      expect(brand).toBeTruthy();
      await renderer.bindSession(idle, []);
      expect(terminalScreen(output)).toContain(brand);
      await renderer.user("FIRST_SUBMISSION");
      await renderer.user("SECOND_SUBMISSION");
      await renderer.view({ ...idle, scene: "conversation" });
      const sent = terminalScreen(output);
      expect(sent.split(brand)).toHaveLength(2);
      expect(sent.indexOf(brand)).toBeLessThan(sent.indexOf("FIRST_SUBMISSION"));
      expect(sent.indexOf("FIRST_SUBMISSION")).toBeLessThan(sent.indexOf("SECOND_SUBMISSION"));
      await renderer.close();
      expect(terminalScreen(output)).toContain(brand);
      expect(output.join("").match(/\x1b\[3J/g)).toHaveLength(1);
    },
  );

  it("binds context and history together, preserves scrollback and rejects old session events", async () => {
    const { renderer, output } = capture("tui");
    await renderer.view(idle);
    await renderer.user("OLD_TRANSCRIPT");
    await renderer.record(failedTool);
    const nextIdentity = {
      ...identity,
      threadId: "other-thread",
      queryId: "other-query",
      runId: "other-run",
    };
    const nextView: TerminalView = {
      ...idle,
      scene: "conversation",
      context: { ...idle.context!, threadId: nextIdentity.threadId, model: "TARGET_MODEL" },
    };
    const boundary = output.length;
    await renderer.bindSession(nextView, [{ role: "assistant", text: "TARGET_HISTORY" }]);
    const handoff = output.slice(boundary);
    expect(terminalScreen(output)).toContain("TARGET_MODEL");
    expect(terminalScreen(output)).toContain("TARGET_HISTORY");
    expect(handoff.join("")).not.toMatch(/\x1b\[[23]J/);
    expect(renderer.tools()).toEqual([]);
    expect(await renderer.dismissDetail()).toBe(false);
    const afterBinding = output.length;
    await renderer.record(failedTool);
    await renderer.preview([
      {
        identity,
        step: 1,
        requestId: "stale",
        previewId: "opaque",
        text: "STALE_SESSION",
        truncated: false,
      },
    ]);
    await renderer.settle(
      projectTerminalSettlement(
        {
          status: "completed",
          identity,
          output: [{ role: "assistant", content: [{ type: "text", text: "STALE_CANONICAL" }] }],
        },
        unsupported,
      ),
    );
    expect(output).toHaveLength(afterBinding);
    await renderer.beginRun(nextIdentity);
    await renderer.preview([
      {
        identity: nextIdentity,
        step: 1,
        requestId: "fresh",
        previewId: "not-a-position",
        text: "FRESH_PREVIEW",
        truncated: false,
      },
    ]);
    await renderer.view(nextView);
    const screen = terminalScreen(output);
    expect(screen).toContain("OLD_TRANSCRIPT");
    expect(screen).toContain("TARGET_HISTORY");
    expect(screen).toContain("FRESH_PREVIEW");
    expect(screen).not.toMatch(/STALE_SESSION|STALE_CANONICAL/);
    await renderer.close();
  });

  it.each([40, 80, 120])(
    "updates a single tool and atomically settles text/tool/text at %s columns",
    async (columns) => {
      const { renderer, output } = capture("tui", columns);
      const conversation = { ...idle, scene: "conversation" as const };
      await renderer.bindSession(conversation, []);
      await renderer.beginRun(identity);
      const first = {
        identity,
        step: 1,
        requestId: "one",
        previewId: "opaque:not:canonical",
        text: "PROVISIONAL_BEFORE",
        truncated: false,
      };
      await renderer.preview([first]);
      await renderer.view(conversation);
      expect(terminalScreen(output)).toContain("PROVISIONAL_BEFORE");
      const tool: TerminalToolRecord = {
        version: 1,
        type: "tool",
        identity,
        invocationIdentity: identity,
        callId: "ordered-call",
        name: "ordered-tool",
        toolVersion: "1",
        step: 1,
        phase: "started",
      };
      await renderer.record(tool);
      await renderer.record({
        ...tool,
        phase: "completed",
        status: "succeeded",
        effects: "applied",
      });
      const active = terminalScreen(output);
      expect(active.match(/ordered-tool/g)).toHaveLength(1);
      expect(active.indexOf("PROVISIONAL_BEFORE")).toBeLessThan(active.indexOf("ordered-tool"));
      const final = projectTerminalSettlement(
        {
          status: "completed",
          identity,
          output: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "CANONICAL_BEFORE" },
                {
                  type: "tool-call",
                  callId: "ordered-call",
                  name: "ordered-tool",
                  input: { secret: "PRIVATE_INPUT" },
                },
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  callId: "ordered-call",
                  content: [{ type: "text", text: "PRIVATE_TOOL_RESULT" }],
                },
              ],
            },
            { role: "assistant", content: [{ type: "text", text: "CANONICAL_AFTER" }] },
          ],
        },
        unsupported,
      );
      expect(final.timeline.filter((part) => part.type === "tool")).toHaveLength(1);
      const boundary = output.length;
      await renderer.settle(final);
      expect(output.slice(boundary)).toHaveLength(1);
      expect(output[boundary]).toContain("CANONICAL_BEFORE");
      expect(output[boundary]).toContain("CANONICAL_AFTER");
      const settled = terminalScreen(output);
      expect(settled.indexOf("CANONICAL_BEFORE")).toBeLessThan(settled.indexOf("ordered-tool"));
      expect(settled.indexOf("ordered-tool")).toBeLessThan(settled.indexOf("CANONICAL_AFTER"));
      expect(settled.match(/ordered-tool/g)).toHaveLength(1);
      expect(settled).not.toMatch(/PROVISIONAL_BEFORE|PRIVATE_INPUT|PRIVATE_TOOL_RESULT/);
      await renderer.settle(final);
      expect(terminalScreen(output).match(/CANONICAL_BEFORE/g)).toHaveLength(1);
      expect(terminalScreen(output).match(/ordered-tool/g)).toHaveLength(1);
      await renderer.close();
    },
  );

  it("retains waiting tool effects across a new Run but rejects that old Run's late output", async () => {
    const { renderer, output } = capture("tui");
    const conversation = { ...idle, scene: "conversation" as const };
    await renderer.bindSession(conversation, []);
    await renderer.beginRun(identity);
    await renderer.record(failedTool);
    await renderer.settle(
      projectTerminalSettlement(
        {
          status: "waiting",
          identity,
          interaction: {
            id: "approval",
            owner: "files",
            payload: { type: "write", version: 1, data: {} },
          },
        },
        unsupported,
      ),
    );
    const resumed = { ...identity, runId: "resumed-run" };
    await renderer.beginRun(resumed);
    expect(terminalScreen(output)).toContain("safe failure");
    const boundary = output.length;
    await renderer.record({ ...failedTool, error: { code: "LATE", message: "STALE_TOOL_UPDATE" } });
    await renderer.preview([
      {
        identity,
        step: 1,
        requestId: "late",
        contentIndex: 0,
        text: "STALE_PREVIEW",
        truncated: false,
      },
    ]);
    expect(output).toHaveLength(boundary);
    const outputMessages = [
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "SAME_TEXT" },
          { type: "tool-call" as const, callId: "call", name: "file.write", input: {} },
          { type: "text" as const, text: "SAME_TEXT" },
        ],
      },
    ];
    await renderer.settle(
      projectTerminalSettlement(
        { status: "completed", identity: resumed, output: outputMessages },
        unsupported,
      ),
    );
    await renderer.beginRun({ ...identity, runId: "replayed-run" });
    await renderer.settle(
      projectTerminalSettlement(
        {
          status: "completed",
          identity: { ...identity, runId: "replayed-run" },
          output: outputMessages,
        },
        unsupported,
      ),
    );
    await renderer.close();
    const screen = terminalScreen(output);
    expect(screen.match(/SAME_TEXT/g)).toHaveLength(2);
    expect(screen.match(/file\.write/g)).toHaveLength(1);
    expect(screen).toContain("外部影响");
    expect(screen).not.toMatch(/STALE_TOOL_UPDATE|STALE_PREVIEW/);
  });

  it.each(["completed", "waiting", "failed", "cancelled"] as const)(
    "retains applied and unknown effects on %s without committing unfinished prose",
    async (status) => {
      const { renderer, output } = capture("tui", 40, 12);
      await renderer.bindSession({ ...idle, scene: "conversation" }, []);
      await renderer.beginRun(identity);
      await renderer.preview([
        {
          identity,
          step: 1,
          requestId: "unfinished",
          contentIndex: 0,
          text: "UNFINISHED_PROSE",
          truncated: false,
        },
      ]);
      await renderer.record(failedTool);
      await renderer.record({
        ...failedTool,
        invocationIdentity: identity,
        callId: "unknown-call",
        name: "unknown-tool",
        phase: "completed",
        status: "unknown",
        effects: "unknown",
        error: { code: "UNKNOWN_EFFECT", message: "result uncertain" },
      });
      const result: AgentRunResult =
        status === "waiting"
          ? {
              status,
              identity,
              interaction: {
                id: "waiting",
                owner: "files",
                payload: { type: "write", version: 1, data: {} },
              },
            }
          : status === "failed"
            ? { status, identity, error: { code: "MODEL_FAILED", message: "safe model failure" } }
            : status === "completed"
              ? {
                  status,
                  identity,
                  output: [
                    {
                      role: "assistant",
                      content: [{ type: "text", text: "FINAL_WITH_UNMATCHED_TOOLS" }],
                    },
                  ],
                }
              : { status, identity };
      await renderer.settle(projectTerminalSettlement(result, unsupported));
      await renderer.close();
      const screen = terminalScreen(output);
      if (status === "completed") expect(screen).toContain("FINAL_WITH_UNMATCHED_TOOLS");
      expect(screen).toContain("safe failure");
      expect(screen).toContain("result uncertain");
      expect(screen).toContain("外部影响未知");
      expect(screen).not.toContain("UNFINISHED_PROSE");
    },
  );
  it("keeps fitting approval and confirmation prompts live without duplicate history copies", async () => {
    const { renderer, output } = capture("tui", 120, 30);
    const conversation: TerminalView = { ...idle, scene: "conversation" };
    await renderer.bindSession(conversation, []);
    await renderer.beginRun(identity);
    const display = {
      support: "supported" as const,
      summary: "DECISION_QUESTION",
      confirmation: "explicit-choice" as const,
      choices: [{ id: "allow", label: "ALLOW_ONCE", responseType: "answer" as const }],
    };
    const waiting: AgentRunResult = {
      status: "waiting",
      identity,
      interaction: {
        id: "approval-id",
        owner: "host",
        payload: { type: "read", version: 1, data: null },
      },
    };
    await renderer.settle(projectTerminalSettlement(waiting, () => display));
    await renderer.view({
      ...conversation,
      phase: "waiting",
      interaction: {
        reference: {
          interactionId: "approval-id",
          owner: "host",
          payloadType: "read",
          payloadVersion: 1,
        },
        display,
      },
      selector: {
        title: "APPROVAL",
        query: "",
        items: [{ id: "allow", label: "ALLOW_ONCE" }],
        selectedId: null,
      },
    });
    expect(terminalScreen(output).split("DECISION_QUESTION")).toHaveLength(2);
    await renderer.beginRun({ ...identity, runId: "resumed-run" });
    await renderer.view({
      ...conversation,
      prompt: { text: "CONFIRM_SESSION_CHANGE", secret: false },
    });
    expect(terminalScreen(output).split("CONFIRM_SESSION_CHANGE")).toHaveLength(2);
    await renderer.close();
    expect(terminalScreen(output)).not.toMatch(/DECISION_QUESTION|CONFIRM_SESSION_CHANGE/);
  });
});

describe("full tool identity and settlement output safety", () => {
  it("consumes repeated call IDs by invocation order and isolates the next Query", async () => {
    const { renderer, output } = capture("tui");
    const conversation = { ...idle, scene: "conversation" as const };
    await renderer.bindSession(conversation, []);
    await renderer.beginRun(identity);
    const first: TerminalToolRecord = {
      ...failedTool,
      invocationIdentity: identity,
      callId: "shared",
      name: "FIRST_INVOCATION",
    };
    await renderer.record(first);
    await renderer.settle(
      projectTerminalSettlement(
        {
          status: "waiting",
          identity,
          interaction: {
            id: "pending",
            owner: "files",
            payload: { type: "write", version: 1, data: {} },
          },
        },
        unsupported,
      ),
    );
    const resumed = { ...identity, runId: "second-invocation-run" };
    await renderer.beginRun(resumed);
    await renderer.record({
      ...first,
      identity: resumed,
      invocationIdentity: resumed,
      name: "SECOND_INVOCATION",
      phase: "completed",
      status: "unknown",
      effects: "unknown",
      error: { code: "UNCERTAIN", message: "second effect unknown" },
    });
    const final = projectTerminalSettlement(
      {
        status: "completed",
        identity: resumed,
        output: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "BEFORE_FIRST" },
              { type: "tool-call", callId: "shared", name: "FIRST_INVOCATION", input: {} },
            ],
          },
          { role: "tool", content: [{ type: "tool-result", callId: "shared", content: [] }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "BETWEEN_INVOCATIONS" },
              { type: "tool-call", callId: "shared", name: "SECOND_INVOCATION", input: {} },
            ],
          },
          { role: "tool", content: [{ type: "tool-result", callId: "shared", content: [] }] },
          { role: "assistant", content: [{ type: "text", text: "AFTER_SECOND" }] },
        ],
      },
      unsupported,
    );
    expect(final.timeline.filter((part) => part.type === "tool")).toHaveLength(2);
    expect(renderer.tools()).toHaveLength(2);
    await renderer.settle(final);
    let screen = terminalScreen(output);
    expect(screen.indexOf("BEFORE_FIRST")).toBeLessThan(screen.indexOf("FIRST_INVOCATION"));
    expect(screen.indexOf("FIRST_INVOCATION")).toBeLessThan(screen.indexOf("BETWEEN_INVOCATIONS"));
    expect(screen.indexOf("BETWEEN_INVOCATIONS")).toBeLessThan(screen.indexOf("SECOND_INVOCATION"));
    expect(screen.indexOf("SECOND_INVOCATION")).toBeLessThan(screen.indexOf("AFTER_SECOND"));
    const next = { ...identity, queryId: "next-query", runId: "next-query-run" };
    await renderer.beginRun(next);
    await renderer.record({
      ...first,
      identity: next,
      invocationIdentity: next,
      name: "THIRD_QUERY",
    });
    const boundary = output.length;
    await renderer.record({ ...first, name: "OLD_QUERY_LATE" });
    expect(output).toHaveLength(boundary);
    await renderer.settle(
      projectTerminalSettlement(
        {
          status: "completed",
          identity: next,
          output: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "NEW_QUERY_BEFORE" },
                { type: "tool-call", callId: "shared", name: "THIRD_QUERY", input: {} },
                { type: "text", text: "NEW_QUERY_AFTER" },
              ],
            },
          ],
        },
        unsupported,
      ),
    );
    await renderer.close();
    screen = terminalScreen(output);
    for (const name of ["FIRST_INVOCATION", "SECOND_INVOCATION", "THIRD_QUERY"])
      expect(screen.split(name)).toHaveLength(2);
    expect(screen.indexOf("NEW_QUERY_BEFORE")).toBeLessThan(screen.indexOf("THIRD_QUERY"));
    expect(screen.indexOf("THIRD_QUERY")).toBeLessThan(screen.indexOf("NEW_QUERY_AFTER"));
    expect(screen).not.toContain("OLD_QUERY_LATE");
  });

  it.each(["print", "jsonl"] as const)(
    "keeps %s settlement on the existing safe record protocol",
    async (mode) => {
      const { renderer, output, error } = capture(mode);
      await renderer.view(idle);
      const result: AgentRunResult = {
        status: "completed",
        identity,
        output: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "AUTHORITATIVE_ONLY" },
              {
                type: "tool-call",
                callId: "safe-id",
                name: "safe-tool",
                input: { secret: "PRIVATE_PAYLOAD" },
              },
              { type: "reasoning", text: "PUBLIC_REASONING" },
            ],
          },
        ],
      };
      await renderer.settle(projectTerminalSettlement(result, unsupported));
      await renderer.close();
      if (mode === "print") expect(output.join("")).toBe("AUTHORITATIVE_ONLY\n");
      else
        expect(
          output
            .join("")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual(projectTerminalResult(result, unsupported));
      expect(output.join("") + error.join("")).not.toMatch(
        /PRIVATE|timeline|messageIndex.*callId|\x1b/,
      );
    },
  );

  it("rejects coordinated write failures through the awaited settlement boundary", async () => {
    const failure = new Error("terminal writer failed");
    let failWrites = false;
    const renderer = createTerminalRenderer({
      mode: "tui",
      color: false,
      columns: () => 80,
      rows: () => 24,
      writeOutput: async () => {
        if (failWrites) throw failure;
      },
      writeError: async () => {},
      onOutputError: () => {},
    });
    await renderer.bindSession({ ...idle, scene: "conversation" }, []);
    await renderer.beginRun(identity);
    failWrites = true;
    await expect(
      renderer.settle(
        projectTerminalSettlement(
          {
            status: "completed",
            identity,
            output: [{ role: "assistant", content: [{ type: "text", text: "FINAL" }] }],
          },
          unsupported,
        ),
      ),
    ).rejects.toBe(failure);
    failWrites = false;
    await renderer.close();
  });
});

describe("activity text shimmer lifecycle", () => {
  it.each([40, 80, 120])(
    "moves color without changing text or cursor at %s columns",
    async (columns) => {
      vi.useFakeTimers();
      const { renderer, output } = capture("tui", columns, 24, true);
      const working: TerminalView = {
        ...idle,
        scene: "conversation",
        phase: "running",
        activity: "等待模型响应",
      };
      try {
        await renderer.view(working);
        const initial = terminalState(output);
        const boundary = output.length;
        await vi.advanceTimersByTimeAsync(540);
        const frames = output.slice(boundary);
        const colors = frames.map((frame) => frame.match(/\x1b\[[\d;]*m/gu)?.join(""));
        expect(new Set(colors).size).toBeGreaterThan(1);
        const animated = terminalState(output);
        // 只有活动指示符转动；通知正文和其他界面行不能被动画改写。
        const withoutSpinner = (lines: readonly string[]) =>
          lines.map((line) => line.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u, ""));
        expect(withoutSpinner(animated.lines)).toEqual(withoutSpinner(initial.lines));
        expect([animated.row, animated.column]).toEqual([initial.row, initial.column]);
        expect(animated.lines.every((line) => visibleWidth(line) < columns)).toBe(true);
        await renderer.view({ ...working, activity: "正在生成" });
        await vi.advanceTimersByTimeAsync(270);
        expect(terminalScreen(output)).toContain("正在生成");
        expect(terminalScreen(output)).not.toContain("等待模型响应");
        await renderer.settle(
          projectTerminalSettlement(
            {
              status: "completed",
              identity,
              output: [{ role: "assistant", content: [{ type: "text", text: "FINAL" }] }],
            },
            unsupported,
          ),
        );
        const settled = output.length;
        await vi.advanceTimersByTimeAsync(900);
        expect(output).toHaveLength(settled);
        expect(vi.getTimerCount()).toBe(0);
        await renderer.view({ ...working, phase: "idle", activity: undefined });
        expect(terminalScreen(output)).not.toContain("正在生成");
      } finally {
        await renderer.close();
        const closed = output.length;
        await vi.advanceTimersByTimeAsync(900);
        expect(output).toHaveLength(closed);
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
      }
    },
  );

  it.each([
    "waiting",
    "selector",
    "prompt",
    "blocking",
    "no-color",
    "plain",
    "print",
    "jsonl",
    "small",
  ] as const)("keeps %s activity static without an animation timer", async (mode) => {
    vi.useFakeTimers();
    const outputMode = mode === "plain" || mode === "print" || mode === "jsonl" ? mode : "tui";
    const { renderer, output, error } = capture(
      outputMode,
      mode === "small" ? 39 : 80,
      24,
      mode !== "no-color",
    );
    const working: TerminalView = {
      ...idle,
      scene: "conversation",
      phase: mode === "waiting" ? "waiting" : "running",
      activity: "等待模型响应",
      ...(mode === "selector"
        ? { selector: { title: "SELECT", query: "", items: [], selectedId: null } }
        : {}),
      ...(mode === "prompt" ? { prompt: { text: "INPUT", secret: true } } : {}),
      ...(mode === "blocking"
        ? { feedback: { kind: "blocking" as const, message: "PROBLEM" } }
        : {}),
    };
    try {
      await renderer.view(working);
      const before = [...output, ...error];
      await vi.advanceTimersByTimeAsync(1000);
      expect([...output, ...error]).toEqual(before);
      expect(vi.getTimerCount()).toBe(0);
      if (mode === "no-color") expect(output.join("")).not.toMatch(/\x1b\[[\d;]*m/u);
    } finally {
      await renderer.close();
      vi.useRealTimers();
    }
  });

  it("does not accumulate animation frames behind output backpressure or after close", async () => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<void>();
    const writes: string[] = [];
    let blocked = false;
    const renderer = createTerminalRenderer({
      mode: "tui",
      color: true,
      columns: () => 80,
      rows: () => 24,
      writeOutput: async (text) => {
        writes.push(text);
        if (blocked) await gate.promise;
      },
      writeError: async () => {},
      onOutputError: () => {},
    });
    try {
      await renderer.view({ ...idle, phase: "running", activity: "等待模型响应" });
      const beforeAnimation = writes.length;
      blocked = true;
      await vi.waitFor(() => expect(writes.length).toBeGreaterThan(beforeAnimation));
      const paused = writes.length;
      await vi.advanceTimersByTimeAsync(900);
      expect(writes).toHaveLength(paused);
      expect(vi.getTimerCount()).toBe(0);
      const closing = renderer.close();
      gate.resolve();
      await closing;
      const closed = writes.length;
      await vi.advanceTimersByTimeAsync(900);
      expect(writes).toHaveLength(closed);
    } finally {
      gate.resolve();
      await renderer.close();
      vi.useRealTimers();
    }
  });

  it("reports an animation write failure once and stops scheduling", async () => {
    vi.useFakeTimers();
    const failure = new Error("animation output failed");
    const failures: unknown[] = [];
    let failed = false;
    let writes = 0;
    const renderer = createTerminalRenderer({
      mode: "tui",
      color: true,
      columns: () => 80,
      rows: () => 24,
      writeOutput: async () => {
        writes += 1;
        if (failed) throw failure;
      },
      writeError: async () => {},
      onOutputError: (error) => {
        failures.push(error);
      },
    });
    try {
      await renderer.view({ ...idle, phase: "running", activity: "等待模型响应" });
      failed = true;
      await vi.waitFor(() => expect(failures).toEqual([failure]));
      const boundary = writes;
      await vi.advanceTimersByTimeAsync(900);
      expect(writes).toBe(boundary);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      failed = false;
      await renderer.close();
      vi.useRealTimers();
    }
  });
});

describe("public thinking, transcript history and run metrics", () => {
  for (const [width, height] of [
    [40, 12],
    [80, 24],
    [120, 40],
  ] as const) {
    it(`keeps thinking collapsed until opened and pages without losing text at ${width} columns`, async () => {
      const { renderer, output } = capture("tui", width, height);
      await renderer.view({ ...idle, scene: "conversation" });
      await renderer.preview([
        {
          identity,
          step: 1,
          requestId: "reason",
          contentIndex: 0,
          text: "PROVISIONAL_THOUGHT",
          reasoning: true,
          truncated: false,
        },
      ]);
      await renderer.view({ ...idle, scene: "conversation" });
      expect(terminalScreen(output)).not.toContain("PROVISIONAL_THOUGHT");
      await renderer.toggleThinking();
      expect(terminalScreen(output)).toContain("PROVISIONAL_THOUGHT");
      expect(await renderer.dismissDetail()).toBe(true);
      const rows = Array.from({ length: 30 }, (_, index) => `PUBLIC_ROW_${index}`);
      await renderer.settle(
        projectTerminalSettlement(
          {
            status: "completed",
            identity,
            output: [
              {
                role: "assistant",
                content: [
                  { type: "reasoning", text: rows.join("\n") },
                  { type: "text", text: "FINAL_ANSWER" },
                ],
                replayState: {
                  providerId: "p",
                  modelId: "m",
                  format: "f",
                  version: 1,
                  data: "PRIVATE_REPLAY",
                },
              },
            ],
          },
          unsupported,
        ),
      );
      expect(terminalScreen(output)).toContain("FINAL_ANSWER");
      expect(terminalScreen(output)).not.toContain("PUBLIC_ROW_0");
      const seen = new Set<string>();
      for (let page = 0; page < 40 && seen.size < rows.length; page += 1) {
        await renderer.toggleThinking();
        const screen = terminalState(output);
        const text = screen.lines.join("\n");
        for (const row of rows)
          if (text.split("\n").some((line) => line.trim() === row)) seen.add(row);
        expect(screen.lines.every((line) => visibleWidth(line) < width)).toBe(true);
      }
      expect([...seen].sort()).toEqual([...rows].sort());
      expect(output.join("")).not.toContain("PRIVATE_REPLAY");
      await renderer.close();
    });
  }

  it("discards provisional thinking on failure instead of exposing it as settled history", async () => {
    const { renderer, output } = capture("tui");
    await renderer.view(idle);
    await renderer.preview([
      {
        identity,
        step: 1,
        requestId: "reason",
        contentIndex: 0,
        text: "UNCOMMITTED_THOUGHT",
        reasoning: true,
        truncated: false,
      },
    ]);
    await renderer.view(idle);
    await renderer.toggleThinking();
    await renderer.record({
      version: 1,
      type: "query.result",
      identity,
      status: "failed",
      error: { code: "NETWORK", message: "Model stream interrupted" },
    });
    expect(terminalScreen(output)).not.toContain("UNCOMMITTED_THOUGHT");
    expect(renderer.thoughts()).toEqual([]);
    expect(await renderer.dismissDetail()).toBe(false);
    await renderer.close();
  });

  it("restores ordered safe history, opens saved thinking explicitly and clears it on session switch", async () => {
    const { renderer, output } = capture("tui");
    await renderer.bindSession({ ...idle, scene: "conversation" }, [
      { role: "user", text: "HISTORY_QUESTION" },
      { role: "reasoning", text: "HISTORY_PUBLIC_THOUGHT" },
      { role: "tool", tool: { callId: "read-1", name: "read", result: "recorded" } },
      { role: "assistant", text: "HISTORY_ANSWER" },
    ]);
    const text = terminalScreen(output);
    expect(text.indexOf("HISTORY_QUESTION")).toBeLessThan(text.indexOf("公开思考"));
    expect(text.indexOf("公开思考")).toBeLessThan(text.indexOf("read · 历史"));
    expect(text.indexOf("read · 历史")).toBeLessThan(text.indexOf("HISTORY_ANSWER"));
    expect(text).not.toContain("HISTORY_PUBLIC_THOUGHT");
    expect(text).toContain("历史未保留执行影响");
    await renderer.selectThinking(renderer.thoughts()[0]!.id);
    expect(terminalScreen(output)).toContain("HISTORY_PUBLIC_THOUGHT");
    await renderer.bindSession({ ...idle, context: { ...idle.context!, threadId: "other" } }, []);
    expect(renderer.thoughts()).toEqual([]);
    expect(await renderer.dismissDetail()).toBe(false);
    await renderer.close();
  });

  it("deduplicates observed metrics and labels resumed runs independently without guessing missing usage", async () => {
    const { renderer, output } = capture("tui");
    await renderer.view(idle);
    const metric = {
      version: 1 as const,
      type: "model.completed" as const,
      identity,
      requestId: "request",
      step: 1,
      durationMs: 100,
      usage: { inputTokens: 8, outputTokens: 5 },
    };
    await renderer.record({
      version: 1,
      type: "progress",
      identity,
      phase: "step.started",
      step: 1,
    });
    await renderer.record(metric);
    await renderer.record(metric);
    await renderer.record({
      version: 1,
      type: "model.completed",
      identity,
      requestId: "without-usage",
      step: 1,
      durationMs: 200,
    });
    await renderer.record({ version: 1, type: "query.result", identity, status: "completed" });
    const first = terminalScreen(output).replaceAll("\n", "");
    expect(first).toContain("1 步");
    expect(first).toContain("2 次模型响应");
    expect(first).toContain("模型用时 0.3s");
    expect(first).toContain("8 输入 / 5 输出 token（部分请求）");
    const boundary = output.length;
    await renderer.record({ version: 1, type: "query.result", identity, status: "completed" });
    expect(output.slice(boundary).join("")).not.toContain("本次运行");
    const resumed = { ...identity, runId: "resumed" };
    await renderer.beginRun(resumed);
    await renderer.record({
      version: 1,
      type: "model.completed",
      identity: resumed,
      requestId: "request",
      step: 2,
      durationMs: 0,
    });
    const resumedBoundary = output.length;
    await renderer.record({
      version: 1,
      type: "query.result",
      identity: resumed,
      status: "completed",
    });
    const resumedOutput = output.slice(resumedBoundary).join("");
    expect(resumedOutput).toContain("token 未提供");
    expect(resumedOutput).not.toContain("8 输入");
    await renderer.close();
  });

  it("groups only adjacent reads, retains per-call selection and splits at prose in canonical order", async () => {
    const { renderer, output } = capture("tui", 80, 40);
    await renderer.view({ ...idle, scene: "conversation" });
    for (let index = 0; index < 4; index += 1) {
      await renderer.record({
        version: 1,
        type: "tool",
        identity,
        invocationIdentity: identity,
        callId: `read-${index}`,
        name: "read",
        toolVersion: "1",
        step: 1,
        phase: "completed",
        status: "succeeded",
        effects: "none",
        display: { title: `file-${index}.txt`, input: [], output: [`BODY_${index}`] },
      });
    }
    await renderer.settle({
      records: [
        {
          version: 1,
          type: "assistant.message",
          identity,
          messageIndex: 0,
          content: [{ contentIndex: 2, text: "PROSE_BARRIER" }],
        },
        { version: 1, type: "query.result", identity, status: "completed" },
      ],
      timeline: [
        { type: "tool", callId: "read-0" },
        { type: "tool", callId: "read-1" },
        { type: "text", messageIndex: 0, contentIndex: 2, text: "PROSE_BARRIER" },
        { type: "tool", callId: "read-2" },
        { type: "tool", callId: "read-3" },
      ],
    });
    const text = terminalScreen(output);
    expect(text.match(/读取 2 项/g)).toHaveLength(2);
    expect(text.indexOf("file-1.txt")).toBeLessThan(text.indexOf("PROSE_BARRIER"));
    expect(text.indexOf("PROSE_BARRIER")).toBeLessThan(text.indexOf("file-2.txt"));
    expect(
      renderer
        .tools()
        .map((item) => item.description)
        .join("\n"),
    ).toContain("file-3.txt");
    await renderer.selectTool(renderer.tools()[0]!.id);
    expect(terminalScreen(output)).toContain("BODY_0");
    await renderer.close();
  });

  for (const mode of ["print", "plain", "jsonl"] as const) {
    it(`keeps reasoning separate from final answer output in ${mode}`, async () => {
      const { renderer, output } = capture(mode);
      await renderer.settle(
        projectTerminalSettlement(
          {
            status: "completed",
            identity,
            output: [
              {
                role: "assistant",
                content: [
                  { type: "reasoning", text: "PUBLIC_THOUGHT" },
                  { type: "text", text: "ANSWER_ONLY" },
                ],
              },
            ],
          },
          unsupported,
        ),
      );
      const text = output.join("");
      if (mode === "jsonl") {
        const records = text
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(records.find((record) => record.type === "assistant.reasoning").text).toBe(
          "PUBLIC_THOUGHT",
        );
        expect(records.find((record) => record.type === "assistant.message").content).toEqual([
          { contentIndex: 1, text: "ANSWER_ONLY" },
        ]);
      } else expect(text).toBe("ANSWER_ONLY\n");
      await renderer.close();
    });
  }
});
