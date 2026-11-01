import { createAgentApplication } from "@agent-harness/core/application/agent-application";
import { createSqliteAgentStores } from "../../cli/dist/host/sqlite-agent-stores.js";

const stores = createSqliteAgentStores(process.argv[2]);
const gates = new Set();
let active;
let modelCalls = 0;
let closing = false;
let prepared;
const send = (value) => {
  if (process.connected) process.send(value);
};
async function pause(phase) {
  const gate = Promise.withResolvers();
  gates.add(gate);
  send({ type: "boundary", requestId: active.requestId, phase, pid: process.pid });
  try {
    await gate.promise;
  } finally {
    gates.delete(gate);
  }
}
function release() {
  for (const gate of gates) gate.resolve();
}
const checkpoints = {
  ...stores.checkpoints,
  async save(...args) {
    if (active?.mode === "initial-save" && !active.paused) {
      active.paused = true;
      await pause("initial-save");
    }
    return stores.checkpoints.save(...args);
  },
  async release(lease) {
    if (active?.mode === "terminal-release" && !active.paused) {
      active.paused = true;
      await pause("terminal-release");
    }
    return stores.checkpoints.release(lease);
  },
};
const application = createAgentApplication({
  history: stores.history,
  checkpoints,
  authorizeTool: () => ({ type: "allow" }),
  models: {
    async create(selection) {
      const generate = async (request, signal) => {
        modelCalls += 1;
        if (active?.mode === "model") await pause("model");
        signal.throwIfAborted();
        const text = request.messages
          .filter((message) => message.role === "user")
          .at(-1)
          .content.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        return {
          message: { role: "assistant", content: [{ type: "text", text: `reply:${text}` }] },
          finishReason: "stop",
        };
      };
      return {
        client: {
          selection,
          capabilities: { streaming: false, toolCalls: false, images: false, reasoning: false },
          generate,
          async *stream(request, signal) {
            yield { type: "completed", response: await generate(request, signal) };
          },
        },
        async dispose() {},
      };
    },
  },
});
const agent = await application.agents.create({
  agentId: "process-agent",
  definition: { id: "admission", version: "1", instructions: "Controlled local execution." },
  model: { providerId: "controlled", modelId: "local" },
  maxSteps: 2,
  plugins: [],
});
// 仅列出本矩阵使用的公开存储操作；prepare/go 将独立 PID 固定在同一提交前阶段。
async function storageOperation(message) {
  switch (message.operation) {
    case "acquire":
      return {
        acquisition: await stores.checkpoints.acquire(
          message.key,
          message.ownerId,
          message.replace ? { replace: message.replace } : undefined,
        ),
      };
    case "save":
      return {
        saved: await stores.checkpoints.save(
          message.lease,
          message.expectedRevision,
          message.checkpoint,
        ),
      };
    case "release-lease":
      await stores.checkpoints.release(message.lease);
      return { released: true };
    case "ensure-binding":
      await stores.bindings.ensure(message.binding);
      return { ensured: true };
    case "append-history":
      return {
        appended: await stores.history.append(
          message.threadId,
          message.expectedRevision,
          message.messages,
          message.batchId,
        ),
      };
    case "inspect-store": {
      const binding = await stores.bindings.read(message.key.threadId);
      const history = await stores.history.read(message.key.threadId);
      const acquisition = await stores.checkpoints.acquire(
        message.key,
        message.ownerId,
        message.replace ? { replace: message.replace } : undefined,
      );
      try {
        return { binding, history, acquisition };
      } finally {
        if (acquisition.status === "acquired") {
          await stores.checkpoints.release(acquisition.lease);
        }
      }
    }
    default:
      throw new Error("Unknown storage operation");
  }
}
async function storageReply(message) {
  try {
    send({
      type: "result",
      requestId: message.requestId,
      pid: process.pid,
      ...(await storageOperation(message)),
    });
  } catch (error) {
    // 领域拒绝与进程/I/O 失败分开报告，后者不能冒充 CAS 冲突。
    if (typeof error.code !== "string" || error.code.startsWith("ERR_")) throw error;
    send({ type: "result", requestId: message.requestId, pid: process.pid, error: error.code });
  }
}
async function command(message) {
  const { requestId } = message;
  if (message.command === "prepare") {
    if (prepared || active) throw new Error("Worker already has a prepared operation");
    prepared = message;
    send({ type: "result", requestId, phase: "prepared", pid: process.pid });
  } else if (message.command === "go") {
    if (!prepared) throw new Error("Worker has no prepared operation");
    const operation = prepared;
    prepared = undefined;
    await storageReply({ ...operation, requestId });
  } else if (message.command === "store") {
    await storageReply(message);
  } else if (message.command === "release") {
    release();
    send({ type: "result", requestId, released: true });
  } else if (message.command === "run") {
    if (active) throw new Error("Worker already has an active command");
    active = { requestId, mode: message.mode, paused: false };
    try {
      const handle = await agent.run({
        threadId: "process-thread",
        queryId: message.queryId,
        runId: message.runId,
        input: [{ role: "user", content: [{ type: "text", text: message.queryId }] }],
      });
      const result = await handle.completed;
      send({ type: "result", requestId, status: result.status, modelCalls, pid: process.pid });
    } catch (error) {
      send({
        type: "result",
        requestId,
        error: error.code ?? "WORKER_EXECUTION_FAILED",
        modelCalls,
        pid: process.pid,
      });
    } finally {
      active = undefined;
    }
  } else if (message.command === "inspect") {
    const history = await stores.history.read("process-thread");
    const acquired = await stores.checkpoints.acquire(
      { agentId: "process-agent", threadId: "process-thread", queryId: message.queryId },
      "inspection",
    );
    if (acquired.status !== "acquired") throw new Error(`Inspection refused: ${acquired.status}`);
    try {
      send({
        type: "result",
        requestId,
        history,
        checkpoint: acquired.checkpoint,
        generation: acquired.lease.generation,
        revision: acquired.currentRevision,
        pid: process.pid,
      });
    } finally {
      await stores.checkpoints.release(acquired.lease);
    }
  } else if (message.command === "close") {
    closing = true;
    release();
    await application.close();
    await stores.dispose();
    send({ type: "result", requestId, closed: true });
    process.disconnect();
  } else throw new Error("Unknown worker command");
}
process.on("message", (message) => {
  if (closing) return;
  void command(message).catch(async (error) => {
    console.error(error);
    release();
    try {
      await application.close();
    } finally {
      await stores.dispose();
    }
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
});
process.on("disconnect", () => {
  if (closing) return;
  closing = true;
  release();
  void application
    .close()
    .finally(() => stores.dispose())
    .catch(() => {
      process.exitCode = 1;
    });
});
send({ type: "ready", pid: process.pid });
