import { randomUUID } from "node:crypto";
import { on } from "node:events";
import { realpath } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import type { Readable } from "node:stream";
import type { AgentRunHandle, AgentRunResult } from "@agent-harness/core/agent-contract";
import { AgentError } from "@agent-harness/core/protocol-errors";
import type { InteractionRequest, InteractionResponse } from "@agent-harness/core/protocol-values";
import type { SessionHost } from "@agent-harness/core/session-host";
import type { ToolsMode } from "@agent-harness/tools/tools-contract";
import type { ConfigurationManagement } from "../src/shared/agent-configuration";
import {
  DEVELOPMENT_HELP,
  type DevelopmentCommand,
  parseDevelopmentArguments,
  projectDevelopmentEvent,
  projectDevelopmentModels,
  projectDevelopmentResult,
  publicDevelopmentError,
} from "./commands/development-command";
import { type DevelopmentSetupIO, ensureDevelopmentModel } from "./configuration/development-setup";

export interface DevelopmentTerminalHost extends Pick<SessionHost, "run" | "resume" | "close"> {
  readonly binding: { readonly agentId: string };
}

export interface DevelopmentTerminalSession {
  readonly threadId: string;
  readonly connectionFingerprint: string;
  readonly toolMode: ToolsMode;
  readonly history: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
  readonly unfinished?: {
    readonly queryId: string;
    readonly status: "running" | "waiting" | "interrupted";
  };
}

/** Desktop supplies encrypted configuration, host resources and launch transport. */
export interface DevelopmentTerminalPlatform {
  readonly input: Readable;
  readonly terminal: boolean;
  writeText(text: string): Promise<void>;
  initialize(signal: AbortSignal): Promise<ConfigurationManagement>;
  getContext(): Promise<{ readonly workspaceRoot: string; readonly interactive: boolean }>;
  createHost(options: {
    readonly workspaceRoot: string;
    readonly toolMode: ToolsMode;
    readonly modelId: string;
    readonly threadId: string;
    readonly resume: boolean;
    readonly signal: AbortSignal;
  }): Promise<DevelopmentTerminalHost>;
  listSessions(workspaceRoot: string): Promise<readonly DevelopmentTerminalSession[]>;
  modelFingerprint(modelId: string): Promise<string>;
  parseApproval(interaction: InteractionRequest): { readonly tool: string; readonly path: string };
}

export interface DevelopmentTerminal {
  execute(args: readonly string[]): Promise<number>;
  cancel(): void;
  shutdown(): void;
}

/** Owns one input queue shared by setup, chat, menus and waiting-run approvals. */
export function createDevelopmentTerminal(
  platform: DevelopmentTerminalPlatform,
): DevelopmentTerminal {
  const writeText = (text: string): Promise<void> => platform.writeText(text);
  const write = (record: object): Promise<void> => writeText(`${JSON.stringify(record)}\n`);
  let host: DevelopmentTerminalHost | undefined;
  let active: AgentRunHandle | undefined;
  let input: Interface | undefined;
  let cancelled = false;
  let shutdown = false;
  let settlingInteractionCancellation = false;
  let exitCode = 0;
  const startup = new AbortController();
  const requestCancellation = () => {
    cancelled = true;
    if (!host) startup.abort();
    if (!settlingInteractionCancellation) active?.cancel("用户取消开发执行");
    input?.close();
  };
  const requestShutdown = () => {
    shutdown = true;
    startup.abort();
    input?.close();
    void host?.close().catch(() => {});
  };

  async function execute(args: readonly string[]): Promise<void> {
    const parsed = parseDevelopmentArguments(args);
    if (parsed.mode === "help") {
      await writeText(DEVELOPMENT_HELP);
      return;
    }
    const management = await platform.initialize(startup.signal);
    const command: DevelopmentCommand = parsed.command;
    input = createInterface({
      input: platform.input,
      crlfDelay: Number.POSITIVE_INFINITY,
      terminal: platform.terminal,
    });
    input.on("SIGINT", requestCancellation);
    // 向导、聊天与审批共用单一队列；提前到达的输入不能被 question() 丢弃。
    const lines = on(input, "line", { close: ["close"] });
    const context = await platform.getContext();
    const workspaceRoot = await realpath(context.workspaceRoot);
    const io: DevelopmentSetupIO = {
      interactive: context.interactive,
      write: writeText,
      async readLine(prompt) {
        await writeText(prompt.endsWith("\n") ? prompt : `${prompt}\n`);
        const line = await lines.next();
        return line.done ? undefined : (line.value[0] as string);
      },
    };
    let modelId = await ensureDevelopmentModel(management, io);
    if (!modelId || cancelled || shutdown) return;
    let threadId: string = randomUUID();
    let toolMode: ToolsMode = "read-only";
    const openSession = async (
      nextThreadId: string,
      nextModelId: string,
      nextToolMode: ToolsMode,
      resume = false,
    ) => {
      const next = await platform.createHost({
        workspaceRoot,
        toolMode: nextToolMode,
        modelId: nextModelId,
        threadId: nextThreadId,
        resume,
        signal: startup.signal,
      });
      try {
        await host?.close();
      } catch (error) {
        await next.close();
        throw error;
      }
      host = next;
      threadId = nextThreadId;
      modelId = nextModelId;
      toolMode = nextToolMode;
      await write({
        type: "session.ready",
        agentId: host.binding.agentId,
        threadId,
        modelId,
        toolMode,
      });
    };
    await openSession(threadId, modelId, toolMode);
    if (shutdown) {
      await host?.close();
      return;
    }

    const runToBoundary = async (initial: AgentRunHandle): Promise<AgentRunResult> => {
      let handle = initial;
      while (true) {
        active = handle;
        if (cancelled && !settlingInteractionCancellation) handle.cancel();
        const observing = (async () => {
          for await (const event of handle.events) {
            const projection = projectDevelopmentEvent(event);
            if (projection) await write(projection);
          }
        })();
        let result: AgentRunResult;
        try {
          result = await handle.completed;
        } finally {
          await observing;
          active = undefined;
        }
        await write(projectDevelopmentResult(result));
        if (result.status !== "waiting" || shutdown) return result;
        const interaction = result.interaction;
        const approval = platform.parseApproval(interaction);
        let response: InteractionResponse | undefined;
        while (!response) {
          if (cancelled) {
            response = { type: "cancel", interactionId: interaction.id };
            break;
          }
          await write({
            type: "approval",
            threadId,
            queryId: result.identity.queryId,
            interactionId: interaction.id,
            tool: approval.tool,
            path: approval.path,
            choices: ["yes", "no", "cancel"],
          });
          const line = await lines.next();
          if (line.done) {
            if (cancelled) {
              response = { type: "cancel", interactionId: interaction.id };
              break;
            }
            return result;
          }
          const value = (line.value[0] as string).trim().toLowerCase();
          if (value === "yes" || value === "y")
            response = { type: "answer", interactionId: interaction.id, value: true };
          else if (value === "no" || value === "n")
            response = { type: "reject", interactionId: interaction.id };
          else if (value === "cancel") response = { type: "cancel", interactionId: interaction.id };
          else await write({ type: "input.invalid", message: "请输入 yes、no 或 cancel。" });
        }
        settlingInteractionCancellation = response.type === "cancel";
        handle = await host!.resume({
          queryId: result.identity.queryId,
          runId: randomUUID(),
          response,
        });
      }
    };
    const finishQuery = async (handle: AgentRunHandle): Promise<boolean> => {
      const result = await runToBoundary(handle);
      if (result.status === "failed") exitCode = 1;
      else if (result.status === "cancelled") exitCode = 130;
      else if (result.status === "interrupted") exitCode = 143;
      return result.status !== "waiting" && !cancelled && !shutdown;
    };
    if (command.prompt !== undefined) {
      await finishQuery(
        await host!.run({
          queryId: randomUUID(),
          runId: randomUUID(),
          input: [{ role: "user", content: [{ type: "text", text: command.prompt }] }],
        }),
      );
      return;
    }
    const help =
      "/model 选择或配置模型；/new 新会话；/resume 历史会话；/tools 工具模式；/help 帮助；/exit 退出。\n";
    await writeText(help);
    while (!cancelled && !shutdown) {
      const text = await io.readLine("输入问题或命令 > ");
      if (text === undefined || text.trim() === "/exit") break;
      const value = text.trim();
      if (!value) continue;
      try {
        if (value === "/help") {
          await writeText(help);
        } else if (value === "/new") {
          await openSession(randomUUID(), modelId!, toolMode);
        } else if (value === "/model") {
          if (
            (await io.readLine("选择模型后将新建会话，原历史保留。继续？yes/no："))
              ?.trim()
              .toLowerCase() !== "yes"
          )
            continue;
          const selected = await ensureDevelopmentModel(management, io, true);
          if (selected) await openSession(randomUUID(), selected, toolMode);
        } else if (value === "/tools") {
          const selected = (await io.readLine("工具模式：1. 只读  2. 读写  0. 返回\n> "))?.trim();
          if (selected === undefined) break;
          if (selected === "0") continue;
          if (selected !== "1" && selected !== "2") {
            await writeText("请输入 1、2 或 0。\n");
            continue;
          }
          const nextMode = selected === "1" ? "read-only" : "read-write";
          if (
            nextMode !== toolMode &&
            (await io.readLine("切换工具将新建会话，原历史保留。继续？yes/no："))
              ?.trim()
              .toLowerCase() === "yes"
          ) {
            await openSession(randomUUID(), modelId!, nextMode);
          }
        } else if (value === "/resume") {
          const sessions = await platform.listSessions(workspaceRoot);
          if (!sessions.length) {
            await writeText("当前工作区没有历史会话。\n");
            continue;
          }
          for (const [index, session] of sessions.entries()) {
            const title =
              session.history.find((message) => message.role === "user")?.text ?? "空会话";
            await writeText(
              `${index + 1}. ${JSON.stringify(title.slice(0, 80))} [${session.toolMode}${session.unfinished ? `, ${session.unfinished.status}` : ""}]\n`,
            );
          }
          const answer = (await io.readLine("选择会话编号，0 返回："))?.trim();
          if (answer === undefined) break;
          if (answer === "0") continue;
          const index = Number(answer);
          const selected = Number.isInteger(index) && index > 0 ? sessions[index - 1] : undefined;
          if (!selected) {
            await writeText("会话编号无效。\n");
            continue;
          }
          // 旧绑定只保存原生模型与连接指纹；按签发计划精确匹配，不猜配置 ID。
          const snapshot = await management.getSnapshot();
          const candidates = projectDevelopmentModels(snapshot).filter(
            (model) => model.status === "ready",
          );
          let selectedModelId: string | undefined;
          for (const candidate of candidates) {
            if (
              (await platform.modelFingerprint(candidate.id)) === selected.connectionFingerprint
            ) {
              selectedModelId = candidate.id;
              break;
            }
          }
          if (!selectedModelId) {
            throw new AgentError(
              "HOST_BINDING_CHANGED",
              "原模型连接或执行配置已变更，无法恢复；请恢复原配置或新建会话。",
            );
          }
          await openSession(selected.threadId, selectedModelId, selected.toolMode, true);
          await write({ type: "session.history", threadId, messages: selected.history });
          if (
            selected.unfinished &&
            !(await finishQuery(
              await host!.resume({
                queryId: selected.unfinished.queryId,
                runId: randomUUID(),
              }),
            ))
          )
            break;
        } else if (value.startsWith("/")) {
          await writeText("未知命令，输入 /help 查看可用命令。\n");
        } else if (
          !(await finishQuery(
            await host!.run({
              queryId: randomUUID(),
              runId: randomUUID(),
              input: [{ role: "user", content: [{ type: "text", text }] }],
            }),
          ))
        ) {
          break;
        }
      } catch (error) {
        if (cancelled || shutdown) throw error;
        exitCode = 1;
        await write({ type: "error", error: publicDevelopmentError(error) });
        // 操作失败后停止消费队列，避免把预先输入的审批回答误当作新问题。
        break;
      }
    }
  }

  return {
    cancel: requestCancellation,
    shutdown: requestShutdown,
    async execute(args) {
      try {
        await execute(args);
      } catch (error) {
        exitCode = cancelled ? 130 : shutdown ? 143 : 1;
        if (!cancelled && !shutdown) {
          const detail = publicDevelopmentError(error);
          if (detail.code === "CLI_ARGUMENTS_INVALID") exitCode = 2;
          await write({ type: "error", error: detail });
        }
      } finally {
        input?.close();
        try {
          await host?.close();
        } catch (error) {
          exitCode = 1;
          await write({ type: "error", error: publicDevelopmentError(error) });
        }
        if (cancelled && exitCode === 0) exitCode = 130;
        if (shutdown && exitCode === 0) exitCode = 143;
      }
      return exitCode;
    },
  };
}
