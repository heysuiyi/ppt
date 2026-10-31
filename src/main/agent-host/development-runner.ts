import { randomUUID } from "node:crypto";
import { on } from "node:events";
import { mkdirSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { PassThrough } from "node:stream";
import { app, safeStorage } from "electron";
import { z } from "zod";
import type { AgentRunHandle, AgentRunResult } from "../../agent/agent-contract";
import { AgentError } from "../../agent/protocol-utils";
import type { InteractionResponse } from "../../agent/protocol-values";
import { createAgentConfiguration } from "../agent-configuration";
import { getApplicationDataRoot, getElectronUserDataRoot } from "../application-data";
import { type AgentHost, createAgentHost } from "./create-agent-host";
import {
  DEVELOPMENT_HELP,
  parseDevelopmentArguments,
  projectDevelopmentEvent,
  projectDevelopmentResult,
  publicDevelopmentError,
} from "./development-command";

// 该开发入口的终端只消费公开投影；完整 Gateway IO 不进入开发归档。
process.env.AGENT_GATEWAY_IO_LOG = "false";
const approvalSchema = z
  .object({
    tool: z.enum(["read", "glob", "grep", "write", "edit"]),
    path: z.string(),
    workspaceId: z.string(),
  })
  .strict();
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
process.on("SIGINT", requestCancellation);
process.on("SIGTERM", requestShutdown);
app.on("before-quit", (event) => {
  if (finalized) return;
  event.preventDefault();
  requestShutdown();
});
const receiveInput = (message: unknown) => {
  if (!message || typeof message !== "object" || !("type" in message)) return;
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
  if (parsed.help) {
    await writeText(DEVELOPMENT_HELP);
    return;
  }
  const command = parsed.command;
  const applicationDataRoot = getApplicationDataRoot();
  const electronRoot = getElectronUserDataRoot(applicationDataRoot);
  mkdirSync(electronRoot, { recursive: true });
  app.setName("agent-ppt");
  app.setPath("userData", electronRoot);
  input = createInterface({
    input: process.send ? forwardedInput : process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
    terminal: !process.send && Boolean(process.stdin.isTTY),
  });
  input.on("SIGINT", requestCancellation);
  // 立即订阅，保留模型请求期间提前到达的管道输入，不能用 question() 丢掉审批答案。
  const lines = on(input, "line", { close: ["close"] });
  process.send?.({ type: "agent-dev.ready" });
  await app.whenReady();
  startup.signal.throwIfAborted();
  const configuration = createAgentConfiguration({ applicationDataRoot, safeStorage });
  const threadId = command.threadId ?? randomUUID();
  host = await createAgentHost({
    configuration: configuration.runtime,
    applicationDataRoot,
    workspaceRoot: command.workspaceRoot,
    toolMode: command.toolMode,
    modelId: command.modelId,
    threadId,
    resume: Boolean(command.resumeQueryId),
    signal: startup.signal,
  });
  if (shutdown) {
    await host.close();
    return;
  }
  await write({
    type: "session.ready",
    agentId: host.binding.agentId,
    threadId,
    modelId: command.modelId,
  });

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
      if (
        interaction.owner !== "host-permissions" ||
        interaction.payload.type !== "host.workspace-tool" ||
        interaction.payload.version !== 1
      ) {
        throw new AgentError(
          "CLI_INTERACTION_UNSUPPORTED",
          "无法解释已保存的宿主交互，等待状态保持不变。",
        );
      }
      const approval = approvalSchema.parse(interaction.payload.data);
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
  if (command.resumeQueryId) {
    await finishQuery(await host.resume({ queryId: command.resumeQueryId, runId: randomUUID() }));
    return;
  }
  if (command.prompt) {
    await finishQuery(
      await host.run({
        queryId: command.queryId ?? randomUUID(),
        runId: randomUUID(),
        input: [{ role: "user", content: [{ type: "text", text: command.prompt }] }],
      }),
    );
    return;
  }
  let queryId = command.queryId;
  while (!cancelled && !shutdown) {
    await write({ type: "input", message: "输入问题，/exit 退出；工作区工具需要单独审批。" });
    const line = await lines.next();
    if (line.done) break;
    const text = line.value[0] as string;
    if (text.trim() === "/exit") break;
    if (!text.trim()) continue;
    const handle = await host.run({
      queryId: queryId ?? randomUUID(),
      runId: randomUUID(),
      input: [{ role: "user", content: [{ type: "text", text }] }],
    });
    queryId = undefined;
    if (!(await finishQuery(handle))) break;
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
