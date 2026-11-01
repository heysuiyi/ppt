import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync } from "node:fs";
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
  ModelRequest,
  ModelResponse,
} from "@agent-harness/core/model/model-contract";
import type { InteractionRequest, InteractionResponse } from "@agent-harness/core/protocol-values";
import type { CheckpointStore } from "@agent-harness/core/session/checkpoint-contract";
import type { AgentCheckpoint } from "@agent-harness/core/session/session-contract";
import type {
  ToolAuthorizationPolicy,
  ToolExecutionContext,
  ToolSideEffects,
} from "@agent-harness/core/tools/tool-contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createSqliteAgentStores,
  type SqliteAgentStores,
} from "../cli/host/sqlite-agent-stores.js";

const selection = { providerId: "test", modelId: "recovery-policy" };
const key = { agentId: "agent", threadId: "thread", queryId: "query" };
const initialInput = {
  threadId: key.threadId,
  queryId: key.queryId,
  runId: "initial",
  input: [{ role: "user" as const, content: [{ type: "text" as const, text: "Write a file" }] }],
};
const approval: InteractionRequest = {
  id: "host-approval",
  owner: "host",
  payload: { type: "write.approval", version: 1, data: { scope: "original" } },
};
const allow: ToolAuthorizationPolicy = () => ({ type: "allow" });
const approve: ToolAuthorizationPolicy = () => ({ type: "approval", interaction: approval });
const affirmative = (interactionId: string): InteractionResponse => ({
  type: "answer",
  interactionId,
  value: true,
});
const finalAnswer = (): ModelResponse => ({
  message: { role: "assistant", content: [{ type: "text", text: "Outcome recorded" }] },
  finishReason: "stop",
});
const toolCall = (number = 1): ModelResponse => ({
  message: {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        callId: `write-${number}`,
        name: "files.write",
        input: { content: "document" },
      },
    ],
  },
  finishReason: "tool-calls",
});

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

function appendSynced(path: string, value: string): void {
  const descriptor = openSync(path, "a");
  try {
    appendFileSync(descriptor, value, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

type Change = "owner" | "schema" | "continuation";
type LedgerEntry = {
  phase: "execute" | "resume";
  agentId: string;
  threadId: string;
  queryId: string;
  runId: string;
  callId: string;
  interactionId?: string;
  pid: number;
  nonce: string;
};

function fileCapability(
  directory: string,
  effects: "none" | "applied",
  change?: Change,
): AgentPlugin {
  const record = (
    phase: LedgerEntry["phase"],
    context: ToolExecutionContext,
    interactionId?: string,
  ) => {
    appendSynced(
      join(directory, "ledger.jsonl"),
      `${JSON.stringify({
        ...context.identity,
        phase,
        callId: context.callId,
        interactionId,
        pid: process.pid,
        nonce: randomUUID(),
      })}\n`,
    );
  };
  return {
    id: "files",
    version: "1",
    setup(context) {
      context.tools.register({
        name: "files.write",
        version: "1",
        owner: change === "owner" ? "replacement-owner" : "files",
        description: "Write a durable file, then wait for confirmation",
        mode: "resumable",
        inputSchema:
          change === "schema"
            ? z.object({ content: z.string(), replacement: z.string().optional() })
            : z.object({ content: z.string() }),
        outputSchema: z.object({ written: z.boolean() }),
        toModelContent: (result) => [
          {
            type: "text",
            text: result.status === "succeeded" ? "File written" : result.error.code,
          },
        ],
        async execute(value, execution) {
          record("execute", execution);
          if (effects === "applied")
            appendSynced(join(directory, "document.txt"), `${value.content}:execute\n`);
          return {
            status: "waiting",
            effects,
            interaction: {
              id: `${execution.callId}:confirm`,
              owner: "files",
              payload: { type: "files.confirm", version: 1, data: {} },
            },
            continuation: { type: "files.write", version: 1, data: { content: value.content } },
          };
        },
        async resume(continuation, response, execution) {
          // Owner validation precedes the business body and its durable entry ledger.
          // A same-version incompatible continuation can therefore be consumed by Core
          // without entering the file-writing business body.
          const value = (
            change === "continuation"
              ? z.object({ replacement: z.object({ content: z.string() }) })
              : z.object({ content: z.string() })
          ).parse(continuation.data);
          record("resume", execution, response.interactionId);
          if (response.type !== "answer" || response.value !== true) {
            return {
              status: "failed",
              effects: "none",
              error: { code: "DECLINED", message: "Write declined" },
            };
          }
          const content = "content" in value ? value.content : value.replacement.content;
          appendSynced(join(directory, "document.txt"), `${content}:resume\n`);
          return { status: "succeeded", output: { written: true }, effects: "applied" };
        },
      });
    },
  };
}

type CheckpointRow = {
  owner_id: string | null;
  generation: number;
  revision: number;
  payload: string;
  checkpoint: AgentCheckpoint;
};

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

type OpenOptions = {
  effects?: "none" | "applied";
  policy?: ToolAuthorizationPolicy;
  model?: (request: ModelRequest) => ModelResponse;
  maxSteps?: number;
  change?: Change;
  loseConsumedAcknowledgement?: boolean;
};

async function fixture(
  body: (f: {
    directory: string;
    row: () => CheckpointRow;
    ledger: () => LedgerEntry[];
    open: (options?: OpenOptions) => Promise<{
      agent: Agent;
      stores: SqliteAgentStores;
      saved: AgentCheckpoint[];
    }>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "general-agent-recovery-policy-"));
  const database = join(directory, "state.sqlite");
  let close: (() => Promise<void>) | undefined;
  try {
    await body({
      directory,
      row: () => checkpointRow(database),
      ledger: () => {
        try {
          return readFileSync(join(directory, "ledger.jsonl"), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as LedgerEntry);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      },
      async open(settings = {}) {
        if (close) await close();
        close = undefined;
        const stores = createSqliteAgentStores(database);
        const saved: AgentCheckpoint[] = [];
        let injected = false;
        const checkpoints: CheckpointStore = {
          acquire: (...args) => stores.checkpoints.acquire(...args),
          release: (...args) => stores.checkpoints.release(...args),
          findUnfinished: (...args) => stores.checkpoints.findUnfinished(...args),
          async save(lease, revision, checkpoint) {
            const result = await stores.checkpoints.save(lease, revision, checkpoint);
            if (result.status === "saved") {
              // Read the committed payload through a fresh, independent SQLite connection.
              saved.push(checkpointRow(database).checkpoint);
              if (
                settings.loseConsumedAcknowledgement &&
                !injected &&
                lease.key.agentId === key.agentId &&
                lease.key.threadId === key.threadId &&
                checkpoint.queryId === key.queryId &&
                checkpoint.lastRunId === "consumed" &&
                checkpoint.status === "running" &&
                checkpoint.inflight?.type === "resume" &&
                checkpoint.inflight.pending.invocation.call.callId === "write-1" &&
                checkpoint.inflight.pending.interaction.id === "write-1:confirm"
              ) {
                injected = true;
                throw new Error("Consumed response committed, acknowledgement lost");
              }
            }
            return result;
          },
        };
        const services: AgentServices = {
          history: stores.history,
          checkpoints,
          models: models(settings.model ?? finalAnswer),
          authorizeTool: settings.policy ?? allow,
        };
        const application = createAgentApplication(services);
        close = async () => {
          try {
            await application.close();
          } finally {
            await stores.dispose();
          }
        };
        const agent = await application.agents.create({
          agentId: key.agentId,
          definition: { id: "file-policy", version: "1", instructions: "Use the file capability" },
          plugins: [fileCapability(directory, settings.effects ?? "none", settings.change)],
          model: selection,
          maxSteps: settings.maxSteps ?? 5,
        });
        return { agent, stores, saved };
      },
    });
  } finally {
    try {
      if (close) await close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function completionFrom(saved: readonly AgentCheckpoint[]) {
  for (const checkpoint of saved) {
    if (checkpoint.status === "running" && checkpoint.inflight?.type === "tools") {
      const result = checkpoint.inflight.completed.find(
        (entry) => entry.invocation.call.callId === "write-1",
      );
      if (result) return result.completion;
    }
  }
  throw new Error("Expected durable completion before history append");
}

async function expectDocument(directory: string, effects: "none" | "applied") {
  if (effects === "applied")
    expect(await readFile(join(directory, "document.txt"), "utf8")).toBe("document:execute\n");
  else
    await expect(readFile(join(directory, "document.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
}

async function expectPairedHistory(stores: SqliteAgentStores, isError: boolean) {
  const history = await stores.history.read(key.threadId);
  expect(history.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
  expect(history.messages[1].content).toEqual([
    { type: "tool-call", callId: "write-1", name: "files.write", input: { content: "document" } },
  ]);
  expect(history.messages[2].content).toMatchObject([
    { type: "tool-result", callId: "write-1", isError },
  ]);
  expect(history.revision).toBe(3);
}

const effectsCases = ["none", "applied"] as const;

describe("D3 public SQLite recovery policy", () => {
  it.each(effectsCases)("D3-1 reauthorizes current deny after a real %s wait", async (effects) =>
    fixture(async (f) => {
      const first = await f.open({ effects, model: () => toolCall() });
      const waiting = await (await first.agent.run(initialInput)).completed;
      if (waiting.status !== "waiting") throw new Error("Expected durable wait");
      const original = f.row();
      const authorizationRuns: string[] = [];
      const restored = await f.open({
        effects,
        policy: (_call, context) => {
          authorizationRuns.push(context.identity.runId);
          expect(f.row().checkpoint).toMatchObject({
            status: "running",
            inflight: { type: "resume" },
          });
          return { type: "deny", reason: "Write permission revoked" };
        },
      });
      const handle = await restored.agent.resume({
        ...key,
        runId: "denied",
        response: affirmative(waiting.interaction.id),
      });
      expect(await handle.completed).toMatchObject({
        status: "completed",
        identity: { queryId: key.queryId, runId: "denied" },
      });
      expect(authorizationRuns).toEqual(["denied"]);
      expect(completionFrom(restored.saved)).toMatchObject({
        status: "failed",
        effects,
        error: { code: "tool_denied" },
      });
      const events = [];
      for await (const event of handle.events)
        if (event.type === "tool.completed") events.push(event.completion);
      expect(events).toMatchObject([{ status: "failed", effects, error: { code: "tool_denied" } }]);
      expect(f.ledger().map((entry) => entry.phase)).toEqual(["execute"]);
      await expectDocument(f.directory, effects);
      await expectPairedHistory(restored.stores, true);
      expect(f.row()).toMatchObject({
        owner_id: null,
        generation: original.generation + 1,
        checkpoint: { status: "completed" },
      });
    }),
  );

  for (const action of ["changed", "denied", "rejected"] as const) {
    it.each(effectsCases)(
      `D3-1/2 refuses ${action} host approval with prior %s effects`,
      async (effects) =>
        fixture(async (f) => {
          const first = await f.open({ effects, model: () => toolCall() });
          const waiting = await (await first.agent.run(initialInput)).completed;
          if (waiting.status !== "waiting") throw new Error("Expected tool wait");
          const approvalHost = await f.open({ effects, policy: approve });
          const approvalWait = await (
            await approvalHost.agent.resume({
              ...key,
              runId: "needs-approval",
              response: affirmative(waiting.interaction.id),
            })
          ).completed;
          expect(approvalWait).toMatchObject({ status: "waiting", interaction: approval });
          if (approvalWait.status !== "waiting") throw new Error("Expected host approval wait");
          expect(f.row().checkpoint).toMatchObject({
            status: "waiting",
            pending: { effects, interaction: approval },
          });
          expect(f.ledger().map((entry) => entry.phase)).toEqual(["execute"]);
          const policy: ToolAuthorizationPolicy =
            action === "denied"
              ? () => ({ type: "deny", reason: "Approval no longer grants write access" })
              : action === "rejected"
                ? approve
                : () => ({
                    type: "approval",
                    interaction: {
                      ...approval,
                      payload: { ...approval.payload, data: { scope: "new-current-requirement" } },
                    },
                  });
          const restored = await f.open({ effects, policy });
          const response: InteractionResponse =
            action === "rejected"
              ? { type: "reject", interactionId: approvalWait.interaction.id }
              : affirmative(approvalWait.interaction.id);
          expect(
            await (await restored.agent.resume({ ...key, runId: `${action}-approval`, response }))
              .completed,
          ).toMatchObject({ status: "completed" });
          const code =
            action === "denied"
              ? "tool_denied"
              : action === "rejected"
                ? "tool_approval_rejected"
                : "tool_approval_changed";
          expect(completionFrom(restored.saved)).toMatchObject({
            status: "failed",
            effects,
            error: { code },
          });
          expect(
            restored.saved.filter(
              (checkpoint) =>
                checkpoint.status === "running" && checkpoint.inflight?.type === "resume",
            ),
          ).toHaveLength(1);
          expect(f.ledger().map((entry) => entry.phase)).toEqual(["execute"]);
          await expectDocument(f.directory, effects);
          await expectPairedHistory(restored.stores, true);
        }),
    );
  }

  for (const responseType of ["reject", "cancel"] as const) {
    it.each(effectsCases)(
      `D3-2 rejects wrong interaction before consuming a matching ${responseType} with %s effects`,
      async (effects) =>
        fixture(async (f) => {
          const first = await f.open({ effects, model: () => toolCall() });
          const waiting = await (await first.agent.run(initialInput)).completed;
          if (waiting.status !== "waiting") throw new Error("Expected durable wait");
          const before = f.row();
          const restored = await f.open({ effects });
          const wrong = await restored.agent.resume({
            ...key,
            runId: "wrong",
            response: affirmative("foreign-interaction"),
          });
          await expect(wrong.completed).rejects.toMatchObject({ code: "STALE_INTERACTION" });
          expect(f.row()).toMatchObject({
            revision: before.revision,
            payload: before.payload,
            owner_id: null,
          });
          expect(restored.saved).toEqual([]);
          expect(f.ledger().map((entry) => entry.phase)).toEqual(["execute"]);
          const response: InteractionResponse = {
            type: responseType,
            interactionId: waiting.interaction.id,
          };
          const handled = await restored.agent.resume({ ...key, runId: "matched", response });
          expect(await handled.completed).toMatchObject({
            status: responseType === "cancel" ? "cancelled" : "completed",
          });
          expect(
            restored.saved.filter(
              (checkpoint) =>
                checkpoint.status === "running" && checkpoint.inflight?.type === "resume",
            ),
          ).toHaveLength(1);
          if (responseType === "reject") {
            expect(completionFrom(restored.saved)).toMatchObject({
              status: "failed",
              effects,
              error: { code: "DECLINED" },
            });
            expect(f.ledger().map((entry) => entry.phase)).toEqual(["execute", "resume"]);
            await expectPairedHistory(restored.stores, true);
          } else {
            expect(f.ledger().map((entry) => entry.phase)).toEqual(["execute"]);
            expect((await restored.stores.history.read(key.threadId)).messages).toEqual(
              initialInput.input,
            );
          }
          await expectDocument(f.directory, effects);
          const terminal = f.row();
          const next = await f.open({ effects });
          await expect(
            (await next.agent.resume({ ...key, runId: "duplicate", response })).completed,
          ).rejects.toMatchObject({ code: "QUERY_TERMINAL" });
          expect(f.row()).toMatchObject({
            revision: terminal.revision,
            payload: terminal.payload,
            owner_id: null,
          });
        }),
    );
  }

  it.each(effectsCases)(
    "D3-2 refuses an old approval after its consumed %s response lost acknowledgement",
    async (effects) =>
      fixture(async (f) => {
        const first = await f.open({ effects, model: () => toolCall() });
        const waiting = await (await first.agent.run(initialInput)).completed;
        if (waiting.status !== "waiting") throw new Error("Expected durable wait");
        const response = affirmative(waiting.interaction.id);
        const consuming = await f.open({ effects, loseConsumedAcknowledgement: true });
        await expect(
          (await consuming.agent.resume({ ...key, runId: "consumed", response })).completed,
        ).rejects.toMatchObject({ code: "PERSISTENCE_FAILED" });
        const consumed = f.row();
        expect(consumed.checkpoint).toMatchObject({
          status: "running",
          inflight: { type: "resume", pending: { effects }, response },
        });
        const restored = await f.open({ effects });
        await expect(
          (await restored.agent.resume({ ...key, runId: "stale-answer", response })).completed,
        ).rejects.toMatchObject({ code: "STALE_INTERACTION" });
        expect(f.row()).toMatchObject({ revision: consumed.revision, payload: consumed.payload });
        expect(restored.saved).toEqual([]);
        const handle = await restored.agent.resume({ ...key, runId: "without-response" });
        expect(await handle.completed).toMatchObject({ status: "completed" });
        const expectedEffects: ToolSideEffects = effects === "applied" ? "applied" : "unknown";
        expect(completionFrom(restored.saved)).toMatchObject({
          status: "unknown",
          effects: expectedEffects,
          error: { code: "TOOL_OUTCOME_UNKNOWN" },
        });
        const completions = [];
        for await (const event of handle.events)
          if (event.type === "tool.completed") completions.push(event.completion);
        expect(completions).toMatchObject([{ status: "unknown", effects: expectedEffects }]);
        expect(f.ledger().map((entry) => entry.phase)).toEqual(["execute"]);
        await expectDocument(f.directory, effects);
        await expectPairedHistory(restored.stores, true);
      }),
  );

  it.each([
    {
      name: "persisted budget despite a larger restored budget",
      initial: 3,
      restored: 9,
      limit: 3,
    },
    { name: "smaller current Core budget", initial: 5, restored: 2, limit: 2 },
  ])("D3-3 accumulates repeated waits under $name", async ({ initial, restored, limit }) =>
    fixture(async (f) => {
      let modelCalls = 0;
      const model = (request: ModelRequest) => {
        const toolMessages = request.messages.filter((message) => message.role === "tool").length;
        modelCalls += 1;
        return toolCall(toolMessages + 1);
      };
      let current = await f.open({ model, maxSteps: initial });
      let result = await (await current.agent.run(initialInput)).completed;
      for (let step = 0; step < limit; step += 1) {
        expect(result).toMatchObject({
          status: "waiting",
          identity: { queryId: key.queryId, runId: step === 0 ? "initial" : `resume-${step}` },
        });
        if (result.status !== "waiting") throw new Error("Expected another durable wait");
        const before = f.row();
        expect(before.checkpoint).toMatchObject({
          status: "waiting",
          maxSteps: initial,
          committed: { step },
        });
        current = await f.open({ model, maxSteps: restored });
        result = await (
          await current.agent.resume({
            ...key,
            runId: `resume-${step + 1}`,
            response: affirmative(result.interaction.id),
          })
        ).completed;
        expect(f.row().generation).toBe(before.generation + 1);
      }
      expect(result).toMatchObject({ status: "failed", error: { code: "STEP_LIMIT" } });
      expect(modelCalls).toBe(limit);
      expect(f.row()).toMatchObject({
        owner_id: null,
        checkpoint: {
          status: "failed",
          maxSteps: initial,
          committed: { step: limit },
          error: { code: "STEP_LIMIT" },
        },
      });
      const entries = f.ledger();
      expect(entries.filter((entry) => entry.phase === "execute")).toHaveLength(limit);
      expect(entries.filter((entry) => entry.phase === "resume")).toHaveLength(limit);
      expect(new Set(entries.map((entry) => entry.nonce)).size).toBe(limit * 2);
      expect(
        entries.every(
          (entry) =>
            entry.queryId === key.queryId &&
            entry.threadId === key.threadId &&
            entry.agentId === key.agentId,
        ),
      ).toBe(true);
      expect(await readFile(join(f.directory, "document.txt"), "utf8")).toBe(
        "document:resume\n".repeat(limit),
      );
      const history = await current.stores.history.read(key.threadId);
      expect(history.revision).toBe(limit + 1);
      expect(history.messages.map((message) => message.role)).toEqual([
        "user",
        ...Array.from({ length: limit }, () => ["assistant", "tool"]).flat(),
      ]);
      const terminal = f.row();
      current = await f.open({ model, maxSteps: 99 });
      await expect(
        (await current.agent.resume({ ...key, runId: "cannot-reset" })).completed,
      ).rejects.toMatchObject({ code: "QUERY_TERMINAL" });
      expect(modelCalls).toBe(limit);
      expect(f.row()).toMatchObject({ revision: terminal.revision, payload: terminal.payload });
    }),
  );

  // HostSessionBinding budget increases/decreases are already covered end-to-end
  // by general-agent-development-host.test.ts: rejected opens leave the original
  // checkpoint/history/binding untouched, then original-binding recovery writes once.
  for (const change of ["owner", "schema", "continuation"] as const) {
    it.each(effectsCases)(
      `D3-4 consumes the answer before same-version ${change} incompatibility with %s effects`,
      async (effects) =>
        fixture(async (f) => {
          const first = await f.open({ effects, model: () => toolCall() });
          const waiting = await (await first.agent.run(initialInput)).completed;
          if (waiting.status !== "waiting") throw new Error("Expected durable wait");
          const response = affirmative(waiting.interaction.id);
          const before = f.row();
          const restored = await f.open({ effects, change });
          const handle = await restored.agent.resume({ ...key, runId: "incompatible", response });
          expect(await handle.completed).toMatchObject({ status: "completed" });
          const consumed = restored.saved.find(
            (checkpoint) =>
              checkpoint.status === "running" && checkpoint.inflight?.type === "resume",
          );
          expect(consumed).toMatchObject({
            status: "running",
            lastRunId: "incompatible",
            inflight: { type: "resume", response, pending: { effects } },
          });
          const completion = completionFrom(restored.saved);
          if (change === "continuation") {
            expect(completion).toMatchObject({
              status: "unknown",
              effects: effects === "applied" ? "applied" : "unknown",
            });
          } else {
            expect(completion).toMatchObject({
              status: "failed",
              effects,
              error: { code: "tool_stale" },
            });
          }
          expect(f.row()).toMatchObject({
            owner_id: null,
            generation: before.generation + 1,
            checkpoint: { status: "completed" },
          });
          expect(f.ledger().map((entry) => entry.phase)).toEqual(["execute"]);
          await expectDocument(f.directory, effects);
          await expectPairedHistory(restored.stores, true);
          const duplicate = await restored.agent.resume({ ...key, runId: "old-answer", response });
          await expect(duplicate.completed).rejects.toMatchObject({ code: "QUERY_TERMINAL" });
          expect(f.ledger()).toHaveLength(1);
        }),
    );
  }
});
