import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComposer } from "../cli/terminal/composer.js";
import { layoutComposer } from "../cli/terminal/composer-layout.js";
import type { NodeTerminal, TerminalKeyEvent } from "../cli/terminal/input-contract.js";
import { createNodeTerminal } from "../cli/terminal/node-terminal.js";
import { createSelector } from "../cli/terminal/selector.js";
import { visibleWidth } from "../cli/terminal/terminal-text.js";

class TerminalInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode = vi.fn((enabled: boolean) => {
    this.isRaw = enabled;
    return this;
  });
}

class TerminalOutput extends Writable {
  isTTY = true;
  columns = 80;
  rows = 24;
  text = "";
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.text += chunk.toString();
    done();
  }
}

const terminals: NodeTerminal[] = [];
beforeEach(() => {
  vi.stubEnv("TERM", "xterm-256color");
  vi.stubEnv("NO_COLOR", undefined);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const terminal of terminals.splice(0)) await terminal.close();
  vi.unstubAllEnvs();
});

async function openTerminal(
  settings: {
    enabled?: boolean;
    noColor?: boolean;
    ttyOutput?: boolean;
    ttyInput?: boolean;
    ttyError?: boolean;
    columns?: number;
    rows?: number;
    onKey?: (event: TerminalKeyEvent, terminal: NodeTerminal) => void;
  } = {},
) {
  const input = new TerminalInput();
  const output = new TerminalOutput();
  const error = new TerminalOutput();
  input.isTTY = settings.ttyInput ?? true;
  output.isTTY = settings.ttyOutput ?? true;
  error.isTTY = settings.ttyError ?? true;
  output.columns = settings.columns ?? 80;
  output.rows = settings.rows ?? 24;
  const keys: TerminalKeyEvent[] = [];
  const onEnd = vi.fn();
  const onError = vi.fn();
  const onResize = vi.fn();
  const terminal = createNodeTerminal({
    input,
    output,
    error,
    enabled: settings.enabled ?? true,
    noColor: settings.noColor ?? false,
    onKey(event) {
      keys.push(event);
      settings.onKey?.(event, terminal);
    },
    onEnd,
    onError,
    onResize,
  });
  terminals.push(terminal);
  terminal.setGeneration(1);
  terminal.start();
  await setImmediate();
  return { input, output, error, terminal, keys, onEnd, onError, onResize };
}

describe("terminal grapheme composer", () => {
  it("edits combined characters, emoji and CJK at grapheme boundaries without submitting", () => {
    const composer = createComposer();
    composer.edit({ action: "insert", text: "中e\u0301👨‍👩‍👧‍👦", source: "keyboard" });
    expect(composer.draft).toEqual({ text: "中e\u0301👨‍👩‍👧‍👦", cursor: 3 });
    composer.edit({ action: "left" });
    composer.edit({ action: "backspace" });
    expect(composer.draft).toEqual({ text: "中👨‍👩‍👧‍👦", cursor: 1 });
    composer.edit({ action: "delete" });
    composer.edit({ action: "insert", text: "\u0301", source: "keyboard" });
    expect(composer.draft).toEqual({ text: "中\u0301", cursor: 1 });
    composer.edit({ action: "submit" });
    composer.edit({ action: "eof" });
    expect(composer.draft).toEqual({ text: "中\u0301", cursor: 1 });
  });

  it("preserves multiline paste and preferred columns across short lines", () => {
    const composer = createComposer();
    composer.setColumns(40);
    composer.edit({ action: "insert", text: "中文ab\r\nx\r\n12345", source: "paste" });
    composer.edit({ action: "left" });
    composer.edit({ action: "up" });
    expect(composer.draft.cursor).toBe(6);
    composer.edit({ action: "up" });
    expect(composer.draft.cursor).toBe(2);
    composer.edit({ action: "down" });
    composer.edit({ action: "down" });
    expect(composer.draft).toEqual({ text: "中文ab\nx\n12345", cursor: 11 });
    composer.edit({ action: "home" });
    expect(composer.draft.cursor).toBe(7);
    composer.edit({ action: "end" });
    expect(composer.draft.cursor).toBe(12);
  });

  it("recalls cleared Ctrl+C drafts only locally and restores in-progress input", () => {
    const composer = createComposer({ text: "first", cursor: 2 });
    composer.edit({ action: "interrupt" });
    expect(composer.draft.text).toBe("");
    composer.edit({ action: "insert", text: "unsent", source: "keyboard" });
    composer.edit({ action: "up" });
    expect(composer.draft).toEqual({ text: "first", cursor: 2 });
    composer.edit({ action: "down" });
    expect(composer.draft).toEqual({ text: "unsent", cursor: 6 });
  });

  it("browses multiline history without moving inside recalled entries and restores the unsent cursor", () => {
    const composer = createComposer({ text: "older\nentry", cursor: 7 });
    composer.clear(true);
    composer.setDraft({ text: "newer\nentry", cursor: 3 });
    composer.clear(true);
    composer.setDraft({ text: "草稿\n未提交", cursor: 1 });
    composer.edit({ action: "up" });
    expect(composer.draft).toEqual({ text: "newer\nentry", cursor: 3 });
    composer.edit({ action: "up" });
    expect(composer.draft).toEqual({ text: "older\nentry", cursor: 7 });
    composer.edit({ action: "down" });
    expect(composer.draft).toEqual({ text: "newer\nentry", cursor: 3 });
    composer.edit({ action: "down" });
    expect(composer.draft).toEqual({ text: "草稿\n未提交", cursor: 1 });
  });

  it.each(["edit", "position"] as const)(
    "leaves history browsing after a real %s without losing the saved draft",
    (kind) => {
      const composer = createComposer({ text: "older", cursor: 5 });
      composer.clear(true);
      composer.setDraft({ text: "ab\ncd", cursor: 4 });
      composer.clear(true);
      composer.setDraft({ text: "pending", cursor: 2 });
      composer.edit({ action: "up" });
      if (kind === "edit") composer.edit({ action: "insert", text: "X", source: "keyboard" });
      else composer.edit({ action: "left" });
      composer.edit({ action: "up" });
      expect(composer.draft).toEqual(
        kind === "edit" ? { text: "ab\ncXd", cursor: 2 } : { text: "ab\ncd", cursor: 0 },
      );
      composer.edit({ action: "up" });
      expect(composer.draft).toEqual({ text: "ab\ncd", cursor: 4 });
      composer.edit({ action: "down" });
      expect(composer.draft).toEqual({ text: "pending", cursor: 2 });
    },
  );

  it("moves through soft wraps using display columns across CJK, tabs and short lines", () => {
    const composer = createComposer({ text: "中ab\txy\nZ\n123456", cursor: 14 });
    composer.setColumns(6);
    for (const cursor of [8, 5, 2]) {
      composer.edit({ action: "up" });
      expect(composer.draft.cursor).toBe(cursor);
    }
    for (const cursor of [5, 8, 14]) {
      composer.edit({ action: "down" });
      expect(composer.draft.cursor).toBe(cursor);
    }
    expect(composer.draft.text).toBe("中ab\txy\nZ\n123456");
  });

  it("uses the new row's tab stop when moving vertically and inserting after a wrapped tab", () => {
    const composer = createComposer({ text: "abcde\txy\n12345", cursor: 13 });
    composer.setColumns(6);
    composer.edit({ action: "up" });
    expect(composer.draft).toEqual({ text: "abcde\txy\n12345", cursor: 6 });
    composer.edit({ action: "down" });
    expect(composer.draft.cursor).toBe(13);
    composer.edit({ action: "up" });
    composer.edit({ action: "insert", text: "Q", source: "keyboard" });
    expect(composer.draft).toEqual({ text: "abcde\tQxy\n12345", cursor: 7 });
  });

  it("keeps draft, cursor and history ownership through resize while updating navigation geometry", () => {
    const composer = createComposer({ text: "first\nsecond", cursor: 8 });
    composer.clear(true);
    composer.setDraft({ text: "abcdefghij", cursor: 7 });
    composer.setColumns(10);
    composer.setColumns(4);
    expect(composer.draft).toEqual({ text: "abcdefghij", cursor: 7 });
    composer.edit({ action: "up" });
    expect(composer.draft.cursor).toBe(3);
    composer.edit({ action: "up" });
    expect(composer.draft).toEqual({ text: "first\nsecond", cursor: 8 });
    composer.setColumns(2);
    expect(composer.draft).toEqual({ text: "first\nsecond", cursor: 8 });
    composer.edit({ action: "down" });
    expect(composer.draft).toEqual({ text: "abcdefghij", cursor: 3 });
  });

  it("does not move the cursor at a history boundary when there is no history", () => {
    const composer = createComposer({ text: "abc\nxy", cursor: 2 });
    composer.setColumns(10);
    composer.edit({ action: "up" });
    expect(composer.draft).toEqual({ text: "abc\nxy", cursor: 2 });
    composer.edit({ action: "down" });
    expect(composer.draft.cursor).toBe(6);
    composer.edit({ action: "down" });
    expect(composer.draft).toEqual({ text: "abc\nxy", cursor: 6 });
  });
});

describe("composer display layout", () => {
  it("maps source graphemes to safe physical cells through emoji, tabs, newlines and controls", () => {
    const layout = layoutComposer({ text: "中e\u0301👩🏽‍💻\tX\n\x1b\u202e", cursor: 3 }, 8);
    expect(layout.lines).toEqual(["中e\u0301👩🏽‍💻   ", "X", "\\x1b", "\\u202e"]);
    expect(layout.positions).toEqual([
      { row: 0, column: 0 },
      { row: 0, column: 2 },
      { row: 0, column: 3 },
      { row: 0, column: 5 },
      { row: 1, column: 0 },
      { row: 1, column: 1 },
      { row: 2, column: 0 },
      { row: 3, column: 0 },
      { row: 3, column: 6 },
    ]);
    expect([layout.cursorRow, layout.cursorColumn]).toEqual([0, 5]);
    expect(layout.lines.join("")).not.toMatch(/[\x00-\x1f\u202e]/u);
  });

  it.each([0, 1, 2])(
    "keeps narrow layouts bounded without changing source cursor boundaries at width %s",
    (columns) => {
      const draft = { text: "中👨‍👩‍👧‍👦\t\x1b\n", cursor: 4 };
      const layout = layoutComposer(draft, columns);
      const width = Math.max(1, columns);
      expect(layout.positions).toHaveLength(6);
      for (const line of layout.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      for (const position of layout.positions) {
        expect(position.row).toBeLessThan(layout.lines.length);
        expect(position.column).toBeGreaterThanOrEqual(0);
        expect(position.column).toBeLessThanOrEqual(width);
      }
      expect([layout.cursorRow, layout.cursorColumn]).toEqual([
        layout.positions[4]!.row,
        layout.positions[4]!.column,
      ]);
      expect(draft).toEqual({ text: "中👨‍👩‍👧‍👦\t\x1b\n", cursor: 4 });
    },
  );
});

describe("data-backed selector", () => {
  const items = [
    { id: "allow", label: "Allow", description: "read workspace" },
    { id: "deny", label: "Deny", description: "keep waiting" },
    { id: "model", label: "中文模型" },
  ];

  it("never preselects permissions or accepts a search result implicitly", () => {
    const selector = createSelector(items);
    expect(selector.accept()).toBeUndefined();
    selector.search("ALLOW");
    expect(selector.items.map((item) => item.id)).toEqual(["allow"]);
    expect(selector.accept()).toBeUndefined();
    selector.move(1);
    expect(selector.accept()).toBe("allow");
    expect(selector.accept()).toBe("allow");
    selector.search("nothing");
    selector.move(-1);
    expect(selector.accept()).toBeUndefined();
    expect(items).toHaveLength(3);
  });

  it("honors explicit valid selection and moves only through real filtered data", () => {
    const selector = createSelector(items, "deny");
    expect(selector.accept()).toBe("deny");
    selector.search("workspace");
    expect(selector.selectedId).toBeNull();
    selector.move(-1);
    expect(selector.accept()).toBe("allow");
    selector.search("中文");
    expect(selector.accept()).toBeUndefined();
    selector.move(1);
    expect(selector.accept()).toBe("model");
    expect(createSelector(items, "missing").accept()).toBeUndefined();
  });
});

describe("Node terminal byte ownership", () => {
  it("never touches stdin in disabled or nonTTY operation", async () => {
    for (const settings of [
      { enabled: false },
      { ttyInput: false },
      { ttyOutput: false, ttyError: false },
    ]) {
      const { input, terminal, output, error } = await openTerminal(settings);
      expect(terminal.mode).toBe("headless");
      expect(input.listenerCount("data")).toBe(0);
      expect(input.setRawMode).not.toHaveBeenCalled();
      expect(terminal.secretAvailable).toBe(false);
      await terminal.close();
      expect(output.text + error.text).toBe("");
    }
  });

  it("uses raw plain input with stderr TTY and does not echo or color dumb terminals", async () => {
    vi.stubEnv("TERM", "dumb");
    const { input, output, error, terminal, keys } = await openTerminal({ ttyOutput: false });
    expect(terminal.mode).toBe("plain");
    expect(terminal.secretAvailable).toBe(true);
    expect(terminal.color).toBe(false);
    input.write("secret\r\n");
    expect(keys).toEqual([
      { generation: 1, key: { action: "insert", text: "secret", source: "keyboard" } },
      { generation: 1, key: { action: "submit" } },
    ]);
    await terminal.close();
    expect(output.text + error.text).toBe("");
    expect(input.isRaw).toBe(false);
  });

  it("keeps color independent from editing and restores modes once", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("NO_COLOR", "");
    const { input, output, terminal } = await openTerminal();
    expect(terminal.mode).toBe("tui");
    expect(terminal.color).toBe(false);
    expect(input.listenerCount("data")).toBe(1);
    expect(input.isRaw).toBe(true);
    expect(output.text).toBe("\x1b[?2004h");
    await terminal.close();
    await terminal.close();
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(output.text).toBe("\x1b[?2004h\x1b[?2004l\x1b[?25h");
    expect(input.listenerCount("data")).toBe(0);
  });

  it("honors explicit no-color without disabling raw editing", async () => {
    const { input, terminal, keys } = await openTerminal({ noColor: true });
    expect(terminal.color).toBe(false);
    expect(terminal.mode).toBe("tui");
    input.write("text");
    expect(keys[0]?.key).toEqual({ action: "insert", text: "text", source: "keyboard" });
  });

  it("does not collect input from a TTY whose OS echo cannot be disabled", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new TerminalOutput();
    const terminal = createNodeTerminal({
      input,
      output,
      error: output,
      enabled: true,
      noColor: false,
      onKey: vi.fn(),
      onResize: vi.fn(),
      onEnd: vi.fn(),
      onError: vi.fn(),
    });
    terminals.push(terminal);
    terminal.start();
    expect(terminal.mode).toBe("headless");
    expect(terminal.secretAvailable).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("restores a borrowed pre-existing raw setting and reports restoration failure", async () => {
    const input = new TerminalInput();
    input.isRaw = true;
    const output = new TerminalOutput();
    const terminal = createNodeTerminal({
      input,
      output,
      error: output,
      enabled: true,
      noColor: false,
      onKey: vi.fn(),
      onResize: vi.fn(),
      onEnd: vi.fn(),
      onError: vi.fn(),
    });
    terminals.push(terminal);
    terminal.start();
    await setImmediate();
    await terminal.close();
    expect(input.setRawMode.mock.calls).toEqual([[true], [true]]);
    const failed = await openTerminal();
    failed.input.setRawMode.mockImplementationOnce(() => {
      throw new Error("restore failed");
    });
    await expect(failed.terminal.close()).rejects.toThrow("Terminal restoration failed");
    expect(failed.output.text).toContain("\x1b[?2004l\x1b[?25h");
    terminals.splice(terminals.indexOf(failed.terminal), 1);
  });

  it.each(["close", "eof", "error"] as const)(
    "awaits restoration callbacks and observes delayed output errors during %s",
    async (trigger) => {
      const input = new TerminalInput();
      const restorationStarted = Promise.withResolvers<void>();
      let finish: ((error?: Error | null) => void) | undefined;
      const output = Object.assign(
        new Writable({
          highWaterMark: 1,
          write(chunk: Buffer, _encoding, done) {
            if (chunk.toString().includes("\x1b[?2004l")) {
              finish = done;
              restorationStarted.resolve();
            } else done();
          },
        }),
        { isTTY: true, columns: 80, rows: 24 },
      );
      const onError = vi.fn();
      const onEnd = vi.fn();
      const terminal = createNodeTerminal({
        input,
        output,
        error: output,
        enabled: true,
        noColor: false,
        onKey: vi.fn(),
        onResize: vi.fn(),
        onEnd,
        onError,
      });
      terminal.start();
      await setImmediate();
      if (trigger === "eof") input.end();
      else if (trigger === "error") input.destroy(new Error("input failed"));
      if (trigger !== "close") await restorationStarted.promise;
      const closing = terminal.close();
      let settled = false;
      void closing.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await restorationStarted.promise;
      await setImmediate();
      expect(settled).toBe(false);
      expect(input.isRaw).toBe(false);
      expect(onEnd).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      const rejected = expect(closing).rejects.toThrow("Terminal restoration failed");
      const failure = new Error("asynchronous restoration write failed");
      finish?.(failure);
      await rejected;
      await setImmediate();
      expect(output.listenerCount("error")).toBe(0);
      if (trigger === "eof") {
        expect(onEnd).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledOnce();
      } else if (trigger === "error") expect(onError).toHaveBeenCalledOnce();
      await expect(terminal.close()).rejects.toThrow("Terminal restoration failed");
    },
  );

  it("decodes fragmented UTF8 and bracketed paste as one multiline text action", async () => {
    const { input, keys } = await openTerminal();
    const pasted = "/exit\r\nallow\n中文👩🏽‍💻\x1b[A\r";
    const bytes = Buffer.from(`\x1b[200~${pasted}\x1b[201~`);
    for (const byte of bytes) input.write(Buffer.from([byte]));
    expect(keys).toEqual([
      { generation: 1, key: { action: "insert", text: pasted, source: "paste" } },
    ]);
    input.write(Buffer.from("中").subarray(0, 1));
    input.write(Buffer.from("中").subarray(1));
    expect(keys.at(-1)?.key).toEqual({ action: "insert", text: "中", source: "keyboard" });
  });

  it("normalizes editing, modifiers and control keys without inserting unknown CSI", async () => {
    const { input, keys } = await openTerminal();
    input.write(
      "\r\x1b\r\x1b[13;2u\x1b[27;2;13~\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F\x1b[3~\x7f\t\x03\x04\x0f\x1bm\x1b[99~",
    );
    expect(keys.map((event) => event.key.action)).toEqual([
      "submit",
      "newline",
      "newline",
      "newline",
      "up",
      "down",
      "right",
      "left",
      "home",
      "end",
      "delete",
      "backspace",
      "tab",
      "interrupt",
      "eof",
      "toggle-tool",
      "select-model",
    ]);
    input.write("\x1b[");
    input.write("D");
    expect(keys.at(-1)?.key.action).toBe("left");
  });

  it("does not deliver bytes queued behind a focus-changing callback to the new prompt", async () => {
    const { input, keys } = await openTerminal({
      onKey(event, terminal) {
        if (event.key.action === "submit") terminal.setGeneration(2);
      },
    });
    input.write("first\rallow\r");
    expect(keys.map((event) => event.key)).toEqual([
      { action: "insert", text: "first", source: "keyboard" },
      { action: "submit" },
    ]);
    input.write("next");
    expect(keys.at(-1)).toEqual({
      generation: 2,
      key: { action: "insert", text: "next", source: "keyboard" },
    });
  });

  it("discards old partial keys, UTF8 and entire paste ownership across generations", async () => {
    const { input, terminal, keys } = await openTerminal();
    input.write("\x1b[");
    terminal.setGeneration(2);
    input.write("A");
    input.write(Buffer.from("中").subarray(0, 1));
    terminal.setGeneration(3);
    input.write(Buffer.from("中").subarray(1));
    input.write("\x1b[200~old\n");
    terminal.setGeneration(4);
    input.write("allow\r\x1b[201~queued\r");
    expect(keys).toEqual([]);
    input.write("new");
    expect(keys).toEqual([
      { generation: 4, key: { action: "insert", text: "new", source: "keyboard" } },
    ]);
    expect(() => terminal.setGeneration(3)).toThrow(RangeError);
  });

  it("invalidates a queued Escape and keeps a later physical Escape local", async () => {
    const { input, terminal, keys } = await openTerminal();
    vi.useFakeTimers();
    input.write("\x1b");
    terminal.setGeneration(2);
    vi.advanceTimersByTime(100);
    expect(keys).toEqual([]);
    input.write("x"); // finishes the stale Alt sequence; cannot answer the new owner
    input.write("\x1b");
    vi.advanceTimersByTime(100);
    expect(keys).toEqual([{ generation: 2, key: { action: "escape" } }]);
  });

  it("reports resize without changing the input owner and starts undersized terminals plain", async () => {
    const { input, output, terminal, onResize } = await openTerminal();
    output.columns = 20;
    output.rows = 8;
    output.emit("resize");
    expect([terminal.columns, terminal.rows]).toEqual([20, 8]);
    expect(onResize).toHaveBeenCalledOnce();
    expect(terminal.mode).toBe("tui");
    expect(input.listenerCount("data")).toBe(1);
    expect((await openTerminal({ columns: 39 })).terminal.mode).toBe("plain");
    expect((await openTerminal({ rows: 11 })).terminal.mode).toBe("plain");
  });

  it("restores on EOF without submitting a partial paste and reports input errors after cleanup", async () => {
    const eof = await openTerminal();
    eof.input.write("\x1b[200~not submitted\n");
    eof.input.end();
    await setImmediate();
    await eof.terminal.close();
    expect(eof.keys).toEqual([]);
    expect(eof.onEnd).toHaveBeenCalledOnce();
    expect(eof.input.isRaw).toBe(false);
    expect(eof.output.text).toContain("\x1b[?2004l\x1b[?25h");
    const failed = await openTerminal();
    const cause = new Error("input disconnected");
    failed.input.destroy(cause);
    await setImmediate();
    await failed.terminal.close();
    expect(failed.onError).toHaveBeenCalledWith(cause);
    expect(failed.input.isRaw).toBe(false);
    expect(failed.onEnd).not.toHaveBeenCalled();
  });
});
