import { Buffer } from "node:buffer";
import type { AgentRunResult } from "@agent-harness/core/agent-contract";
import { AgentError } from "@agent-harness/core/protocol-errors";
import type { RunIdentity } from "@agent-harness/core/protocol-values";
import type { RuntimeEvent } from "@agent-harness/core/session/session-events";
import { describe, expect, it } from "vitest";
import { createTerminalRenderer } from "../cli/terminal/interactive-renderer.js";
import { createPreviewBuffer } from "../cli/terminal/preview-buffer.js";
import type { TerminalOutputMode, TerminalView } from "../cli/terminal/renderer-contract.js";
import { statusLines } from "../cli/terminal/status-line.js";
import type { TerminalToolRecord } from "../cli/terminal/terminal-contract.js";
import {
  projectTerminalEvent,
  projectTerminalResult,
  terminalError,
} from "../cli/terminal/terminal-projection.js";
import {
  graphemes,
  markdownLines,
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
  });
  return { renderer, output, error, size };
}

/** Tracks display cells and the final cursor, including wide graphemes and redraw controls. */
function terminalState(writes: readonly string[]) {
  const lines: string[][] = [[]];
  let row = 0;
  let column = 0;
  let cursorVisible = true;
  const text = writes.join("");
  for (let index = 0; index < text.length; ) {
    const control = /^\x1b\[([?\d;]*)([A-Za-z])/.exec(text.slice(index));
    if (control) {
      const amount = Number(control[1]) || 1;
      switch (control[2]) {
        case "A":
          row = Math.max(0, row - amount);
          break;
        case "B":
          row += amount;
          break;
        case "C":
          column += amount;
          break;
        case "K":
          lines[row] = [];
          break;
        case "h":
        case "l":
          if (control[1] === "?25") cursorVisible = control[2] === "h";
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
  return { lines: lines.map((line) => line.join("")), row, column, cursorVisible };
}

function terminalScreen(writes: readonly string[]): string {
  return terminalState(writes).lines.join("\n");
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
        { role: "assistant", content: [{ type: "reasoning", text: "private reasoning" }] },
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
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      type: "assistant.message",
      messageIndex: 2,
      content: [{ contentIndex: 1, text: "authority\\x1b]0;injected\\a" }],
    });
    expect(JSON.stringify(records)).not.toMatch(/private|not assistant/);
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
  it("associates full identity/request/content and ignores reasoning, inputs and stale events", () => {
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
      delta: { type: "reasoning", text: "PRIVATE" },
    });
    expect(buffer.previews.map((part) => [part.requestId, part.contentIndex, part.text])).toEqual([
      ["request", 0, "one"],
      ["other", 2, "two"],
    ]);
    buffer.update({ kind: "fact", type: "step.committed", identity, step: 1, historyRevision: 1 });
    expect(buffer.previews).toHaveLength(2);
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
    expect(error.join("")).toContain("failed | effects=applied");
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
    await renderer.history([{ role: "assistant", text: "PRIVATE_HISTORY" }]);
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
      expect(output.join("").match(/immutable history/g)).toHaveLength(1);
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
      expect(output.join("")).not.toMatch(/\x1b\[\?(?:47|1047|1049)h|\x1b\[2J|\x1b\[3J/);
    });

  it("keeps failed/applied and unknown effects visible through tool selection", async () => {
    const { renderer, output } = capture("tui");
    await renderer.view(idle);
    await renderer.record(failedTool);
    await renderer.toggleTool();
    expect(terminalScreen(output)).toContain("failed | effects=applied");
    expect(terminalScreen(output)).toContain("no supported safe descriptor");
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
    expect(terminalScreen(output)).toContain("unknown | effects=unknown");
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
          activity: "CATALOG_ACTIVITY",
          notification: "LOCAL_NOTICE",
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
        expect(text).toContain("CATALOG_ACTIVITY");
        expect(screen.lines.length).toBeLessThan(rows);
        expect(screen.lines.every((line) => visibleWidth(line) < columns)).toBe(true);
        expect(screen.cursorVisible).toBe(false);
      }
      await renderer.close();
    });

    it(`places the cursor before a wrapped wide grapheme in ${columns}x${rows}`, async () => {
      const { renderer, output } = capture("tui", columns, rows);
      const prefix = "a".repeat(columns - 6);
      await renderer.view({
        ...idle,
        composer: {
          ...idle.composer,
          draft: { text: `${prefix}中👩‍💻é`, cursor: prefix.length },
        },
      });
      const screen = terminalState(output);
      expect(screen.lines[screen.row]).toContain("中👩‍💻é");
      expect(screen.column).toBe(2);
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
          text: `TARGET_MODEL ${"会话绑定说明".repeat(20)}\nTYPE_CONFIRMATION_TOKEN`,
          secret: false,
        },
        composer: { ...idle.composer, draft: { text: "answer", cursor: 6 } },
      });
      const screen = terminalState(output);
      expect(screen.lines.join("\n")).toContain("TARGET_MODEL");
      expect(screen.lines.join("\n")).toContain("TYPE_CONFIRMATION_TOKEN");
      expect(screen.lines[screen.row]).toContain("answer");
      expect(screen.column).toBe(8);
      expect(screen.cursorVisible).toBe(true);
      expect(screen.lines.length).toBeLessThan(rows);
      expect(screen.lines.every((line) => visibleWidth(line) < columns)).toBe(true);
      await renderer.close();
    });
  }

  it("keeps secret drafts out of framed and plain views across resize", async () => {
    const { renderer, output, error, size } = capture("tui", 40, 12);
    const view: TerminalView = {
      ...idle,
      prompt: { text: "SECRET_PROMPT", secret: true },
      composer: { ...idle.composer, draft: { text: "PRIVATE_DRAFT", cursor: 13 } },
    };
    await renderer.view(view);
    const screen = terminalState(output);
    expect(screen.lines.join("\n")).toContain("SECRET_PROMPT");
    expect(screen.column).toBe(2);
    size.columns = 30;
    await renderer.view(view);
    expect(output.join("") + error.join("")).not.toContain("PRIVATE_DRAFT");
    await renderer.close();
  });

  it("adds styling only when color is enabled", async () => {
    for (const color of [false, true]) {
      const { renderer, output } = capture("tui", 40, 12, color);
      await renderer.view(idle);
      expect(/\x1b\[[\d;]*m/.test(output.join(""))).toBe(color);
      expect(terminalState(output).lines.every((line) => visibleWidth(line) < 40)).toBe(true);
      await renderer.close();
    }
  });
});

describe("terminal Unicode and content safety", () => {
  it("keeps model identity, local activity and model state separate from phase and focused actions", () => {
    const view: TerminalView = {
      ...idle,
      activity: "LOCAL_ACTIVITY",
      context: { ...idle.context!, model: "MODEL_ID", modelStatus: "MODEL_STATE" },
    };
    const variants: TerminalView[] = [
      view,
      { ...view, phase: "running" },
      { ...view, phase: "waiting" },
      { ...view, prompt: { text: "INPUT_PROMPT", secret: false } },
      {
        ...view,
        selector: { title: "PICKER", query: "", items: [], selectedId: null },
      },
    ];
    const statuses = variants.map((variant) => statusLines(variant, 40));
    for (const lines of statuses) {
      expect(lines[0]).toContain("MODEL_ID");
      expect(lines.slice(1).join("\n")).toContain("LOCAL_ACTIVITY");
      expect(lines.slice(1).join("\n")).toContain("MODEL_STATE");
      expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    }
    expect(new Set(statuses.map((lines) => lines.at(-1))).size).toBe(variants.length);
    expect(new Set(statuses.slice(0, 3).map((lines) => lines[0])).size).toBe(3);
  });

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
