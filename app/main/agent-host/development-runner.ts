import { mkdirSync } from "node:fs";
import { PassThrough } from "node:stream";
import { AgentError } from "@agent-harness/core/protocol-errors";
import { app, safeStorage } from "electron";
import { z } from "zod";
import { createDevelopmentTerminal } from "../../../cli/development-terminal";
import { type AgentConfiguration, createAgentConfiguration } from "../agent-configuration";
import { getApplicationDataRoot, getElectronUserDataRoot } from "../application-data";
import { configuredModelFingerprint } from "./configured-model-factory";
import { createAgentHost } from "./create-agent-host";
import { listDevelopmentSessions } from "./development-sessions";
import { parseWorkspaceApproval } from "./workspace-configuration";

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
let finalized = false;
let applicationDataRoot: string;
let configuration: AgentConfiguration;
const terminal = createDevelopmentTerminal({
  input: process.send ? forwardedInput : process.stdin,
  terminal: !process.send && Boolean(process.stdin.isTTY),
  writeText(text) {
    const pending = Promise.withResolvers<void>();
    process.stdout.write(text, (error) => (error ? pending.reject(error) : pending.resolve()));
    return pending.promise;
  },
  async initialize(signal) {
    applicationDataRoot = getApplicationDataRoot();
    const electronRoot = getElectronUserDataRoot(applicationDataRoot);
    mkdirSync(electronRoot, { recursive: true });
    app.setName("agent-ppt");
    app.setPath("userData", electronRoot);
    await app.whenReady();
    signal.throwIfAborted();
    configuration = createAgentConfiguration({ applicationDataRoot, safeStorage });
    return configuration.management;
  },
  async getContext() {
    process.send?.({ type: "agent-dev.ready" });
    return process.send
      ? launchContext.promise
      : {
          workspaceRoot: process.cwd(),
          interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        };
  },
  createHost(options) {
    return createAgentHost({
      configuration: configuration.runtime,
      applicationDataRoot,
      ...options,
    });
  },
  listSessions(workspaceRoot) {
    return listDevelopmentSessions(applicationDataRoot, workspaceRoot);
  },
  async modelFingerprint(modelId) {
    const plan = await configuration.runtime.loadExecutionPlan(modelId);
    return configuredModelFingerprint(modelId, plan.model, plan.services.maxOutputTokens);
  },
  parseApproval: parseWorkspaceApproval,
});
const requestCancellation = () => {
  terminal.cancel();
  launchContext.reject(new AgentError("CLI_STARTUP_CANCELLED", "启动已取消。"));
};
const requestShutdown = () => {
  terminal.shutdown();
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

// 不能在 Electron ESM 模块顶层 await app.whenReady()；主消息循环要先完成模块加载。
async function main(): Promise<void> {
  let exitCode = 1;
  try {
    exitCode = await terminal.execute(process.argv.slice(2));
  } finally {
    process.removeListener("SIGINT", requestCancellation);
    process.removeListener("SIGTERM", requestShutdown);
    process.removeListener("message", receiveInput);
    process.removeListener("disconnect", requestShutdown);
    forwardedInput.destroy();
    finalized = true;
    app.exit(exitCode);
  }
}

void main();
