import type { TerminalToolsMode } from "../host/host-contract.js";
import type { TerminalHostCommand, TerminalLocalCommand } from "../terminal/terminal-contract.js";

export const TERMINAL_HELP = `Agent Harness — Node CLI

Usage:
  npm run agent -- [options]
  npm run agent -- --prompt <text> [--output human|jsonl]
  npm run agent -- --thread <id> --resume <queryId>

Options:
  --help, -h              Show help without loading configuration or storage
  --prompt <text>         Execute one query; do not consume stdin as approval
  --print, -p             Execute once, never open interactive menus
  --output human|jsonl    Human output (default) or versioned JSONL records
  --no-color              Disable color, not editing
  --model <id>            Select a configured model for a new session
  --tools none|read-only|read-write
                          Installed workspace capability (default read-only)
  --thread <id> --resume <queryId>
                          Resume a persisted query in its original environment

Without prompt/resume, piped stdin up to EOF is one query (slash lines are text).
JSONL and print never prompt. Waiting is preserved and exits with code 3.

Interactive commands:
  /help /hotkeys /status /paste /exit /new /model /connect /resume /tools /tools-output /thinking
  // escapes an initial slash. /paste ends only with a separate /end line;
  //end inside /paste inserts /end. EOF never submits unfinished /paste.
  /model opens the fullscreen model panel; /connect focuses its connection sidebar.
  Saving a connection/default does not switch the current session without confirmation.

Keys:
  Enter send (idle only); Alt+Enter newline; arrows move through displayed input lines
  At input boundaries Up/Down browse history; returning past the newest restores the draft.
  Completion: Tab/Enter accepts text only; press Enter again to execute.
  Ctrl+O tool detail; Ctrl+T public thinking detail/page; Alt+M model
  Esc closes local UI before cancelling an active run
  Ctrl+C clear draft or request cancellation; empty Ctrl+D exit
  Approval: explicitly select then Enter; Tab never approves; Esc keeps waiting.
  Models: Left/Right or Tab switch panes; Up/Down move; Enter chooses; Esc returns.
  Type to search; All searches every connection. Plain: number/id + Enter,
  /groups or /connect returns to connections, /back or /cancel leaves safely.

Exit: 0 success, 1 failure, 2 arguments, 3 waiting, 130 user cancellation,
      143 host termination, 141 broken output pipe.
Data: ~/.agent-harness/cli (agent:dev uses cli-development).
      AGENT_HARNESS_CLI_DATA_DIR explicitly overrides the data directory.
`;

export interface TerminalCommand {
  readonly help: boolean;
  readonly print: boolean;
  readonly output: "human" | "jsonl";
  readonly noColor: boolean;
  readonly prompt?: string;
  readonly threadId?: string;
  readonly queryId?: string;
  readonly modelId?: string;
  readonly toolsMode?: TerminalToolsMode;
}

export class TerminalArgumentError extends Error {
  readonly code = "CLI_ARGUMENTS_INVALID";
}

export function parseTerminalArguments(args: readonly string[]): TerminalCommand {
  let help = false;
  let print = false;
  let output: "human" | "jsonl" = "human";
  let noColor = false;
  let prompt: string | undefined;
  let threadId: string | undefined;
  let queryId: string | undefined;
  let modelId: string | undefined;
  let toolsMode: TerminalToolsMode | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const option = args[index]!;
    const canonical = option === "-p" ? "--print" : option === "-h" ? "--help" : option;
    if (seen.has(canonical))
      throw new TerminalArgumentError("An option was specified more than once.");
    seen.add(canonical);
    const value = (): string => {
      const next = args[++index];
      if (next === undefined || !next.trim() || next.startsWith("--"))
        throw new TerminalArgumentError("An option requires a non-empty value.");
      return next;
    };
    switch (canonical) {
      case "--help":
        help = true;
        break;
      case "--print":
        print = true;
        break;
      case "--no-color":
        noColor = true;
        break;
      case "--prompt":
        prompt = value();
        break;
      case "--thread":
        threadId = value();
        break;
      case "--resume":
        queryId = value();
        break;
      case "--model":
        modelId = value();
        break;
      case "--output": {
        const selected = value();
        if (selected !== "human" && selected !== "jsonl")
          throw new TerminalArgumentError("--output requires human or jsonl.");
        output = selected;
        break;
      }
      case "--tools": {
        const selected = value();
        if (selected !== "none" && selected !== "read-only" && selected !== "read-write")
          throw new TerminalArgumentError("--tools requires none, read-only or read-write.");
        toolsMode = selected;
        break;
      }
      default:
        throw new TerminalArgumentError("Unknown option. Use --help for supported arguments.");
    }
  }
  if (Boolean(threadId) !== Boolean(queryId))
    throw new TerminalArgumentError("--thread and --resume must be specified together.");
  if (queryId && (prompt !== undefined || modelId !== undefined || toolsMode !== undefined))
    throw new TerminalArgumentError("Resume cannot change the prompt, model or tool binding.");
  return {
    help,
    print,
    output,
    noColor,
    ...(prompt === undefined ? {} : { prompt }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(queryId === undefined ? {} : { queryId }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(toolsMode === undefined ? {} : { toolsMode }),
  };
}

export interface TerminalCommandDefinition {
  readonly name: TerminalLocalCommand | TerminalHostCommand;
  readonly description: string;
}

export const LOCAL_COMMANDS: readonly TerminalCommandDefinition[] = [
  { name: "help", description: "查看可用命令与使用方式" },
  { name: "hotkeys", description: "查看键盘快捷键" },
  { name: "status", description: "查看模型、工作区与会话详情" },
  { name: "paste", description: "进入多行输入，以 /end 提交" },
  { name: "exit", description: "结束当前终端会话" },
  { name: "new", description: "确认后创建新会话" },
  { name: "model", description: "选择已配置模型" },
  { name: "connect", description: "添加或配置模型连接" },
  { name: "resume", description: "选择并恢复已有会话" },
  { name: "tools", description: "选择当前会话的能力模式" },
  { name: "tools-output", description: "查看工具调用的安全详情" },
  { name: "thinking", description: "选择公开思考块，Ctrl+T 查看最新思考" },
];

export type TerminalSubmittedText =
  | { readonly type: "message"; readonly text: string }
  | { readonly type: "command"; readonly name: TerminalLocalCommand | TerminalHostCommand }
  | { readonly type: "unknown-command" };

export function parseSubmittedText(text: string): TerminalSubmittedText {
  if (text.startsWith("//")) return { type: "message", text: text.slice(1) };
  const trimmed = text.trim();
  const command = LOCAL_COMMANDS.find((item) => trimmed === `/${item.name}`);
  if (command) return { type: "command", name: command.name };
  if (trimmed.startsWith("/") && !trimmed.includes("\n")) return { type: "unknown-command" };
  return { type: "message", text };
}
