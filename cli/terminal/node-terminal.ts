import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { NodeTerminal, NodeTerminalOptions } from "./input-contract.js";
import type { TerminalEditorAction } from "./terminal-contract.js";

type InputStream = Readable & {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?: (raw: boolean) => unknown;
};
type OutputStream = Writable & {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  _refreshSize?: () => void;
};

const pasteStart = "\x1b[200~";
const pasteEnd = "\x1b[201~";
const escapeDelay = 40;
const keyActions: Readonly<Record<string, TerminalEditorAction["action"]>> = {
  "\r": "submit",
  "\n": "submit",
  "\t": "tab",
  "\x7f": "backspace",
  "\b": "backspace",
  "\x03": "interrupt",
  "\x04": "eof",
  "\x0f": "toggle-tool",
  "\x1b\r": "newline",
  "\x1b\n": "newline",
  "\x1bm": "select-model",
  "\x1bM": "select-model",
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[C": "right",
  "\x1b[D": "left",
  "\x1bOA": "up",
  "\x1bOB": "down",
  "\x1bOC": "right",
  "\x1bOD": "left",
  "\x1b[H": "home",
  "\x1b[F": "end",
  "\x1bOH": "home",
  "\x1bOF": "end",
  "\x1b[1~": "home",
  "\x1b[4~": "end",
  "\x1b[7~": "home",
  "\x1b[8~": "end",
  "\x1b[3~": "delete",
  "\x1b[13;2u": "newline",
  "\x1b[13;3u": "newline",
  "\x1b[27;2;13~": "newline",
  "\x1b[27;3;13~": "newline",
};

export function createNodeTerminal(options: NodeTerminalOptions): NodeTerminal {
  const input = options.input as InputStream;
  const output = options.output as OutputStream;
  const error = options.error as OutputStream;
  const cursorCapable = process.env.TERM !== "dumb";
  const rawCapable = typeof input.setRawMode === "function";
  const sizeStream = output.isTTY ? output : error;
  // Canonical TTY input echoes before JavaScript can hide it. Never claim a
  // safe interactive owner when this stream cannot actually enter raw mode.
  const mode =
    !options.enabled || !input.isTTY || !rawCapable
      ? "headless"
      : output.isTTY && cursorCapable && (output.columns ?? 0) >= 40 && (output.rows ?? 0) >= 12
        ? "tui"
        : error.isTTY
          ? "plain"
          : "headless";
  const controlOutput = mode === "tui" ? output : error;
  const raw = mode !== "headless" && rawCapable;
  const controls = raw && cursorCapable && controlOutput.isTTY === true;
  const previousRaw = input.isRaw === true;
  let generation = 0;
  let started = false;
  let closed = false;
  let ended = false;
  let rawOwned = false;
  let pasteEnabled = false;
  let decoder = new StringDecoder("utf8");
  let skipContinuation = false;
  let pending = "";
  let pendingGeneration = 0;
  let staleEscape = false;
  let paste: { generation: number; text: string; discard: boolean } | undefined;
  let escapeTimer: NodeJS.Timeout | undefined;
  let resizeTimer: NodeJS.Timeout | undefined;
  let afterCR = false;
  let startupWrite: Promise<void> | undefined;
  let cleanupResult: Promise<unknown[]> | undefined;

  function writeControl(sequence: string): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let callbackDone = false;
    let returnKnown = false;
    let needsDrain = false;
    let drained = false;
    let scheduled = false;
    let failure: unknown;

    function settle(): void {
      if (scheduled) return;
      scheduled = true;
      // Writable emits its asynchronous error after invoking a failed write
      // callback. Keep the observer until that emission has also completed.
      setImmediate(() => {
        scheduled = false;
        if (!failure && (!returnKnown || !callbackDone || (needsDrain && !drained))) return;
        controlOutput.off("error", failed);
        controlOutput.off("close", disconnected);
        controlOutput.off("drain", drain);
        if (failure) reject(failure);
        else resolve();
      });
    }

    function failed(cause: unknown): void {
      failure ??= cause;
      settle();
    }

    function disconnected(): void {
      if (!callbackDone || (needsDrain && !drained)) {
        failure ??= new Error("Terminal output closed during mode restoration");
      }
      settle();
    }

    function drain(): void {
      drained = true;
      settle();
    }

    controlOutput.on("error", failed);
    controlOutput.once("close", disconnected);
    controlOutput.once("drain", drain);
    try {
      needsDrain = !controlOutput.write(sequence, (cause) => {
        callbackDone = true;
        if (cause) failure ??= cause;
        settle();
      });
      returnKnown = true;
    } catch (cause) {
      failure = cause;
      returnKnown = true;
      settle();
    }
    return promise;
  }

  function emit(key: TerminalEditorAction, captured: number): void {
    if (!closed && captured === generation) options.onKey({ generation: captured, key });
  }

  function cancelEscape(): void {
    clearTimeout(escapeTimer);
    escapeTimer = undefined;
  }

  function cleanup(): Promise<unknown[]> {
    if (cleanupResult) return cleanupResult;
    closed = true;
    cancelEscape();
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("close", onEnd);
    input.off("error", onError);
    sizeStream.off("resize", onResize);
    clearInterval(resizeTimer);
    resizeTimer = undefined;
    pending = "";
    paste = undefined;
    const failures: unknown[] = [];
    if (rawOwned) {
      rawOwned = false;
      try {
        input.setRawMode?.(previousRaw);
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (started && mode !== "headless") {
      try {
        input.pause();
      } catch (cause) {
        failures.push(cause);
      }
    }
    cleanupResult = (async () => {
      if (startupWrite) {
        try {
          await startupWrite;
        } catch (cause) {
          failures.push(cause);
        }
      }
      if (controls && started) {
        try {
          await writeControl(`${pasteEnabled ? "\x1b[?2004l" : ""}\x1b[?25h`);
        } catch (cause) {
          failures.push(cause);
        }
        pasteEnabled = false;
      }
      return failures;
    })();
    return cleanupResult;
  }

  function onError(cause: unknown): void {
    void cleanup().then((failures) => {
      const additional = failures.filter((failure) => failure !== cause);
      options.onError(
        additional.length
          ? new AggregateError([cause, ...additional], "Terminal input failed")
          : cause,
      );
    });
  }

  function onEnd(): void {
    if (ended || closed) return;
    ended = true;
    // EOF never submits an unterminated line, paste or partial UTF-8 sequence.
    void cleanup().then((failures) => {
      if (failures.length)
        options.onError(new AggregateError(failures, "Terminal restoration failed"));
      options.onEnd();
    });
  }

  function onResize(): void {
    if (!closed) options.onResize();
  }

  function parseRaw(captured: number): void {
    while (pending && !closed) {
      if (paste) {
        const end = pending.indexOf(pasteEnd);
        if (end < 0) {
          const keep = Math.min(pasteEnd.length - 1, pending.length);
          if (!paste.discard) paste.text += pending.slice(0, pending.length - keep);
          pending = pending.slice(pending.length - keep);
          return;
        }
        const completed = paste;
        if (!completed.discard) completed.text += pending.slice(0, end);
        pending = pending.slice(end + pasteEnd.length);
        paste = undefined;
        pendingGeneration = captured;
        if (completed.discard || completed.generation !== generation) {
          // A read completing an old paste cannot also answer the new owner.
          pending = "";
          return;
        }
        emit({ action: "insert", text: completed.text, source: "paste" }, completed.generation);
        continue;
      }
      if (pending.startsWith(pasteStart)) {
        paste = {
          generation: pendingGeneration,
          text: "",
          discard: staleEscape || pendingGeneration !== generation,
        };
        staleEscape = false;
        pending = pending.slice(pasteStart.length);
        continue;
      }
      let token: string;
      if (pending[0] === "\x1b") {
        if (pending.length === 1) {
          const tokenGeneration = pendingGeneration;
          escapeTimer = setTimeout(() => {
            escapeTimer = undefined;
            if (pending === "\x1b") {
              pending = "";
              if (!staleEscape) emit({ action: "escape" }, tokenGeneration);
              staleEscape = false;
            }
          }, escapeDelay);
          return;
        }
        if (pending[1] === "[" || pending[1] === "O") {
          const match = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O[@-~])/.exec(pending);
          if (!match) {
            // Unknown/incomplete CSI is never inserted as prompt text.
            if (pending.length > 128) {
              pending = "";
              staleEscape = false;
            }
            return;
          }
          token = match[0];
        } else {
          const point = pending.codePointAt(1);
          token = pending.slice(0, point !== undefined && point > 0xffff ? 3 : 2);
        }
      } else {
        const point = pending.codePointAt(0);
        token = pending.slice(0, point !== undefined && point > 0xffff ? 2 : 1);
      }
      pending = pending.slice(token.length);
      const tokenGeneration = pendingGeneration;
      pendingGeneration = captured;
      if (staleEscape) {
        staleEscape = false;
        pending = "";
        return;
      }
      if (afterCR && token === "\n") {
        afterCR = false;
        continue;
      }
      afterCR = token === "\r" || token === "\x1b\r";
      const action = keyActions[token];
      if (action && action !== "insert") emit({ action }, tokenGeneration);
      else if (token[0] !== "\x1b" && !/[\x00-\x1f\x7f-\x9f]/.test(token)) {
        // Coalesce ordinary text from one read without ever consuming controls.
        const match = /^[^\x00-\x1f\x7f-\x9f]+/.exec(pending);
        if (match) {
          token += match[0];
          pending = pending.slice(match[0].length);
        }
        emit({ action: "insert", text: token, source: "keyboard" }, tokenGeneration);
      }
    }
  }

  function onData(chunk: Buffer | string): void {
    const captured = generation;
    try {
      cancelEscape();
      let text: string;
      if (typeof chunk === "string") {
        text = chunk;
        skipContinuation = false;
      } else {
        let start = 0;
        if (skipContinuation) {
          while (start < chunk.length && ((chunk[start] ?? 0) & 0xc0) === 0x80) start++;
          if (start === chunk.length) return;
          skipContinuation = false;
          if (start > 0) return; // Discard the read containing an old UTF-8 tail.
        }
        text = decoder.write(chunk);
      }
      if (!pending) pendingGeneration = captured;
      pending += text;
      parseRaw(captured);
    } catch (cause) {
      onError(cause);
    }
  }

  return {
    mode,
    color:
      mode !== "headless" &&
      !options.noColor &&
      process.env.NO_COLOR === undefined &&
      cursorCapable,
    secretAvailable: raw,
    get columns() {
      return sizeStream.columns ?? 80;
    },
    get rows() {
      return sizeStream.rows ?? 24;
    },
    setGeneration(next) {
      if (!Number.isSafeInteger(next) || next < generation)
        throw new RangeError("Input generation must be a monotonic safe integer");
      if (next === generation) return;
      generation = next;
      cancelEscape();
      decoder = new StringDecoder("utf8");
      skipContinuation = true;
      if (paste) {
        paste.discard = true;
        paste.text = "";
      } else if (pending.startsWith("\x1b")) staleEscape = true;
      else pending = "";
    },
    start() {
      if (started || closed || mode === "headless") return;
      started = true;
      try {
        if (raw) {
          rawOwned = true;
          input.setRawMode?.(true);
        }
        if (controls) {
          pasteEnabled = true;
          startupWrite = writeControl("\x1b[?2004h");
          void startupWrite.catch(onError);
        }
        input.on("data", onData);
        input.once("end", onEnd);
        input.once("close", onEnd);
        input.once("error", onError);
        sizeStream.on("resize", onResize);
        // Windows ConPTY 不一定派发 resize；Node 24 的 TTY 尺寸缓存需主动刷新。
        // 计时器由当前输入 owner 持有，结束时撤销，不延长进程生命周期。
        if (mode === "tui" && process.platform === "win32" && sizeStream._refreshSize) {
          resizeTimer = setInterval(() => {
            try {
              sizeStream._refreshSize?.();
            } catch (cause) {
              onError(cause);
            }
          }, 250);
          resizeTimer.unref();
        }
        input.resume();
      } catch (cause) {
        onError(cause);
      }
    },
    async close() {
      const failures = await cleanup();
      if (failures.length) throw new AggregateError(failures, "Terminal restoration failed");
    },
  };
}
