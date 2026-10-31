import { randomUUID } from "node:crypto";
import { on } from "node:events";
import { mkdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import { PassThrough } from "node:stream";
import type { AgentRunHandle, AgentRunResult } from "@agent-ppt/harness/agent-contract";
import { AgentError } from "@agent-ppt/harness/protocol-errors";
import type { InteractionResponse } from "@agent-ppt/harness/protocol-values";
import { app, safeStorage } from "electron";
import { z } from "zod";
import type { ToolsMode } from "../../tools/tools";
import { createAgentConfiguration } from "../agent-configuration";
import { getApplicationDataRoot, getElectronUserDataRoot } from "../application-data";
import { configuredModelFingerprint } from "./configured-model-factory";
import { type AgentHost, createAgentHost } from "./create-agent-host";
import {
  DEVELOPMENT_HELP,
  type DevelopmentCommand,
  parseDevelopmentArguments,
  projectDevelopmentEvent,
  projectDevelopmentModels,
  projectDevelopmentResult,
  publicDevelopmentError,
} from "./development-command";
import { listDevelopmentSessions } from "./development-sessions";
import { type DevelopmentSetupIO, ensureDevelopmentModel } from "./development-setup";
import { parseWorkspaceApproval } from "./workspace-configuration";

const writeText = (text: string): Promise<void> => {
  const pending = Promise.withResolvers<void>();
  process.stdout.write(text, (error) => (error ? pending.reject(error) : pending.resolve()));
  return pending.promise;
};
const write = (record: object): Promise<void> => writeText(`${JSON.stringify(record)}\n`);
let host: AgentHost | undefined;
let active: AgentRunHandle | undefined;
let input: Interface | undefined;
let cancelled = false;
let shutdown = false;
let settlingInteractionCancellation = false;
let finalized = false;
let exitCode = 0;
const startup = new AbortController();
const forwardedInput = new PassThrough();
const contextSchema = z
  .object({
    type: z.literal("agent-dev.context"),
    workspaceRoot: z.string().min(1),
    interactive: z.boolean(),
  })
  .strict();
const launchContext = Promise.withResolvers<z.infer<typeof contextSchema>>();
void launchContext.promise.catch(() => {});
const requestCancellation = () => {
  cancelled = true;
  if (!host) startup.abort();
  if (!settlingInteractionCancellation) active?.cancel("用户取消开发执行");
  input?.close();
  launchContext.reject(new AgentError("CLI_STARTUP_CANCELLED", "启动已取消。"));
};
const requestShutdown = () => {
  shutdown = true;
  startup.abort();
  input?.close();
  void host?.close().catch(() => {});
  launchContext.reject(new AgentError("CLI_STARTUP_CANCELLED", "启动已中止。"));
};
process.on("SIGINT", requestCancellation);
process.on("SIGTERM", requestShutdown);
app.on("before-quit", (event) => {
  if (finalized) return;
  event.preventDefault();
  requestShutdown();
});
const receiveInput = (message: unknown) => {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  if (message.type === "agent-dev.context") {
    const parsed = contextSchema.safeParse(message);
    if (parsed.success) launchContext.resolve(parsed.data);
    else launchContext.reject(new AgentError("CLI_CONTEXT_INVALID", "启动目录或终端信息无效。"));
  }
  if (message.type === "agent-dev.input" && "text" in message && typeof message.text === "string")
    forwardedInput.write(message.text, "utf8");
  else if (message.type === "agent-dev.end") forwardedInput.end();
  else if (message.type === "agent-dev.cancel") requestCancellation();
  else if (message.type === "agent-dev.shutdown") requestShutdown();
};
process.on("message", receiveInput);
process.on("disconnect", requestShutdown);

async function execute(): Promise<void> {
  const parsed = parseDevelopmentArguments(process.argv.slice(2));
  if (parsed.mode === "help") {
    await writeText(DEVELOPMENT_HELP);
    return;
  }
  const applicationDataRoot = getApplicationDataRoot();
  const electronRoot = getElectronUserDataRoot(applicationDataRoot);
  mkdirSync(electronRoot, { recursive: true });
  app.setName("agent-ppt");
  app.setPath("userData", electronRoot);
  await app.whenReady();
  startup.signal.throwIfAborted();
  const configuration = createAgentConfiguration({ applicationDataRoot, safeStorage });
  const command: DevelopmentCommand = parsed.command;
  input = createInterface({
    input: process.send ? forwardedInput : process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
    terminal: !process.send && Boolean(process.stdin.isTTY),
  });
  input.on("SIGINT", requestCancellation);
  // 向导、聊天与审批共用单一队列；提前到达的输入不能被 question() 丢弃。
  const lines = on(input, "line", { close: ["close"] });
  process.send?.({ type: "agent-dev.ready" });
  const context = process.send
    ? await launchContext.promise
    : {
        workspaceRoot: process.cwd(),
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      };
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
  let modelId = await ensureDevelopmentModel(configuration.management, io);
  if (!modelId || cancelled || shutdown) return;
  let threadId: string = randomUUID();
  let toolMode: ToolsMode = "read-only";
  const openSession = async (
    nextThreadId: string,
    nextModelId: string,
    nextToolMode: ToolsMode,
    resume = false,
  ) => {
    const next = await createAgentHost({
      configuration: configuration.runtime,
      applicationDataRoot,
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
      const approval = parseWorkspaceApproval(interaction);
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
        const selected = await ensureDevelopmentModel(configuration.management, io, true);
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
        const sessions = await listDevelopmentSessions(applicationDataRoot, workspaceRoot);
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
        const snapshot = await configuration.management.getSnapshot();
        const candidates = projectDevelopmentModels(snapshot).filter(
          (model) => model.status === "ready",
        );
        let selectedModelId: string | undefined;
        for (const candidate of candidates) {
          const plan = await configuration.runtime.loadExecutionPlan(candidate.id);
          if (
            configuredModelFingerprint(candidate.id, plan.model, plan.services.maxOutputTokens) ===
            selected.connectionFingerprint
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

// 不能在 Electron ESM 模块顶层 await app.whenReady()；主消息循环要先完成模块加载。
async function main(): Promise<void> {
  try {
    await execute();
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
    process.removeListener("SIGINT", requestCancellation);
    process.removeListener("SIGTERM", requestShutdown);
    process.removeListener("message", receiveInput);
    process.removeListener("disconnect", requestShutdown);
    forwardedInput.destroy();
    finalized = true;
    if (cancelled && exitCode === 0) exitCode = 130;
    if (shutdown && exitCode === 0) exitCode = 143;
    app.exit(exitCode);
  }
}

void main();
