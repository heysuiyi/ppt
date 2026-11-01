import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { createAgentApplication } from "@agent-harness/core/application/agent-application";
import { z } from "zod";
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
// Recovery faults belong to one full Run identity and one semantic durable boundary.
// The resumed PID receives no selector; observing events never gates Core execution.
function selected(target, state) {
  const fault = active?.fault;
  if (!active?.recovery || !fault || active.fired || fault.target !== target) return false;
  if (state && (state.queryId !== active.queryId || state.lastRunId !== active.runId)) return false;
  if (fault.batchId && fault.batchId !== state?.inflight?.batchId) return false;
  if (fault.status && fault.status !== state?.status) return false;
  return true;
}
async function enter(port) {
  if (active?.armed && (active.armed === port || active.armed === "any")) {
    active.armed = undefined;
    await pause(`${active.fault.target}:${active.fault.kind}`);
  }
}
async function committed(target, state, nextPort) {
  if (!selected(target, state)) return;
  active.fired = true;
  if (active.fault.kind === "K0") await pause(`${target}:K0`);
  else active.armed = nextPort;
}
function saveTarget(state) {
  if (["completed", "failed", "cancelled"].includes(state.status)) return "terminal";
  if (
    state.inflight?.type === "resume" &&
    state.inflight.pending.invocation.call.callId === "ledger-1" &&
    state.inflight.pending.interaction.id === "ledger-1:confirm"
  )
    return "consume";
  if (state.inflight?.type === "tools") {
    if (state.inflight.completed.some((item) => item.invocation.call.callId === "ledger-1"))
      return "completion";
    if (
      state.inflight.remaining.some(
        (item) => item.call.callId === "ledger-1" && item.state === "dispatched",
      )
    )
      return "dispatch";
  }
  if (!state.inflight && active?.lastAppend) return "ack";
  return undefined;
}
const history = {
  ...stores.history,
  async read(...args) {
    await enter("history");
    return stores.history.read(...args);
  },
  async append(...args) {
    await enter("append");
    const result = await stores.history.append(...args);
    if (active?.recovery && result.status === "appended") {
      active.lastAppend = args[3];
      active.receipts.push({
        batchId: args[3],
        expectedRevision: args[1],
        messages: args[2],
        result,
      });
      await committed(
        "append",
        { queryId: active.queryId, lastRunId: active.runId, inflight: { batchId: args[3] } },
        "save",
      );
    }
    return result;
  },
};
const checkpoints = {
  ...stores.checkpoints,
  async acquire(...args) {
    const result = await stores.checkpoints.acquire(...args);
    if (active?.recovery && result.status === "acquired") {
      active.acquisition = result;
      if (args[0].queryId === active.queryId && args[1] === active.runId)
        await committed("acquire", undefined, "any");
    }
    return result;
  },
  async save(...args) {
    await enter("save");
    if (active?.mode === "initial-save" && !active.paused) {
      active.paused = true;
      await pause("initial-save");
    }
    const result = await stores.checkpoints.save(...args);
    if (active?.recovery && result.status === "saved") {
      const state = args[2];
      active.saves.push(state);
      let target = saveTarget(state);
      if (target === "terminal" && active.fault?.target === "ack") target = "ack";
      const selectorState =
        target === "ack" ? { ...state, inflight: { batchId: active.lastAppend } } : state;
      await committed(
        target,
        selectorState,
        target === "dispatch" || target === "consume"
          ? "authorize"
          : target === "completion"
            ? "save"
            : target === "ack" && state.status !== "completed"
              ? "model"
              : "release",
      );
    }
    return result;
  },
  async release(lease) {
    await enter("release");
    if (active?.mode === "terminal-release" && !active.paused) {
      active.paused = true;
      await pause("terminal-release");
    }
    return stores.checkpoints.release(lease);
  },
};
const application = createAgentApplication({
  history,
  checkpoints,
  async authorizeTool(invocation, context) {
    if (
      active?.recovery &&
      context.identity.runId === active.runId &&
      invocation.callId === "ledger-1"
    )
      await enter("authorize");
    return { type: "allow" };
  },
  models: {
    async create(selection) {
      const generate = async (request, signal) => {
        modelCalls += 1;
        if (active?.recovery) {
          await enter("model");
          signal.throwIfAborted();
          if (active.terminal === "failed") throw new Error("Controlled model failure");
          if (active.terminal === "cancelled") {
            active.controller.abort();
            signal.throwIfAborted();
          }
          if (!request.messages.some((message) => message.role === "tool")) {
            return {
              message: {
                role: "assistant",
                content: [
                  {
                    type: "tool-call",
                    callId: "ledger-1",
                    name: "ledger.write",
                    input: { value: active.queryId },
                  },
                ],
              },
              finishReason: "tool-calls",
            };
          }
          return {
            message: { role: "assistant", content: [{ type: "text", text: "ledger settled" }] },
            finishReason: "stop",
          };
        }
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
          capabilities: { streaming: false, toolCalls: true, images: false, reasoning: false },
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
function ledger(phase, execution, interactionId) {
  const fd = openSync(active.ledgerPath, "a");
  try {
    writeSync(
      fd,
      `${JSON.stringify({
        scenarioId: active.scenarioId,
        ...execution.identity,
        callId: execution.callId,
        phase,
        interactionId,
        pid: process.pid,
        nonce: randomUUID(),
        applied: phase === "resume" || !active.wait || active.waitEffects === "applied",
      })}\n`,
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
const recoveryAgent = await application.agents.create({
  agentId: "recovery-agent",
  definition: { id: "recovery", version: "1", instructions: "One local ledger tool then final." },
  model: { providerId: "controlled", modelId: "local" },
  maxSteps: 3,
  plugins: [
    {
      id: "ledger",
      version: "1",
      setup(context) {
        context.tools.register({
          name: "ledger.write",
          owner: "ledger",
          version: "1",
          description: "Append a synced local effect",
          mode: "resumable",
          inputSchema: z.object({ value: z.string() }),
          outputSchema: z.object({ recorded: z.boolean() }),
          toModelContent: (result) => [{ type: "text", text: result.status }],
          async execute(value, execution) {
            ledger("execute", execution);
            if (
              execution.callId === "ledger-1" &&
              selected("effect", {
                queryId: execution.identity.queryId,
                lastRunId: execution.identity.runId,
              })
            ) {
              active.fired = true;
              await pause("effect:effect-before-save");
            }
            if (active.wait)
              return {
                status: "waiting",
                effects: active.waitEffects,
                interaction: {
                  id: "ledger-1:confirm",
                  owner: "ledger",
                  payload: { type: "ledger.confirm", version: 1, data: {} },
                },
                continuation: { type: "ledger.write", version: 1, data: { value: value.value } },
              };
            return { status: "succeeded", output: { recorded: true }, effects: "applied" };
          },
          async resume(continuation, response, execution) {
            z.object({ value: z.string() }).parse(continuation.data);
            ledger("resume", execution, response.interactionId);
            if (
              execution.callId === "ledger-1" &&
              response.interactionId === "ledger-1:confirm" &&
              selected("effect", {
                queryId: execution.identity.queryId,
                lastRunId: execution.identity.runId,
              })
            ) {
              active.fired = true;
              await pause("effect:effect-before-save");
            }
            return { status: "succeeded", output: { recorded: true }, effects: "applied" };
          },
        });
      },
    },
  ],
});
async function recovery(message) {
  if (active) throw new Error("Worker already has an active command");
  active = {
    ...message,
    recovery: true,
    fired: false,
    receipts: [],
    saves: [],
    controller: new AbortController(),
  };
  const current = active;
  const events = [];
  try {
    const input = {
      threadId: "recovery-thread",
      queryId: message.queryId,
      runId: message.runId,
      signal: current.controller.signal,
    };
    const handle = message.resume
      ? await recoveryAgent.resume({
          ...input,
          ...(message.response ? { response: message.response } : {}),
          ...(message.takeover ? { takeover: message.takeover } : {}),
        })
      : await recoveryAgent.run({
          ...input,
          input: [{ role: "user", content: [{ type: "text", text: message.queryId }] }],
        });
    const observing = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    const result = await handle.completed;
    await observing;
    send({
      type: "result",
      requestId: message.requestId,
      pid: process.pid,
      status: result.status,
      interaction: result.interaction,
      modelCalls,
      events,
      acquisition: current.acquisition,
      saves: current.saves,
      receipts: current.receipts,
    });
  } catch (error) {
    send({
      type: "result",
      requestId: message.requestId,
      pid: process.pid,
      error: error.code ?? "WORKER_EXECUTION_FAILED",
      modelCalls,
      events,
      acquisition: current.acquisition,
      saves: current.saves,
      receipts: current.receipts,
    });
  } finally {
    active = undefined;
  }
}
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
      if (message.ledgerPath) {
        // The third PID reads the independent effect ledger, not an old worker counter.
        try {
          message.ledger = readFileSync(message.ledgerPath, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(JSON.parse);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          message.ledger = [];
        }
      }
      const binding = await stores.bindings.read(message.key.threadId);
      const history = await stores.history.read(message.key.threadId);
      const acquisition = await stores.checkpoints.acquire(
        message.key,
        message.ownerId,
        message.replace ? { replace: message.replace } : undefined,
      );
      try {
        return {
          binding,
          history,
          acquisition,
          ledger: message.ledger,
          unfinished: await stores.checkpoints.findUnfinished(
            message.key.agentId,
            message.key.threadId,
          ),
        };
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
  if (message.command === "recovery") return recovery(message);
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
