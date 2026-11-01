import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { addAbortSignal, type Readable, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { TerminalCommand } from "./commands/terminal-command.js";
import {
  parseTerminalArguments,
  TERMINAL_HELP,
  TerminalArgumentError,
} from "./commands/terminal-command.js";
import type { NodeHostOptions, TerminalHost } from "./host/host-contract.js";
import { runTerminalController } from "./terminal/terminal-controller.js";

export interface CliEnvironment {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly error?: Writable;
  readonly environment?: NodeJS.ProcessEnv;
  readonly workspaceRoot?: string;
  readonly createHost?: (options: NodeHostOptions) => TerminalHost;
}

/** Callback-backed write observes drain/failure; no console output enters JSONL. */
function streamWriter(stream: Writable): (text: string) => Promise<void> {
  return (text) => {
    const pending = Promise.withResolvers<void>();
    stream.write(text, (error) => (error ? pending.reject(error) : pending.resolve()));
    return pending.promise;
  };
}

export async function runCli(args: readonly string[], ports: CliEnvironment = {}): Promise<number> {
  const input = ports.input ?? process.stdin;
  const output = ports.output ?? process.stdout;
  const error = ports.error ?? process.stderr;
  const environment = ports.environment ?? process.env;
  const writeOutput = streamWriter(output);
  const writeError = streamWriter(error);
  let pipeClosed = false;
  let otherOutputFailure = false;
  const observeOutput = (failure: unknown) => {
    if (
      typeof failure === "object" &&
      failure !== null &&
      "code" in failure &&
      failure.code === "EPIPE"
    )
      pipeClosed = true;
    else otherOutputFailure = true;
  };
  output.on("error", observeOutput);
  error.on("error", observeOutput);
  try {
    let command: TerminalCommand;
    try {
      command = parseTerminalArguments(args);
    } catch (failure) {
      if (!(failure instanceof TerminalArgumentError)) throw failure;
      const jsonl = args.some((arg, index) => arg === "--output" && args[index + 1] === "jsonl");
      if (jsonl) {
        await writeOutput(
          `${JSON.stringify({ version: 1, type: "error", stage: "configuration", error: { code: failure.code, message: failure.message }, outcomeUncertain: false })}\n`,
        );
        await writeOutput(
          `${JSON.stringify({ version: 1, type: "process.finished", exitCode: 2, reason: "arguments" })}\n`,
        );
      } else await writeError(`${failure.message}\n`);
      return 2;
    }
    if (command.help) {
      await writeOutput(TERMINAL_HELP);
      return 0;
    }
    if (Number(process.versions.node.split(".")[0]) < 24) {
      await writeError("CLI requires Node.js 24 or newer.\n");
      return 1;
    }
    const inputTTY = "isTTY" in input && input.isTTY === true;
    if (
      (command.print || command.output === "jsonl") &&
      command.prompt === undefined &&
      command.queryId === undefined &&
      inputTTY
    ) {
      await writeError("Print/JSONL requires --prompt, --resume, or piped input.\n");
      return 2;
    }
    if (!inputTTY && command.prompt === undefined && command.queryId === undefined) {
      let stopped: "interrupt" | "terminate" | undefined;
      const cancellation = new AbortController();
      const interrupt = () => {
        stopped = "interrupt";
        cancellation.abort();
      };
      const terminate = () => {
        stopped = "terminate";
        cancellation.abort();
      };
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate);
      let text = "";
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        addAbortSignal(cancellation.signal, input);
        for await (const chunk of input) {
          if (typeof chunk === "string") text += chunk;
          else if (Buffer.isBuffer(chunk)) text += decoder.decode(chunk, { stream: true });
          else throw new Error("Unsupported input chunk");
        }
        text += decoder.decode();
      } catch {
        if (stopped) return stopped === "interrupt" ? 130 : 143;
        await writeError("Cannot read UTF-8 task input.\n");
        return 1;
      } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", terminate);
      }
      if (!text.trim()) return 0;
      // Piped content, including slash lines, bypasses command parsing entirely.
      command = { ...command, prompt: text };
    }
    const dataRoot = resolve(
      environment.AGENT_HARNESS_CLI_DATA_DIR?.trim() || join(homedir(), ".agent-harness", "cli"),
    );
    const workspaceRoot = resolve(ports.workspaceRoot ?? environment.INIT_CWD ?? process.cwd());
    // The execution host loads platform-specific SQLite/credential capabilities.
    // Help and input-only paths must work when those capabilities are unavailable.
    const createHost = ports.createHost ?? (await import("./host/node-host.js")).createNodeHost;
    const code = await runTerminalController({
      command,
      host: createHost({ dataRoot, workspaceRoot }),
      input,
      output,
      error,
      writeOutput,
      writeError,
    });
    return otherOutputFailure ? 1 : pipeClosed ? (code === 1 ? 1 : 141) : code;
  } catch (failure) {
    observeOutput(failure);
    if (pipeClosed && !otherOutputFailure) return 141;
    // Unknown native/SDK exceptions must not cross the public terminal boundary.
    try {
      await writeError("CLI initialization or output failed.\n");
    } catch {
      /* The diagnostic sink itself may be closed. */
    }
    return 1;
  } finally {
    output.removeListener("error", observeOutput);
    error.removeListener("error", observeOutput);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
