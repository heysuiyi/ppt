import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentRunHandle } from "@agent-harness/core/agent-contract";
import { createAgentApplication } from "@agent-harness/core/application/agent-application";
import type { AgentPlugin } from "@agent-harness/core/extensions/plugin-contract";
import type {
  ModelClientFactory,
  ModelRequest,
  ModelResponse,
} from "@agent-harness/core/model/model-contract";
import type { Disposable, RunIdentity } from "@agent-harness/core/protocol-values";
import type { CheckpointStore } from "@agent-harness/core/session/checkpoint-contract";
import type {
  AgentCheckpoint,
  StoredToolInvocation,
} from "@agent-harness/core/session/session-contract";
import type { RuntimeEvent } from "@agent-harness/core/session/session-events";
import type { ToolCompletion, ToolResult } from "@agent-harness/core/tools/tool-contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSqliteAgentStores } from "../cli/host/sqlite-agent-stores.js";

const key = { agentId: "agent", threadId: "thread", queryId: "query" };
const selection = { providerId: "test", modelId: "recovery-model" };
const callId = "write-1";
const interactionId = `${callId}:confirm`;
const response = { type: "answer" as const, interactionId, value: true };
const originalRun = "initial-run";
const faultRun = "fault-run";
const recoveryRun = "recovery-run";

type Window = "dispatch" | "execute-completion" | "consumption" | "resume-completion";
type Fault = "B" | "R";
type WaitingEffects = "none" | "applied";
type Outcome = "succeeded" | "failed" | "unknown";
interface Scenario {
  readonly window: Window;
  readonly fault: Fault;
  readonly waitingEffects: WaitingEffects;
  readonly outcome: Outcome;
}
interface LedgerEntry extends RunIdentity {
  readonly scenarioId: string;
  readonly callId: string;
  readonly phase: "execute" | "resume";
  readonly interactionId?: string;
  readonly pid: number;
  readonly nonce: string;
}

const scenarios: Scenario[] = [];
for (const fault of ["B", "R"] as const) {
  scenarios.push({ window: "dispatch", fault, waitingEffects: "none", outcome: "succeeded" });
  // 提交前丢失的完成结果一律不可恢复；只在持久完成分支区分原 status。
  const outcomes: readonly Outcome[] =
    fault === "B" ? ["succeeded"] : ["succeeded", "failed", "unknown"];
  for (const outcome of outcomes) {
    scenarios.push({ window: "execute-completion", fault, waitingEffects: "none", outcome });
  }
  for (const waitingEffects of ["none", "applied"] as const) {
    scenarios.push({ window: "consumption", fault, waitingEffects, outcome: "succeeded" });
    for (const outcome of outcomes) {
      scenarios.push({ window: "resume-completion", fault, waitingEffects, outcome });
    }
  }
}

function toolResult(scenario: Scenario): ToolResult<{ bytes: number }> {
  if (scenario.outcome === "succeeded") {
    return { status: "succeeded", output: { bytes: 19 }, effects: "applied" };
  }
  return {
    status: scenario.outcome,
    effects:
      scenario.outcome === "failed" || scenario.waitingEffects === "applied"
        ? "applied"
        : "unknown",
    error: { code: "ORIGINAL_OUTCOME", message: `Original ${scenario.outcome} completion` },
  };
}

function modelContent(result: ToolResult) {
  return [{ type: "text" as const, text: `Original ${result.status}/${result.effects}` }];
}

function capability(ledger: string, scenarioId: string, scenario: Scenario): AgentPlugin {
  const record = (
    identity: RunIdentity,
    phase: LedgerEntry["phase"],
    invocationId: string,
    answeredInteraction?: string,
  ) => {
    const descriptor = openSync(ledger, "a");
    try {
      const entry: LedgerEntry = {
        scenarioId,
        ...identity,
        callId: invocationId,
        phase,
        ...(answeredInteraction ? { interactionId: answeredInteraction } : {}),
        pid: process.pid,
        nonce: randomUUID(),
      };
      appendFileSync(descriptor, `${JSON.stringify(entry)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  };
  return {
    id: "documents",
    version: "1",
    setup(context) {
      const common = {
        name: "documents.write",
        owner: "documents",
        version: "1",
        description: "Append a real, non-deduplicating synchronized effect ledger",
        inputSchema: z.object({ content: z.string() }),
        outputSchema: z.object({ bytes: z.number() }),
        toModelContent: modelContent,
      };
      if (scenario.window === "dispatch" || scenario.window === "execute-completion") {
        context.tools.register({
          ...common,
          mode: "immediate",
          async execute(_value, execution) {
            record(execution.identity, "execute", execution.callId);
            return toolResult(scenario);
          },
        });
      } else {
        context.tools.register({
          ...common,
          mode: "resumable",
          async execute(value, execution) {
            record(execution.identity, "execute", execution.callId);
            return {
              status: "waiting",
              effects: scenario.waitingEffects,
              interaction: {
                id: interactionId,
                owner: "documents",
                payload: { type: "documents.confirm", version: 1, data: {} },
              },
              continuation: {
                type: "documents.write",
                version: 1,
                data: { content: value.content },
              },
            };
          },
          async resume(continuation, answered, execution) {
            z.object({ content: z.string() }).parse(continuation.data);
            expect(answered).toEqual(response);
            record(execution.identity, "resume", execution.callId, answered.interactionId);
            return toolResult(scenario);
          },
        });
      }
    },
  };
}

function models(handler: (request: ModelRequest) => ModelResponse): ModelClientFactory {
  return {
    async create(modelSelection) {
      const generate = async (request: ModelRequest, signal: AbortSignal) => {
        signal.throwIfAborted();
        return handler(request);
      };
      return {
        client: {
          selection: modelSelection,
          capabilities: { streaming: false, toolCalls: true, images: false, reasoning: true },
          generate,
          async *stream(request, signal) {
            yield { type: "completed" as const, response: await generate(request, signal) };
          },
        },
        async dispose() {},
      };
    },
  };
}

function call(): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          callId,
          name: "documents.write",
          input: { content: "persistent document" },
        },
      ],
      replayState: {
        providerId: selection.providerId,
        modelId: selection.modelId,
        format: "signed",
        version: 1,
        data: { signature: "durable-tool-turn" },
      },
    },
    finishReason: "tool-calls",
  };
}

// This independent read-only connection never shares the writer's in-memory checkpoint.
function checkpointRow(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT owner_id, generation, revision, payload FROM general_agent_checkpoints WHERE agent_id = ? AND thread_id = ? AND query_id = ?",
      )
      .get(key.agentId, key.threadId, key.queryId) as {
      owner_id: string | null;
      generation: number;
      revision: number;
      payload: string;
    };
    return { ...row, checkpoint: JSON.parse(row.payload) as AgentCheckpoint };
  } finally {
    database.close();
  }
}

function matchesInvocation(invocation: StoredToolInvocation, runId: string): boolean {
  return (
    invocation.identity.agentId === key.agentId &&
    invocation.identity.threadId === key.threadId &&
    invocation.identity.queryId === key.queryId &&
    invocation.identity.runId === runId &&
    invocation.call.callId === callId
  );
}

function selectsFault(checkpoint: AgentCheckpoint, scenario: Scenario): boolean {
  if (
    checkpoint.agentId !== key.agentId ||
    checkpoint.threadId !== key.threadId ||
    checkpoint.queryId !== key.queryId ||
    checkpoint.lastRunId !== faultRun ||
    checkpoint.status !== "running"
  ) {
    return false;
  }
  const inflight = checkpoint.inflight;
  if (scenario.window === "consumption") {
    return (
      inflight?.type === "resume" &&
      matchesInvocation(inflight.pending.invocation, originalRun) &&
      inflight.pending.interaction.id === interactionId &&
      inflight.response.interactionId === interactionId
    );
  }
  if (inflight?.type !== "tools") return false;
  if (scenario.window === "dispatch") {
    return inflight.remaining.some(
      (invocation) => matchesInvocation(invocation, faultRun) && invocation.state === "dispatched",
    );
  }
  return inflight.completed.some((item) =>
    matchesInvocation(
      item.invocation,
      scenario.window === "resume-completion" ? originalRun : faultRun,
    ),
  );
}

function wrapCheckpoints(
  store: CheckpointStore,
  hooks: {
    acquire?: (checkpoint: AgentCheckpoint | null, runId: string) => void;
    save?: (checkpoint: AgentCheckpoint) => Promise<void>;
    fault?: Scenario;
    hit?: () => void;
  },
): CheckpointStore {
  let armed = hooks.fault !== undefined;
  return {
    findUnfinished: (...args) => store.findUnfinished(...args),
    release: (...args) => store.release(...args),
    async acquire(...args) {
      const acquired = await store.acquire(...args);
      if (acquired.status === "acquired") hooks.acquire?.(acquired.checkpoint, args[1]);
      return acquired;
    },
    async save(lease, revision, checkpoint) {
      const fault = armed && hooks.fault && selectsFault(checkpoint, hooks.fault);
      if (fault) {
        armed = false;
        hooks.hit?.();
        if (hooks.fault?.fault === "B") throw new Error("D1 rejected before delegation");
      }
      const saved = await store.save(lease, revision, checkpoint);
      if (fault) {
        expect(saved.status).toBe("saved");
        throw new Error("D1 rejected after committed save");
      }
      if (saved.status === "saved") await hooks.save?.(checkpoint);
      return saved;
    },
  };
}

async function events(handle: AgentRunHandle): Promise<RuntimeEvent[]> {
  const observed: RuntimeEvent[] = [];
  for await (const event of handle.events) observed.push(event);
  return observed;
}

async function ledgerEntries(path: string): Promise<LedgerEntry[]> {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function runScenario(scenario: Scenario): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "general-agent-recovery-effects-"));
  const db = join(directory, "state.sqlite");
  const ledger = join(directory, "effects.jsonl");
  const scenarioId = `${scenario.window}:${scenario.fault}:${scenario.waitingEffects}:${scenario.outcome}`;
  const resources: Disposable[] = [];
  const own = <T extends Disposable>(resource: T): T => {
    resources.push(resource);
    return resource;
  };
  const open = async (
    handler: (request: ModelRequest) => ModelResponse,
    hooks: Parameters<typeof wrapCheckpoints>[1] = {},
  ) => {
    const stores = own(createSqliteAgentStores(db));
    const application = own(
      createAgentApplication({
        models: models(handler),
        history: stores.history,
        checkpoints: wrapCheckpoints(stores.checkpoints, hooks),
        authorizeTool: () => ({ type: "allow" }),
      }),
    );
    const agent = own(
      await application.agents.create({
        agentId: key.agentId,
        definition: { id: "documents", version: "1", instructions: "Use the document tool." },
        model: selection,
        maxSteps: 4,
        plugins: [capability(ledger, scenarioId, scenario)],
      }),
    );
    return {
      stores,
      agent,
      async close() {
        await agent.dispose();
        await application.dispose();
        await stores.dispose();
      },
    };
  };
  const runInput = (runId: string) => ({
    threadId: key.threadId,
    queryId: key.queryId,
    runId,
    input: [
      { role: "user" as const, content: [{ type: "text" as const, text: "Write a document" }] },
    ],
  });
  try {
    let hits = 0;
    let initialModels = 0;
    const first = await open(
      () => {
        initialModels += 1;
        return call();
      },
      {
        fault: scenario,
        hit: () => {
          hits += 1;
        },
      },
    );
    const resumable = scenario.window === "consumption" || scenario.window === "resume-completion";
    if (resumable) {
      const waiting = await (await first.agent.run(runInput(originalRun))).completed;
      expect(waiting).toMatchObject({
        status: "waiting",
        identity: { ...key, runId: originalRun },
        interaction: { id: interactionId },
      });
      expect(checkpointRow(db)).toMatchObject({
        owner_id: null,
        checkpoint: {
          status: "waiting",
          pending: { interaction: { id: interactionId }, effects: scenario.waitingEffects },
        },
      });
    }
    const failing = resumable
      ? await first.agent.resume({ ...key, runId: faultRun, response })
      : await first.agent.run(runInput(faultRun));
    await expect(failing.completed).rejects.toMatchObject({ code: "PERSISTENCE_FAILED" });
    expect(hits).toBe(1);
    expect(initialModels).toBe(1);
    await first.close();

    const before = checkpointRow(db);
    expect(before.owner_id).toBeNull();
    const original = toolResult(scenario);
    const originalCompletion = { ...original, modelContent: modelContent(original) };
    if (scenario.window === "dispatch") {
      expect(before.checkpoint).toMatchObject({
        status: "running",
        inflight: {
          type: "tools",
          remaining: [
            { call: { callId }, state: scenario.fault === "B" ? "pending" : "dispatched" },
          ],
          completed: [],
        },
      });
    } else if (scenario.window === "consumption" && scenario.fault === "B") {
      expect(before.checkpoint).toMatchObject({
        status: "waiting",
        pending: { effects: scenario.waitingEffects, interaction: { id: interactionId } },
      });
    } else if (
      scenario.window === "consumption" ||
      (scenario.window === "resume-completion" && scenario.fault === "B")
    ) {
      expect(before.checkpoint).toMatchObject({
        status: "running",
        inflight: {
          type: "resume",
          pending: { effects: scenario.waitingEffects, interaction: { id: interactionId } },
          response,
        },
      });
    } else if (scenario.fault === "B") {
      expect(before.checkpoint).toMatchObject({
        status: "running",
        inflight: { type: "tools", remaining: [{ state: "dispatched" }], completed: [] },
      });
    } else {
      expect(before.checkpoint).toMatchObject({
        status: "running",
        inflight: { type: "tools", remaining: [], completed: [{ completion: originalCompletion }] },
      });
    }
    const beforeLedger = await ledgerEntries(ledger);
    expect(beforeLedger.filter((entry) => entry.phase === "execute")).toHaveLength(
      scenario.window === "dispatch" ? 0 : 1,
    );
    expect(beforeLedger.filter((entry) => entry.phase === "resume")).toHaveLength(
      scenario.window === "resume-completion" ? 1 : 0,
    );

    let recoveredCheckpoint: AgentCheckpoint | null = null;
    const durableUnknown: ToolCompletion[] = [];
    let recoveryModels = 0;
    const recovery = await open(
      (request) => {
        recoveryModels += 1;
        expect(request.messages.map((message) => message.role)).toEqual([
          "system",
          "user",
          "assistant",
          "tool",
        ]);
        return {
          message: { role: "assistant", content: [{ type: "text", text: "Recovery complete" }] },
          finishReason: "stop",
        };
      },
      {
        acquire(checkpoint, runId) {
          if (runId === recoveryRun) recoveredCheckpoint = checkpoint;
        },
        async save(checkpoint) {
          if (checkpoint.status !== "running" || checkpoint.inflight?.type !== "tools") return;
          const unknown = checkpoint.inflight.completed.find(
            (item) =>
              item.completion.status === "unknown" &&
              item.completion.error.code === "TOOL_OUTCOME_UNKNOWN",
          );
          if (!unknown) return;
          // Observe the authoritative completion before the history intent can replace it.
          const authoritative = checkpointRow(db).checkpoint;
          expect(authoritative).toEqual(checkpoint);
          if (authoritative.status === "running" && authoritative.inflight?.type === "tools") {
            const completion = authoritative.inflight.completed.find(
              (item) => item.invocation.call.callId === callId,
            );
            if (!completion) throw new Error("Expected authoritative unknown completion");
            durableUnknown.push(completion.completion);
          }
        },
      },
    );
    if (resumable && !(scenario.window === "consumption" && scenario.fault === "B")) {
      const stale = await recovery.agent.resume({ ...key, runId: "stale-answer-run", response });
      await expect(stale.completed).rejects.toMatchObject({ code: "STALE_INTERACTION" });
      expect(checkpointRow(db).checkpoint).toEqual(before.checkpoint);
      expect(checkpointRow(db).revision).toBe(before.revision);
      expect(await ledgerEntries(ledger)).toEqual(beforeLedger);
      expect(recoveryModels).toBe(0);
    }
    const handle = await recovery.agent.resume({
      ...key,
      runId: recoveryRun,
      ...(scenario.window === "consumption" && scenario.fault === "B" ? { response } : {}),
    });
    const observed = events(handle);
    expect(await handle.completed).toMatchObject({
      status: "completed",
      identity: { ...key, runId: recoveryRun },
    });
    expect(recoveredCheckpoint).toEqual(before.checkpoint);
    expect(recoveryModels).toBe(1);
    const completionEvents = (await observed).filter((event) => event.type === "tool.completed");
    const generatesUnknown =
      (scenario.window === "dispatch" && scenario.fault === "R") ||
      (scenario.window === "execute-completion" && scenario.fault === "B") ||
      (scenario.window === "consumption" && scenario.fault === "R") ||
      (scenario.window === "resume-completion" && scenario.fault === "B");
    const expectedCompletion = generatesUnknown
      ? {
          status: "unknown",
          effects: resumable && scenario.waitingEffects === "applied" ? "applied" : "unknown",
          error: { code: "TOOL_OUTCOME_UNKNOWN" },
        }
      : originalCompletion;
    if (generatesUnknown) {
      expect(durableUnknown).toHaveLength(1);
      expect(durableUnknown[0]).toMatchObject(expectedCompletion);
      expect(completionEvents).toHaveLength(1);
      expect(completionEvents[0]).toMatchObject({
        identity: { ...key, runId: recoveryRun },
        invocation: { call: { callId } },
        completion: expectedCompletion,
      });
    } else {
      expect(durableUnknown).toEqual([]);
      // Committed completions need not be re-emitted: events are not a durable log.
      for (const event of completionEvents) expect(event.completion).toEqual(originalCompletion);
      if (scenario.fault === "R") {
        expect(recoveredCheckpoint).toMatchObject({
          inflight: { type: "tools", completed: [{ completion: originalCompletion }] },
        });
      } else {
        expect(completionEvents).toHaveLength(1);
      }
    }
    await recovery.close();

    // Reopen again so the final evidence does not depend on either Application's stores.
    const verification = own(createSqliteAgentStores(db));
    const history = await verification.history.read(key.threadId);
    expect(history.revision).toBe(3);
    expect(history.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(history.messages[1]).toEqual(call().message);
    const calls = history.messages.flatMap((message) =>
      message.content.filter((part) => part.type === "tool-call"),
    );
    const results = history.messages.flatMap((message) =>
      message.content.filter((part) => part.type === "tool-result"),
    );
    expect(calls.map((part) => part.callId)).toEqual([callId]);
    expect(results.map((part) => part.callId)).toEqual([callId]);
    expect(results[0]).toMatchObject({
      isError: expectedCompletion.status !== "succeeded",
      content: generatesUnknown
        ? [{ type: "text", text: expect.stringContaining("unknown") }]
        : originalCompletion.modelContent,
    });
    const afterLedger = await ledgerEntries(ledger);
    const expectedExecute = scenario.window === "dispatch" && scenario.fault === "R" ? 0 : 1;
    const expectedResume =
      scenario.window === "resume-completion" ||
      (scenario.window === "consumption" && scenario.fault === "B")
        ? 1
        : 0;
    expect(afterLedger.filter((entry) => entry.phase === "execute")).toHaveLength(expectedExecute);
    expect(afterLedger.filter((entry) => entry.phase === "resume")).toHaveLength(expectedResume);
    expect(afterLedger.slice(0, beforeLedger.length)).toEqual(beforeLedger);
    expect(new Set(afterLedger.map((entry) => entry.nonce)).size).toBe(afterLedger.length);
    for (const entry of afterLedger) {
      expect(entry).toMatchObject({
        ...key,
        scenarioId,
        callId,
        pid: process.pid,
        nonce: expect.any(String),
      });
      expect(entry.runId).toBe(
        entry.phase === "execute"
          ? resumable
            ? originalRun
            : scenario.window === "dispatch"
              ? recoveryRun
              : faultRun
          : scenario.window === "consumption"
            ? recoveryRun
            : faultRun,
      );
      if (entry.phase === "resume") expect(entry.interactionId).toBe(interactionId);
    }
    const after = checkpointRow(db);
    expect(after).toMatchObject({
      owner_id: null,
      checkpoint: {
        status: "completed",
        lastRunId: recoveryRun,
        committed: { historyRevision: 3, step: 2, messages: history.messages },
      },
    });
    expect(after.generation).toBeGreaterThan(before.generation);
    expect(await verification.checkpoints.findUnfinished(key.agentId, key.threadId)).toBeNull();
  } finally {
    try {
      for (const resource of resources.reverse()) await resource.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

describe("D1 B/R recovery with real synchronized effects and reopened Applications", () => {
  it.each(scenarios)(
    "$window $fault waiting.effects=$waitingEffects original.status=$outcome",
    runScenario,
  );
});
