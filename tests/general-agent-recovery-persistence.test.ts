import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Agent } from "@agent-harness/core/agent-contract";
import type { AgentServices } from "@agent-harness/core/agent-factory";
import { createAgentApplication } from "@agent-harness/core/application/agent-application";
import type { AgentPlugin } from "@agent-harness/core/extensions/plugin-contract";
import type {
  ModelClientFactory,
  ModelMessage,
  ModelRequest,
  ModelResponse,
} from "@agent-harness/core/model/model-contract";
import type { Disposable, RunIdentity } from "@agent-harness/core/protocol-values";
import type {
  CheckpointAcquireResult,
  CheckpointLease,
  CheckpointStore,
} from "@agent-harness/core/session/checkpoint-contract";
import type {
  AgentCheckpoint,
  SessionHistoryAppendResult,
} from "@agent-harness/core/session/session-contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createSqliteAgentStores,
  type SqliteAgentStores,
} from "../cli/host/sqlite-agent-stores.js";

const key = { agentId: "agent", threadId: "thread", queryId: "query" };
const selection = { providerId: "test", modelId: "recovery" };
const input = (runId: string, queryId = key.queryId) => ({
  threadId: key.threadId,
  queryId,
  runId,
  input: [{ role: "user" as const, content: [{ type: "text" as const, text: "Write once" }] }],
});
const answer = (): ModelResponse => ({
  message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
  finishReason: "stop",
});
const toolCall = (): ModelResponse => ({
  message: {
    role: "assistant",
    content: [{ type: "tool-call", callId: "write-1", name: "recovery.write", input: {} }],
  },
  finishReason: "tool-calls",
});

function models(
  handler: (request: ModelRequest, signal: AbortSignal) => ModelResponse | Promise<ModelResponse>,
): ModelClientFactory {
  return {
    async create(selected) {
      const generate = async (request: ModelRequest, signal: AbortSignal) => {
        signal.throwIfAborted();
        return handler(request, signal);
      };
      return {
        client: {
          selection: selected,
          capabilities: { streaming: false, toolCalls: true, images: false, reasoning: false },
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

interface LedgerEntry extends RunIdentity {
  scenarioId: string;
  callId: string;
  phase: "execute" | "resume";
  interactionId?: string;
  pid: number;
  nonce: string;
}

function writer(path: string, waiting: boolean): AgentPlugin {
  const record = (
    identity: RunIdentity,
    callId: string,
    phase: LedgerEntry["phase"],
    interactionId?: string,
  ) => {
    const descriptor = openSync(path, "a");
    try {
      const entry: LedgerEntry = {
        ...identity,
        scenarioId: path,
        callId,
        phase,
        ...(interactionId ? { interactionId } : {}),
        pid: process.pid,
        nonce: randomUUID(),
      };
      writeSync(descriptor, `${JSON.stringify(entry)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  };
  return {
    id: "recovery",
    version: "1",
    setup(context) {
      const common = {
        name: "recovery.write",
        owner: "recovery",
        version: "1",
        description: "Append and sync a real effect ledger",
        inputSchema: z.object({}),
        outputSchema: z.object({ written: z.boolean() }),
        toModelContent: () => [{ type: "text" as const, text: "Written" }],
      };
      if (waiting) {
        context.tools.register({
          ...common,
          mode: "resumable",
          async execute(_value, execution) {
            record(execution.identity, execution.callId, "execute");
            return {
              status: "waiting",
              effects: "none",
              interaction: {
                id: `${execution.callId}:confirm`,
                owner: "recovery",
                payload: { type: "recovery.confirm", version: 1, data: {} },
              },
              continuation: { type: "recovery.write", version: 1, data: {} },
            };
          },
          async resume(_continuation, response, execution) {
            record(execution.identity, execution.callId, "resume", response.interactionId);
            return { status: "succeeded", effects: "applied", output: { written: true } };
          },
        });
      } else {
        context.tools.register({
          ...common,
          mode: "immediate",
          async execute(_value, execution) {
            record(execution.identity, execution.callId, "execute");
            return { status: "succeeded", effects: "applied", output: { written: true } };
          },
        });
      }
    },
  };
}

interface Receipt {
  batch_id: string;
  revision: number;
  payload: string;
}
interface Row {
  owner_id: string | null;
  generation: number;
  revision: number;
  payload: string | null;
}

// An independent read-only connection observes committed facts, never the writer's memory.
function authority(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT owner_id, generation, revision, payload FROM general_agent_checkpoints WHERE agent_id = ? AND thread_id = ? AND query_id = ?",
      )
      .get(key.agentId, key.threadId, key.queryId) as Row | undefined;
    const receipts = database
      .prepare(
        "SELECT batch_id, revision, payload FROM general_agent_history_batches WHERE thread_id = ? ORDER BY revision",
      )
      .all(key.threadId) as unknown as Receipt[];
    return {
      row,
      checkpoint: row?.payload ? (JSON.parse(row.payload) as AgentCheckpoint) : null,
      receipts,
    };
  } finally {
    database.close();
  }
}

type FaultMode = "B" | "R";
interface Fault {
  mode: FaultMode;
  runId: string;
  acquire?: boolean;
  batchId?: string;
  save?: (checkpoint: AgentCheckpoint) => boolean;
  hit: boolean;
  error: Error;
  acquired?: Extract<CheckpointAcquireResult, { status: "acquired" }>;
  saved?: { lease: CheckpointLease; revision: number; checkpoint: AgentCheckpoint };
  appended?: SessionHistoryAppendResult;
  attempted?: { revision: number; checkpoint: AgentCheckpoint };
}

function faultPorts(stores: SqliteAgentStores, fault?: Fault) {
  const checkpoints: CheckpointStore = {
    findUnfinished: (...args) => stores.checkpoints.findUnfinished(...args),
    release: (...args) => stores.checkpoints.release(...args),
    async acquire(...args) {
      const selected =
        fault &&
        !fault.hit &&
        fault.acquire &&
        args[0].queryId === key.queryId &&
        args[1] === fault.runId;
      if (selected) {
        fault.hit = true;
        if (fault.mode === "B") throw fault.error;
      }
      const result = await stores.checkpoints.acquire(...args);
      if (selected) {
        if (result.status === "acquired") fault.acquired = result;
        throw fault.error;
      }
      return result;
    },
    async save(lease, revision, checkpoint) {
      const selected =
        fault &&
        !fault.hit &&
        lease.key.queryId === key.queryId &&
        lease.ownerId === fault.runId &&
        fault.save?.(checkpoint);
      if (selected) {
        fault.hit = true;
        fault.attempted = { revision, checkpoint: structuredClone(checkpoint) };
        if (fault.mode === "B") throw fault.error;
      }
      const result = await stores.checkpoints.save(lease, revision, checkpoint);
      if (selected) {
        if (result.status === "saved")
          fault.saved = {
            lease,
            revision: result.revision,
            checkpoint: structuredClone(checkpoint),
          };
        throw fault.error;
      }
      return result;
    },
  };
  return {
    checkpoints,
    history: {
      read: (...args: Parameters<typeof stores.history.read>) => stores.history.read(...args),
      async append(...args: Parameters<typeof stores.history.append>) {
        const selected = fault && !fault.hit && args[3] === fault.batchId;
        if (selected) {
          fault.hit = true;
          if (fault.mode === "B") throw fault.error;
        }
        const result = await stores.history.append(...args);
        if (selected) {
          fault.appended = result;
          throw fault.error;
        }
        return result;
      },
    },
  };
}

function fault(mode: FaultMode, rest: Partial<Fault>): Fault {
  return {
    mode,
    runId: "run-fault",
    hit: false,
    error: new Error(`Injected ${mode} boundary`),
    ...rest,
  };
}

async function fixture(
  body: (context: {
    path: string;
    ledger: () => Promise<LedgerEntry[]>;
    open: (settings?: { fault?: Fault; waiting?: boolean; model?: ModelClientFactory }) => Promise<{
      stores: SqliteAgentStores;
      agent: Agent;
      close(): Promise<void>;
    }>;
    modelCalls: () => number;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "general-agent-recovery-persistence-"));
  const path = join(directory, "state.sqlite");
  const ledgerPath = join(directory, "effects.jsonl");
  const resources: Disposable[] = [];
  let calls = 0;
  try {
    await body({
      path,
      async ledger() {
        try {
          return (await readFile(ledgerPath, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as LedgerEntry);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      },
      modelCalls: () => calls,
      async open(settings = {}) {
        const stores = createSqliteAgentStores(path);
        const ports = faultPorts(stores, settings.fault);
        const services: AgentServices = {
          ...ports,
          models:
            settings.model ??
            models((request) => {
              calls += 1;
              return request.messages.some((message) => message.role === "tool")
                ? answer()
                : toolCall();
            }),
          authorizeTool: () => ({ type: "allow" }),
        };
        const application = createAgentApplication(services);
        let closed = false;
        const close = async () => {
          if (closed) return;
          closed = true;
          try {
            await application.dispose();
          } finally {
            await stores.dispose();
          }
        };
        resources.push({ dispose: close });
        const agent = await application.agents.create({
          agentId: key.agentId,
          definition: { id: "recovery", version: "1", instructions: "Write once" },
          model: selection,
          maxSteps: 4,
          plugins: [writer(ledgerPath, settings.waiting ?? false)],
        });
        return { stores, agent, close };
      },
    });
  } finally {
    try {
      for (const resource of resources.reverse()) await resource.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function leaseFrom(row: Row): CheckpointLease {
  if (!row.owner_id) throw new Error("Expected a persisted owner");
  return { key, ownerId: row.owner_id, generation: row.generation };
}

async function assertComplete(stores: SqliteAgentStores, path: string) {
  const history = await stores.history.read(key.threadId);
  expect(history.revision).toBe(3);
  expect(history.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
  const calls = history.messages.flatMap((message) =>
    message.content.filter((content) => content.type === "tool-call"),
  );
  const results = history.messages.flatMap((message) =>
    message.content.filter((content) => content.type === "tool-result"),
  );
  expect(calls).toMatchObject([{ callId: "write-1" }]);
  expect(results).toMatchObject([{ callId: "write-1", isError: false }]);
  const saved = authority(path);
  expect(saved.row?.owner_id).toBeNull();
  expect(saved.checkpoint).toMatchObject({
    status: "completed",
    committed: { historyRevision: 3, step: 2, messages: history.messages },
  });
  expect(saved.receipts.map((receipt) => [receipt.batch_id, receipt.revision])).toEqual([
    ["query:input", 1],
    ["query:step:1", 2],
    ["query:step:2", 3],
  ]);
}

const batches = [
  { batchId: "query:input", revision: 1, effects: 0 },
  { batchId: "query:step:1", revision: 2, effects: 1 },
  { batchId: "query:step:2", revision: 3, effects: 1 },
] as const;

describe("real SQLite same-process persistence recovery", () => {
  for (const boundary of ["append", "acknowledgement"] as const) {
    for (const mode of ["B", "R"] as const) {
      it.each(batches)(
        `${mode} ${boundary} for $batchId preserves receipts and authoritative progress`,
        async ({ batchId, revision, effects }) =>
          fixture(async (context) => {
            const injection = fault(mode, {
              ...(boundary === "append"
                ? { batchId }
                : {
                    save: (checkpoint: AgentCheckpoint) =>
                      checkpoint.committed.historyRevision === revision &&
                      !("inflight" in checkpoint) &&
                      checkpoint.status === (revision === 3 ? "completed" : "running"),
                  }),
            });
            const original = await context.open({ fault: injection });
            await expect(
              (await original.agent.run(input("run-fault"))).completed,
            ).rejects.toMatchObject({
              code: "PERSISTENCE_FAILED",
            });
            expect(injection.hit).toBe(true);
            const stopped = authority(context.path);
            expect(stopped.row?.owner_id).toBeNull();
            expect(await context.ledger()).toHaveLength(effects);
            const appendCommitted = boundary === "acknowledgement" || mode === "R";
            const acknowledgementCommitted = boundary === "acknowledgement" && mode === "R";
            expect(stopped.receipts).toHaveLength(appendCommitted ? revision : revision - 1);
            expect(stopped.checkpoint?.committed.historyRevision).toBe(
              acknowledgementCommitted ? revision : revision - 1,
            );
            if (acknowledgementCommitted) {
              expect(stopped.checkpoint).toEqual(injection.saved?.checkpoint);
              expect(stopped.row?.revision).toBe(injection.saved?.revision);
              expect(injection.saved?.lease).toEqual({ key, ownerId: "run-fault", generation: 1 });
            } else {
              expect(stopped.checkpoint).toMatchObject({
                status: "running",
                inflight: { type: "history", batchId },
              });
              if (boundary === "acknowledgement")
                expect(stopped.row?.revision).toBe(injection.attempted?.revision);
            }
            const targetReceipt = stopped.receipts.find((receipt) => receipt.batch_id === batchId);
            if (appendCommitted) expect(targetReceipt?.revision).toBe(revision);
            if (boundary === "append" && mode === "R")
              expect(injection.appended).toEqual({ status: "appended", revision });
            await original.close();
            const recovered = await context.open();
            if (acknowledgementCommitted && revision === 3) {
              const calls = context.modelCalls();
              await expect(
                (await recovered.agent.resume({ ...key, runId: "run-recovered" })).completed,
              ).rejects.toMatchObject({ code: "QUERY_TERMINAL" });
              expect(context.modelCalls()).toBe(calls);
              expect(authority(context.path).checkpoint).toEqual(stopped.checkpoint);
              expect(authority(context.path).row?.revision).toBe(stopped.row?.revision);
            } else {
              expect(
                (await (await recovered.agent.resume({ ...key, runId: "run-recovered" })).completed)
                  .status,
              ).toBe("completed");
            }
            await assertComplete(recovered.stores, context.path);
            expect(await context.ledger()).toMatchObject([
              { ...key, callId: "write-1", phase: "execute", pid: process.pid },
            ]);
            expect(context.modelCalls()).toBe(2);
            expect(authority(context.path).row?.generation).toBeGreaterThan(
              stopped.row?.generation ?? 0,
            );
            if (targetReceipt)
              expect(
                authority(context.path).receipts.find((receipt) => receipt.batch_id === batchId),
              ).toEqual(targetReceipt);
            // Same batch and payload returns its original receipt even against the final head.
            const receipts = authority(context.path).receipts;
            const originalIntent =
              stopped.checkpoint?.status === "running" &&
              stopped.checkpoint.inflight?.type === "history"
                ? stopped.checkpoint.inflight
                : undefined;
            if (originalIntent) {
              const reconciled = receipts.find(
                (receipt) => receipt.batch_id === originalIntent.batchId,
              );
              expect(reconciled?.revision).toBe(revision);
              expect(JSON.parse(reconciled!.payload)).toEqual(originalIntent.messages);
            }
            for (const receipt of receipts) {
              expect(
                await recovered.stores.history.append(
                  key.threadId,
                  receipt.revision - 1,
                  JSON.parse(receipt.payload) as ModelMessage[],
                  receipt.batch_id,
                ),
              ).toEqual({ status: "appended", revision: receipt.revision });
            }
            expect((await recovered.stores.history.read(key.threadId)).revision).toBe(3);
            expect(authority(context.path).receipts).toEqual(receipts);
          }),
      );
    }
  }

  it.each(["different-receipt", "invalid-prefix"] as const)(
    "rejects real %s divergence without silently repairing persisted history",
    async (divergence) =>
      fixture(async (context) => {
        const injection = fault("B", {
          ...(divergence === "different-receipt"
            ? { batchId: "query:input" }
            : {
                save: (checkpoint: AgentCheckpoint) =>
                  checkpoint.status === "running" && checkpoint.inflight?.type === "model",
              }),
        });
        const original = await context.open({ fault: injection });
        await expect(
          (await original.agent.run(input("run-fault"))).completed,
        ).rejects.toMatchObject({ code: "PERSISTENCE_FAILED" });
        expect(injection.hit).toBe(true);
        const stopped = authority(context.path);
        await original.close();
        const recovered = await context.open();
        const unexpected: ModelMessage[] = [
          { role: "user", content: [{ type: "text", text: "Different authoritative content" }] },
        ];
        expect(
          await recovered.stores.history.append(
            key.threadId,
            divergence === "different-receipt" ? 0 : 1,
            unexpected,
            divergence === "different-receipt" ? "query:input" : "another-query:input",
          ),
        ).toEqual({ status: "appended", revision: divergence === "different-receipt" ? 1 : 2 });
        const divergent = authority(context.path);
        const history = await recovered.stores.history.read(key.threadId);
        await expect(
          (await recovered.agent.resume({ ...key, runId: "reject-divergence" })).completed,
        ).rejects.toMatchObject({
          code: divergence === "different-receipt" ? "PERSISTENCE_FAILED" : "HISTORY_CONFLICT",
        });
        expect(authority(context.path).checkpoint).toEqual(stopped.checkpoint);
        expect(authority(context.path).row).toMatchObject({
          owner_id: null,
          revision: stopped.row?.revision,
          generation: (stopped.row?.generation ?? 0) + 1,
        });
        expect(authority(context.path).receipts).toEqual(divergent.receipts);
        expect(await recovered.stores.history.read(key.threadId)).toEqual(history);
        expect(context.modelCalls()).toBe(0);
        expect(await context.ledger()).toEqual([]);
      }),
  );

  for (const mode of ["B", "R"] as const) {
    it(`${mode} acquire of an empty key distinguishes no commit from an uninitialized placeholder`, async () =>
      fixture(async (context) => {
        const injection = fault(mode, { acquire: true });
        const original = await context.open({ fault: injection });
        await expect((await original.agent.run(input("run-fault"))).completed).rejects.toBe(
          injection.error,
        );
        expect(injection.hit).toBe(true);
        expect(context.modelCalls()).toBe(0);
        expect(await context.ledger()).toEqual([]);
        const stopped = authority(context.path);
        expect(stopped.checkpoint).toBeNull();
        expect(stopped.receipts).toEqual([]);
        expect(
          await original.stores.checkpoints.findUnfinished(key.agentId, key.threadId),
        ).toBeNull();
        if (mode === "B") expect(stopped.row).toBeUndefined();
        else {
          expect(stopped.row).toMatchObject({
            owner_id: "run-fault",
            generation: 1,
            revision: 0,
            payload: null,
          });
          expect(injection.acquired).toMatchObject({ currentRevision: 0, checkpoint: null });
        }
        // The failed activation and all its resources stop before trusted maintenance takes over.
        await original.close();
        const recovered = await context.open();
        if (mode === "R") {
          const old = leaseFrom(stopped.row!);
          expect(await recovered.stores.checkpoints.acquire(key, "observer")).toEqual({
            status: "busy",
            lease: old,
          });
          await expect(
            (await recovered.agent.run(input("blocked", "other"))).completed,
          ).rejects.toMatchObject({
            code: "THREAD_PENDING",
          });
          expect(authority(context.path)).toEqual(stopped);
          const maintenance = await recovered.stores.checkpoints.acquire(key, "maintenance", {
            replace: old,
          });
          expect(maintenance).toMatchObject({
            status: "acquired",
            currentRevision: 0,
            checkpoint: null,
          });
          if (maintenance.status !== "acquired")
            throw new Error("Expected exact placeholder takeover");
          expect(maintenance.lease.generation).toBe(old.generation + 1);
          await recovered.stores.checkpoints.release(maintenance.lease);
          expect(authority(context.path).row).toMatchObject({
            owner_id: null,
            generation: 2,
            revision: 0,
            payload: null,
          });
          // A missing checkpoint cannot reconstruct the input and is not resumable.
          await expect(
            (await recovered.agent.resume({ ...key, runId: "not-a-checkpoint" })).completed,
          ).rejects.toMatchObject({ code: "QUERY_NOT_FOUND" });
          expect(authority(context.path).row).toMatchObject({
            owner_id: null,
            generation: 3,
            revision: 0,
          });
          expect(context.modelCalls()).toBe(0);
          expect(await context.ledger()).toEqual([]);
        }
        // The caller still owns the original input and explicitly resubmits it, not a snapshot.
        expect(
          (await (await recovered.agent.run(input("explicit-resubmission"))).completed).status,
        ).toBe("completed");
        await assertComplete(recovered.stores, context.path);
        expect(authority(context.path).row?.generation).toBe(mode === "R" ? 4 : 1);
        expect(await context.ledger()).toHaveLength(1);
      }));

    for (const state of ["waiting", "running"] as const) {
      it(`${mode} acquire of existing ${state} preserves the checkpoint until explicit recovery`, async () =>
        fixture(async (context) => {
          const preparation =
            state === "running"
              ? fault("B", {
                  runId: "prepare",
                  save: (checkpoint) =>
                    checkpoint.status === "running" && checkpoint.inflight?.type === "model",
                })
              : undefined;
          const initial = await context.open({ waiting: state === "waiting", fault: preparation });
          const prepared = (await initial.agent.run(input("prepare"))).completed;
          if (state === "waiting") expect((await prepared).status).toBe("waiting");
          else await expect(prepared).rejects.toMatchObject({ code: "PERSISTENCE_FAILED" });
          const before = authority(context.path);
          expect(before.checkpoint?.status).toBe(state);
          await initial.close();
          const injection = fault(mode, { acquire: true });
          const original = await context.open({ waiting: state === "waiting", fault: injection });
          const effects = await context.ledger();
          const calls = context.modelCalls();
          const response =
            state === "waiting"
              ? { type: "answer" as const, interactionId: "write-1:confirm", value: true }
              : undefined;
          await expect(
            (
              await original.agent.resume({
                ...key,
                runId: "run-fault",
                ...(response ? { response } : {}),
              })
            ).completed,
          ).rejects.toBe(injection.error);
          expect(injection.hit).toBe(true);
          expect(context.modelCalls()).toBe(calls);
          expect(await context.ledger()).toEqual(effects);
          const stopped = authority(context.path);
          expect(stopped.checkpoint).toEqual(before.checkpoint);
          expect(stopped.receipts).toEqual(before.receipts);
          expect(stopped.row?.revision).toBe(before.row?.revision);
          expect(stopped.row?.generation).toBe(
            (before.row?.generation ?? 0) + (mode === "R" ? 1 : 0),
          );
          if (mode === "B") expect(stopped.row?.owner_id).toBeNull();
          else expect(injection.acquired?.checkpoint).toEqual(before.checkpoint);
          await original.close();
          const recovered = await context.open({ waiting: state === "waiting" });
          let takeover: CheckpointLease | undefined;
          if (mode === "R") {
            takeover = leaseFrom(stopped.row!);
            expect(await recovered.stores.checkpoints.acquire(key, "observer")).toEqual({
              status: "busy",
              lease: takeover,
            });
            await expect(
              (
                await recovered.agent.resume({
                  ...key,
                  runId: "without-takeover",
                  ...(response ? { response } : {}),
                })
              ).completed,
            ).rejects.toMatchObject({ code: "WRITER_BUSY" });
            await expect(
              (await recovered.agent.run(input("other-run", "other-query"))).completed,
            ).rejects.toMatchObject({ code: "THREAD_PENDING" });
            expect(context.modelCalls()).toBe(calls);
            expect(await context.ledger()).toEqual(effects);
          }
          expect(
            (
              await (
                await recovered.agent.resume({
                  ...key,
                  runId: "recovered",
                  ...(takeover ? { takeover } : {}),
                  ...(response ? { response } : {}),
                })
              ).completed
            ).status,
          ).toBe("completed");
          await assertComplete(recovered.stores, context.path);
          expect(authority(context.path).row?.generation).toBe((stopped.row?.generation ?? 0) + 1);
          const ledger = await context.ledger();
          expect(ledger.map((entry) => entry.phase)).toEqual(
            state === "waiting" ? ["execute", "resume"] : ["execute"],
          );
          expect(ledger.at(-1)).toMatchObject({ ...key, runId: "recovered", callId: "write-1" });
          expect(context.modelCalls()).toBe(2);
        }));
    }
  }

  it.each(["completed", "failed", "cancelled"] as const)(
    "R %s checkpoint remains terminal despite lost confirmation and a later acquire acknowledgement loss",
    async (status) =>
      fixture(async (context) => {
        const cancellation = new AbortController();
        let calls = 0;
        const model = models((_request, signal) => {
          calls += 1;
          if (status === "failed") throw new Error("Provider failure");
          if (status === "cancelled") {
            cancellation.abort();
            signal.throwIfAborted();
          }
          return answer();
        });
        const injection = fault("R", { save: (checkpoint) => checkpoint.status === status });
        const original = await context.open({ fault: injection, model });
        await expect(
          (await original.agent.run({ ...input("run-fault"), signal: cancellation.signal }))
            .completed,
        ).rejects.toMatchObject({ code: "PERSISTENCE_FAILED" });
        expect(injection.hit).toBe(true);
        const terminal = authority(context.path);
        expect(terminal.checkpoint?.status).toBe(status);
        expect(terminal.checkpoint).toEqual(injection.saved?.checkpoint);
        expect(terminal.row).toMatchObject({ owner_id: null, revision: injection.saved?.revision });
        expect(terminal.receipts).toHaveLength(status === "completed" ? 2 : 1);
        expect(calls).toBe(1);
        expect(await context.ledger()).toEqual([]);
        await original.close();
        const acquireLoss = fault("R", { acquire: true });
        const lost = await context.open({ fault: acquireLoss, model });
        await expect(
          (await lost.agent.resume({ ...key, runId: "run-fault" })).completed,
        ).rejects.toBe(acquireLoss.error);
        expect(acquireLoss.acquired?.checkpoint).toEqual(terminal.checkpoint);
        await lost.close();
        const recovered = await context.open({ model });
        const residual = authority(context.path);
        const old = leaseFrom(residual.row!);
        expect(await recovered.stores.checkpoints.acquire(key, "observer")).toEqual({
          status: "busy",
          lease: old,
        });
        const maintenance = await recovered.stores.checkpoints.acquire(
          key,
          "terminal-maintenance",
          { replace: old },
        );
        if (maintenance.status !== "acquired") throw new Error("Expected terminal lease cleanup");
        expect(maintenance.checkpoint).toEqual(terminal.checkpoint);
        expect(maintenance.currentRevision).toBe(terminal.row?.revision);
        expect(maintenance.lease.generation).toBe(old.generation + 1);
        await recovered.stores.checkpoints.release(maintenance.lease);
        await expect(
          (await recovered.agent.run(input("duplicate"))).completed,
        ).rejects.toMatchObject({ code: "QUERY_EXISTS" });
        await expect(
          (await recovered.agent.resume({ ...key, runId: "resume-terminal" })).completed,
        ).rejects.toMatchObject({ code: "QUERY_TERMINAL" });
        const after = authority(context.path);
        expect(after.checkpoint).toEqual(terminal.checkpoint);
        expect(after.receipts).toEqual(terminal.receipts);
        expect(after.row).toMatchObject({
          owner_id: null,
          revision: terminal.row?.revision,
          generation: old.generation + 3,
        });
        expect(calls).toBe(1);
        expect(await context.ledger()).toEqual([]);
      }),
  );

  it("fences a stopped writer's save, release and replace after a new generation has saved", async () =>
    fixture(async (context) => {
      const injection = fault("B", {
        save: (checkpoint) =>
          checkpoint.status === "running" && checkpoint.inflight?.type === "model",
      });
      const original = await context.open({ fault: injection });
      await expect((await original.agent.run(input("run-fault"))).completed).rejects.toMatchObject({
        code: "PERSISTENCE_FAILED",
      });
      await original.close();
      const oldWriter = await context.open();
      const old = await oldWriter.stores.checkpoints.acquire(key, "stopped-writer");
      if (old.status !== "acquired" || !old.checkpoint)
        throw new Error("Expected running checkpoint");
      const oldLease = old.lease;
      const oldCheckpoint = old.checkpoint;
      const oldRevision = old.currentRevision;
      await oldWriter.close();
      const recovered = await context.open();
      expect(await recovered.stores.checkpoints.acquire(key, "observer")).toEqual({
        status: "busy",
        lease: oldLease,
      });
      const replacement = await recovered.stores.checkpoints.acquire(key, "new-writer", {
        replace: oldLease,
      });
      if (replacement.status !== "acquired" || !replacement.checkpoint)
        throw new Error("Expected exact takeover");
      expect(replacement.lease.generation).toBe(oldLease.generation + 1);
      const next = { ...replacement.checkpoint, lastRunId: "new-writer" };
      expect(
        await recovered.stores.checkpoints.save(
          replacement.lease,
          replacement.currentRevision,
          next,
        ),
      ).toEqual({ status: "saved", revision: oldRevision + 1 });
      const authoritative = authority(context.path);
      const delayed = await context.open();
      expect(await delayed.stores.checkpoints.save(oldLease, oldRevision, oldCheckpoint)).toEqual({
        status: "stale",
      });
      expect(
        await delayed.stores.checkpoints.save(oldLease, oldRevision + 1, oldCheckpoint),
      ).toEqual({ status: "stale" });
      await delayed.stores.checkpoints.release(oldLease);
      expect(
        await delayed.stores.checkpoints.acquire(key, "obsolete-takeover", { replace: oldLease }),
      ).toEqual({ status: "stale" });
      expect(await delayed.stores.checkpoints.acquire(key, "observer")).toEqual({
        status: "busy",
        lease: replacement.lease,
      });
      expect(authority(context.path)).toEqual(authoritative);
      await recovered.stores.checkpoints.release(replacement.lease);
      const released = authority(context.path);
      expect(
        await delayed.stores.checkpoints.acquire(key, "obsolete-after-release", {
          replace: oldLease,
        }),
      ).toEqual({ status: "stale" });
      expect(authority(context.path)).toEqual(released);
      expect(
        (await (await recovered.agent.resume({ ...key, runId: "final-recovery" })).completed)
          .status,
      ).toBe("completed");
      await assertComplete(recovered.stores, context.path);
      expect(authority(context.path).row?.generation).toBe(replacement.lease.generation + 1);
      expect(await context.ledger()).toHaveLength(1);
    }));
});
