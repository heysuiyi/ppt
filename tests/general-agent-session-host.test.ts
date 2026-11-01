import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentServices } from "@agent-harness/core/agent-factory";
import type { AgentPlugin, PluginContext } from "@agent-harness/core/extensions/plugin-contract";
import type {
  ModelBinding,
  ModelClient,
  ModelClientFactory,
  ModelRequest,
  ModelResponse,
  ModelSelection,
} from "@agent-harness/core/model/model-contract";
import { AgentError, asProtocolError } from "@agent-harness/core/protocol-errors";
import {
  type InteractionResponse,
  sameValue,
  snapshot,
  type VersionedData,
} from "@agent-harness/core/protocol-values";
import type {
  CheckpointKey,
  CheckpointStore,
} from "@agent-harness/core/session/checkpoint-contract";
import {
  createSessionHost,
  type SessionBindingPort,
  type SessionHost,
  type SessionHostOptions,
} from "@agent-harness/core/session-host";
import type {
  ResumableToolDefinition,
  ToolAuthorizationPolicy,
  ToolCompletion,
  ToolExecutionContext,
  ToolResult,
  ToolSuspension,
} from "@agent-harness/core/tools/tool-contract";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { z } from "zod";
import { createSqliteAgentStores } from "../src/main/agent-host/sqlite-agent-stores";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function answer(text: string): ModelResponse {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    finishReason: "stop",
  };
}

function creditCall(): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: [
        { type: "tool-call", callId: "credit-1", name: "ledger.credit", input: { amount: 7 } },
      ],
    },
    finishReason: "tool-calls",
  };
}

function activation(queryId = "query", runId = "run") {
  return {
    queryId,
    runId,
    input: [{ role: "user" as const, content: [{ type: "text" as const, text: "Credit seven." }] }],
  };
}

function checkpointKey(queryId = "query"): CheckpointKey {
  return { agentId: "custom-agent", threadId: "fixed-thread", queryId };
}

/** 确定性绑定端口实际比较固定配置，不使用空 ensure 绕过创建约束。 */
class ComparingSessionBinding implements SessionBindingPort {
  readonly entered = Promise.withResolvers<void>();
  readonly dispose = vi.fn(async () => {});
  beforeEnsure?: () => Promise<void>;
  stored: unknown;

  constructor(private readonly configuration: () => unknown) {}

  async ensure(): Promise<void> {
    const expected = snapshot(this.configuration());
    this.entered.resolve();
    await this.beforeEnsure?.();
    if (this.stored === undefined) this.stored = expected;
    else if (!sameValue(this.stored, expected))
      throw new AgentError("FIXTURE_BINDING_MISMATCH", "Session binding differs.");
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "general-agent-session-host-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const stores = createSqliteAgentStores(join(directory, "sessions.sqlite"));
  cleanup.push(() => stores.dispose());
  const borrowedDisposed = vi.fn(async () => {});
  const modelBindingDisposed = vi.fn(async () => {});
  const generate = vi.fn(
    async (_request: ModelRequest, _signal: AbortSignal): Promise<ModelResponse> =>
      answer("plain completion"),
  );
  const bind = vi.fn(
    async (selection: ModelSelection, _signal: AbortSignal): Promise<ModelBinding> => {
      const client: ModelClient = {
        selection: snapshot(selection),
        capabilities: { streaming: false, toolCalls: true, images: false, reasoning: false },
        generate,
        async *stream(request, signal) {
          yield { type: "completed", response: await generate(request, signal) };
        },
      };
      return { client, dispose: modelBindingDisposed };
    },
  );
  const authorizeTool = vi.fn<ToolAuthorizationPolicy>(() => ({ type: "allow" }));
  const models = { create: bind, dispose: borrowedDisposed };
  const history = { ...stores.history, dispose: borrowedDisposed };
  const checkpoints = { ...stores.checkpoints, dispose: borrowedDisposed };
  const services: Mutable<AgentServices> = { models, history, checkpoints, authorizeTool };
  const agent = {
    agentId: "custom-agent",
    definition: {
      id: "custom-definition",
      version: "3",
      instructions: "Use only chosen capabilities.",
    },
    model: { providerId: "deterministic", modelId: "selected-model", reasoningEffort: "balanced" },
    maxSteps: 3,
    plugins: [] as AgentPlugin[],
    signal: undefined as AbortSignal | undefined,
  };
  const binding = new ComparingSessionBinding(() => ({
    threadId: options.threadId,
    agentId: options.agent.agentId,
    definition: options.agent.definition,
    model: options.agent.model,
    maxSteps: options.agent.maxSteps,
    plugins: options.agent.plugins.map(({ id, version }) => ({ id, version })),
  }));
  const options: Mutable<SessionHostOptions> = {
    services,
    agent,
    threadId: "fixed-thread",
    binding,
  };
  return {
    directory,
    options,
    agent,
    services,
    stores,
    history,
    checkpoints,
    models,
    binding,
    generate,
    bind,
    authorizeTool,
    borrowedDisposed,
    modelBindingDisposed,
  };
}

async function ownHost(options: SessionHostOptions): Promise<SessionHost> {
  const host = await createSessionHost(options);
  cleanup.push(() => host.close());
  return host;
}

function ledger() {
  const state = { balance: 0 };
  const disposed = vi.fn(async () => {});
  const setup = vi.fn(({ tools, scope }: PluginContext) => {
    scope.own({ dispose: disposed });
    tools.register({
      name: "ledger.credit",
      owner: "test-ledger",
      version: "1",
      description: "Credit a deterministic account",
      mode: "immediate",
      inputSchema: z.object({ amount: z.number().int().positive() }),
      outputSchema: z.object({ balance: z.number().int() }),
      async execute({ amount }) {
        state.balance += amount;
        return { status: "succeeded", output: { balance: state.balance }, effects: "applied" };
      },
      toModelContent(result) {
        return [
          {
            type: "text",
            text:
              result.status === "succeeded"
                ? `balance:${result.output.balance}`
                : result.error.code,
          },
        ];
      },
    });
  });
  const plugin: AgentPlugin = { id: "test-ledger", version: "1", setup };
  return { state, setup, plugin, disposed };
}

function approvalPolicy(): ToolAuthorizationPolicy {
  return (call, context) => ({
    type: "approval",
    interaction: {
      id: `approve:${context.identity.queryId}:${call.callId}`,
      owner: "host-policy",
      payload: { type: "test.ledger-approval", version: 1, data: { amount: call.input.amount } },
    },
  });
}

function consumeCredit(request: ModelRequest): ModelResponse {
  const result = request.messages
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content)
    .at(-1);
  if (!result) return creditCall();
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  return answer(`Observed ${text}`);
}

const acceptanceSelection: ModelSelection = {
  providerId: "acceptance-model",
  modelId: "acceptance-model-v1",
};
const receiptInput = z.object({ nonce: z.string().min(1) }).strict();
const receiptOutput = receiptInput.extend({ receiptId: z.string().min(1) }).strict();
type Receipt = z.infer<typeof receiptOutput>;
type ReceiptTool = ResumableToolDefinition<z.infer<typeof receiptInput>, Receipt>;

interface AcceptanceModelBindingRecord {
  readonly binding: ModelBinding;
  readonly generate: Mock<ModelClient["generate"]>;
  readonly stream: Mock<ModelClient["stream"]>;
  readonly dispose: Mock<() => Promise<void>>;
  readonly state: { released: boolean };
}

interface AcceptanceReceiptInstallation {
  readonly state: { released: boolean };
  readonly dispose: Mock<() => Promise<void>>;
  readonly execute: Mock<ReceiptTool["execute"]>;
  readonly resume: Mock<ReceiptTool["resume"]>;
  readonly toModelContent: Mock<ReceiptTool["toModelContent"]>;
}

function acceptanceModelBinding(selection: ModelSelection): AcceptanceModelBindingRecord {
  const state = { released: false };
  const generate = vi.fn<ModelClient["generate"]>(
    async (request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> => {
      signal.throwIfAborted();
      if (state.released) throw new Error("Acceptance binding was released.");
      const userText = request.messages
        .filter((message) => message.role === "user")
        .flatMap((message) => message.content)
        .filter((part) => part.type === "text")
        .at(-1)?.text;
      const { nonce } = receiptInput.parse(JSON.parse(userText ?? "null"));
      const callId = `receipt:${nonce}`;
      const result = request.messages
        .filter((message) => message.role === "tool")
        .flatMap((message) => message.content)
        .find((part) => part.callId === callId);
      if (!result)
        return {
          message: {
            role: "assistant",
            content: [{ type: "tool-call", callId, name: "receipt.append", input: { nonce } }],
          },
          finishReason: "tool-calls",
        };
      const text = result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (result.isError) return answer(`Receipt rejected ${text}`);
      const receipt = receiptOutput.parse(JSON.parse(text));
      if (receipt.nonce !== nonce) throw new Error("Receipt does not match the user nonce.");
      return answer(`Receipt ${receipt.nonce}:${receipt.receiptId}`);
    },
  );
  const stream = vi.fn<ModelClient["stream"]>(async function* (request, signal) {
    yield { type: "completed", response: await generate(request, signal) };
  });
  const dispose = vi.fn(async () => {
    state.released = true;
  });
  const binding: ModelBinding = {
    client: {
      selection: snapshot(selection),
      capabilities: { streaming: false, toolCalls: true, images: false, reasoning: false },
      generate,
      stream,
    },
    dispose,
  };
  return { binding, generate, stream, dispose, state };
}

function acceptanceModel() {
  const bindings: AcceptanceModelBindingRecord[] = [];
  const installations: Array<{ released: boolean; dispose: () => Promise<void> }> = [];
  const create = vi.fn<ModelClientFactory["create"]>(async (selection, signal) => {
    signal.throwIfAborted();
    const record = acceptanceModelBinding(selection);
    bindings.push(record);
    return record.binding;
  });
  const factory: ModelClientFactory = { create };
  const plugin: AgentPlugin = {
    id: "acceptance-model",
    version: "1",
    setup({ models, prompts, scope }) {
      const resource = {
        released: false,
        dispose: vi.fn(async () => {
          resource.released = true;
        }),
      };
      installations.push(resource);
      scope.own(resource);
      models.register("acceptance-model", factory);
      prompts.register({ id: "acceptance-model.prompt", render: () => "[acceptance:model]" });
    },
  };
  return { plugin, create, bindings, installations };
}

function acceptanceReceiptInstallation(path: string): AcceptanceReceiptInstallation {
  const state = { released: false };
  const dispose = vi.fn(async () => {
    state.released = true;
  });
  const interactionId = (context: ToolExecutionContext) =>
    `receipt:${context.identity.queryId}:${context.callId}`;
  const execute = vi.fn<ReceiptTool["execute"]>(
    async (
      input: z.infer<typeof receiptInput>,
      context: ToolExecutionContext,
    ): Promise<ToolSuspension> => {
      context.signal.throwIfAborted();
      if (state.released) throw new Error("Receipt installation was released.");
      const { nonce } = receiptInput.parse(input);
      return {
        status: "waiting",
        effects: "none",
        interaction: {
          id: interactionId(context),
          owner: "acceptance-receipt",
          payload: { type: "acceptance.receipt-confirm", version: 1, data: { nonce } },
        },
        continuation: { type: "acceptance.receipt", version: 1, data: { nonce } },
      };
    },
  );
  const resume = vi.fn<ReceiptTool["resume"]>(
    async (
      continuation: VersionedData,
      response: InteractionResponse,
      context: ToolExecutionContext,
    ): Promise<ToolResult<Receipt>> => {
      context.signal.throwIfAborted();
      if (state.released) throw new Error("Receipt installation was released.");
      if (
        response.interactionId !== interactionId(context) ||
        response.type !== "answer" ||
        response.value !== true
      )
        return {
          status: "failed",
          effects: "none",
          error: { code: "receipt_declined", message: "Receipt confirmation was declined." },
        };
      const saved = z
        .object({
          type: z.literal("acceptance.receipt"),
          version: z.literal(1),
          data: receiptInput,
        })
        .strict()
        .parse(continuation);
      const output = { nonce: saved.data.nonce, receiptId: randomUUID() };
      await appendFile(
        path,
        `${JSON.stringify({ identity: context.identity, callId: context.callId, ...output })}\n`,
        "utf8",
      );
      return { status: "succeeded", output, effects: "applied" };
    },
  );
  const toModelContent = vi.fn<ReceiptTool["toModelContent"]>((result) => [
    {
      type: "text" as const,
      text: result.status === "succeeded" ? JSON.stringify(result.output) : result.error.code,
    },
  ]);
  return { state, dispose, execute, resume, toModelContent };
}

function acceptanceReceipt(path: string) {
  const installations: AcceptanceReceiptInstallation[] = [];
  const plugin: AgentPlugin = {
    id: "acceptance-receipt",
    version: "1",
    setup({ tools, prompts, scope }) {
      const installed = acceptanceReceiptInstallation(path);
      installations.push(installed);
      scope.own(installed);
      tools.register({
        name: "receipt.append",
        owner: "acceptance-receipt",
        version: "1",
        description: "Append a confirmed acceptance receipt",
        mode: "resumable",
        inputSchema: receiptInput,
        outputSchema: receiptOutput,
        execute: installed.execute,
        resume: installed.resume,
        toModelContent: installed.toModelContent,
      });
      prompts.register({ id: "acceptance-receipt.prompt", render: () => "[acceptance:receipt]" });
    },
  };
  return { plugin, installations };
}

async function inspectCheckpoint(
  f: { readonly checkpoints: CheckpointStore },
  queryId = "query",
  threadId = "fixed-thread",
) {
  const acquired = await f.checkpoints.acquire(
    { ...checkpointKey(queryId), threadId },
    "inspector",
  );
  if (acquired.status !== "acquired") throw new Error("Expected a released writer lease.");
  await f.checkpoints.release(acquired.lease);
  return acquired.checkpoint;
}

describe("generic session host independent capability composition", () => {
  it.each(["model-first", "receipt-first"] as const)(
    "composes and resumes a real receipt with %s registration order",
    async (order) => {
      const f = fixture();
      const nonce = randomUUID();
      const threadId = `receipt-thread:${nonce}`;
      const path = join(f.directory, "receipts.jsonl");
      const model = acceptanceModel();
      const receipt = acceptanceReceipt(path);
      const plugins =
        order === "model-first" ? [model.plugin, receipt.plugin] : [receipt.plugin, model.plugin];
      f.options.threadId = threadId;
      f.options.agent = { ...f.agent, model: acceptanceSelection, plugins };
      const host = await ownHost(f.options);
      expect(model.create).toHaveBeenCalledExactlyOnceWith(
        acceptanceSelection,
        expect.any(AbortSignal),
      );
      expect(model.bindings).toHaveLength(1);
      expect(model.installations).toHaveLength(1);
      expect(receipt.installations).toHaveLength(1);
      const selected = model.bindings[0];
      const installed = receipt.installations[0];
      expect(selected.binding.client.selection).toEqual(acceptanceSelection);
      expect(selected.generate).not.toHaveBeenCalled();
      expect(selected.stream).not.toHaveBeenCalled();
      expect(installed.execute).not.toHaveBeenCalled();
      expect(installed.resume).not.toHaveBeenCalled();
      expect(f.bind).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
      expect(existsSync(path)).toBe(false);

      const initialIdentity = {
        agentId: "custom-agent",
        threadId,
        queryId: "receipt-query",
        runId: "receipt-run",
      };
      const call = {
        type: "tool-call",
        callId: `receipt:${nonce}`,
        name: "receipt.append",
        input: { nonce },
      };
      const run = await host.run({
        queryId: initialIdentity.queryId,
        runId: initialIdentity.runId,
        input: [{ role: "user", content: [{ type: "text", text: JSON.stringify({ nonce }) }] }],
      });
      const waiting = await run.completed;
      expect(waiting).toMatchObject({ status: "waiting", identity: initialIdentity });
      if (waiting.status !== "waiting") throw new Error("Expected the receipt capability to wait.");
      expect(waiting.interaction).toEqual({
        id: `receipt:${initialIdentity.queryId}:${call.callId}`,
        owner: "acceptance-receipt",
        payload: { type: "acceptance.receipt-confirm", version: 1, data: { nonce } },
      });
      const waitingEvents: string[] = [];
      for await (const event of run.events) waitingEvents.push(event.type);
      expect(waitingEvents.filter((type) => type === "interaction.requested")).toHaveLength(1);
      expect(waitingEvents.filter((type) => type === "run.waiting")).toHaveLength(1);
      expect(installed.execute).toHaveBeenCalledTimes(1);
      expect(installed.execute.mock.calls[0]).toEqual([
        { nonce },
        expect.objectContaining({ identity: initialIdentity, callId: call.callId }),
      ]);
      expect(installed.resume).not.toHaveBeenCalled();
      expect(selected.generate).toHaveBeenCalledTimes(1);
      expect(existsSync(path)).toBe(false);
      expect(await inspectCheckpoint(f, initialIdentity.queryId, threadId)).toMatchObject({
        status: "waiting",
        model: acceptanceSelection,
        lastRunId: initialIdentity.runId,
        plugins: plugins.map(({ id, version }) => ({ id, version })),
        pending: {
          effects: "none",
          interaction: waiting.interaction,
          invocation: { identity: initialIdentity, call, toolVersion: "1" },
        },
      });

      const resumedIdentity = { ...initialIdentity, runId: "receipt-resumed" };
      const response = {
        type: "answer" as const,
        interactionId: waiting.interaction.id,
        value: true,
      };
      const resumed = await host.resume({
        queryId: resumedIdentity.queryId,
        runId: resumedIdentity.runId,
        response,
      });
      const completed = await resumed.completed;
      expect(installed.execute).toHaveBeenCalledTimes(1);
      expect(installed.resume).toHaveBeenCalledExactlyOnceWith(
        { type: "acceptance.receipt", version: 1, data: { nonce } },
        response,
        expect.objectContaining({ identity: resumedIdentity, callId: call.callId }),
      );
      const lines = readFileSync(path, "utf8").trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      const disk = receiptOutput.passthrough().parse(JSON.parse(lines[0]));
      const output = receiptOutput.parse({ nonce: disk.nonce, receiptId: disk.receiptId });
      expect(output.nonce).toBe(nonce);
      expect(disk).toEqual({ identity: resumedIdentity, callId: call.callId, ...output });
      const modelResult = {
        type: "tool-result",
        callId: call.callId,
        content: [{ type: "text", text: JSON.stringify(output) }],
        isError: false,
      };
      const toolCompletions: ToolCompletion[] = [];
      for await (const event of resumed.events) {
        expect(event.type).not.toBe("run.waiting");
        if (event.type === "tool.completed") {
          expect(event.identity).toEqual(resumedIdentity);
          expect(event.invocation).toMatchObject({
            identity: initialIdentity,
            call,
            toolVersion: "1",
          });
          toolCompletions.push(event.completion);
        }
      }
      expect(toolCompletions).toEqual([
        {
          status: "succeeded",
          effects: "applied",
          output,
          modelContent: modelResult.content,
        },
      ]);
      const finalMessage = answer(`Receipt ${nonce}:${output.receiptId}`).message;
      expect(completed).toMatchObject({
        status: "completed",
        identity: resumedIdentity,
        output: expect.arrayContaining([finalMessage]),
      });
      const history = await f.history.read(threadId);
      expect(history.messages).toEqual([
        { role: "user", content: [{ type: "text", text: JSON.stringify({ nonce }) }] },
        { role: "assistant", content: [call] },
        { role: "tool", content: [modelResult] },
        finalMessage,
      ]);
      expect(selected.generate).toHaveBeenCalledTimes(2);
      expect(selected.generate.mock.calls[1][0].messages).toContainEqual({
        role: "tool",
        content: [modelResult],
      });
      const markers =
        order === "model-first"
          ? ["[acceptance:model]", "[acceptance:receipt]"]
          : ["[acceptance:receipt]", "[acceptance:model]"];
      for (const [request] of selected.generate.mock.calls) {
        expect(request.tools?.map(({ name }) => name)).toEqual(["receipt.append"]);
        expect(request.tools?.[0].inputSchema).toMatchObject({
          type: "object",
          properties: { nonce: { type: "string" } },
          required: ["nonce"],
          additionalProperties: false,
        });
        const system = request.messages
          .filter((message) => message.role === "system")
          .flatMap((message) => message.content)
          .map((part) => part.text)
          .join("");
        expect(system.indexOf(f.agent.definition.instructions)).toBeGreaterThanOrEqual(0);
        expect(system.indexOf(markers[0])).toBeGreaterThan(
          system.indexOf(f.agent.definition.instructions),
        );
        expect(system.indexOf(markers[1])).toBeGreaterThan(system.indexOf(markers[0]));
      }
      expect(await inspectCheckpoint(f, initialIdentity.queryId, threadId)).toMatchObject({
        status: "completed",
        model: acceptanceSelection,
        lastRunId: resumedIdentity.runId,
        committed: { messages: history.messages, historyRevision: history.revision },
      });
      expect(await f.checkpoints.findUnfinished("custom-agent", threadId)).toBeNull();
      expect(selected.stream).not.toHaveBeenCalled();
      expect(f.bind).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
      expect(selected.state.released).toBe(false);
      expect(installed.state.released).toBe(false);
      expect(model.installations[0].released).toBe(false);
      await host.close();
      expect(selected.dispose).toHaveBeenCalledTimes(1);
      expect(selected.state.released).toBe(true);
      expect(installed.dispose).toHaveBeenCalledTimes(1);
      expect(installed.state.released).toBe(true);
      expect(model.installations[0].dispose).toHaveBeenCalledTimes(1);
      expect(model.installations[0].released).toBe(true);
      expect(f.borrowedDisposed).not.toHaveBeenCalled();
      expect(f.binding.dispose).not.toHaveBeenCalled();
      expect((await f.history.read(threadId)).messages).toEqual(history.messages);
      expect((await inspectCheckpoint(f, initialIdentity.queryId, threadId))?.status).toBe(
        "completed",
      );
      const fallback = await f.models.create(f.agent.model, new AbortController().signal);
      expect(
        await fallback.client.generate({ messages: [] }, new AbortController().signal),
      ).toEqual(answer("plain completion"));
      await fallback.dispose();
      expect(f.bind).toHaveBeenCalledTimes(1);
      expect(f.generate).toHaveBeenCalledTimes(1);
      expect(f.borrowedDisposed).not.toHaveBeenCalled();
    },
  );

  it("keeps host denial ahead of the installed receipt capability and models the real error", async () => {
    const f = fixture();
    const nonce = randomUUID();
    const threadId = `denied-receipt:${nonce}`;
    const path = join(f.directory, "receipts.jsonl");
    const model = acceptanceModel();
    const receipt = acceptanceReceipt(path);
    f.options.threadId = threadId;
    f.options.agent = {
      ...f.agent,
      model: acceptanceSelection,
      plugins: [model.plugin, receipt.plugin],
    };
    f.authorizeTool.mockReturnValue({ type: "deny", reason: "Receipt access denied." });
    const host = await ownHost(f.options);
    const selected = model.bindings[0];
    const installed = receipt.installations[0];
    expect(selected.generate).not.toHaveBeenCalled();
    expect(selected.stream).not.toHaveBeenCalled();
    expect(installed.execute).not.toHaveBeenCalled();
    expect(installed.resume).not.toHaveBeenCalled();
    const run = await host.run({
      queryId: "denied-receipt",
      runId: "denied-run",
      input: [{ role: "user", content: [{ type: "text", text: JSON.stringify({ nonce }) }] }],
    });
    const completed = await run.completed;
    expect(completed).toMatchObject({
      status: "completed",
      identity: { threadId, queryId: "denied-receipt", runId: "denied-run" },
    });
    const completions: ToolCompletion[] = [];
    for await (const event of run.events) {
      expect(event.type).not.toBe("run.waiting");
      expect(event.type).not.toBe("interaction.requested");
      if (event.type === "tool.completed") completions.push(event.completion);
    }
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      status: "failed",
      effects: "none",
      error: { code: "tool_denied" },
    });
    const rejectedContent = completions[0].modelContent
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(completed).toMatchObject({
      output: expect.arrayContaining([answer(`Receipt rejected ${rejectedContent}`).message]),
    });
    expect(f.authorizeTool).toHaveBeenCalledTimes(1);
    expect(f.authorizeTool.mock.calls[0][0]).toEqual({
      type: "tool-call",
      callId: `receipt:${nonce}`,
      name: "receipt.append",
      input: { nonce },
    });
    expect(installed.execute).not.toHaveBeenCalled();
    expect(installed.resume).not.toHaveBeenCalled();
    expect(installed.toModelContent).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
    const history = await f.history.read(threadId);
    const results = history.messages
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content);
    expect(results).toEqual([
      {
        type: "tool-result",
        callId: `receipt:${nonce}`,
        isError: true,
        content: completions[0].modelContent,
      },
    ]);
    expect(selected.generate).toHaveBeenCalledTimes(2);
    expect(selected.generate.mock.calls[1][0].messages).toContainEqual({
      role: "tool",
      content: results,
    });
    expect(selected.generate.mock.calls[0][0].tools?.map(({ name }) => name)).toEqual([
      "receipt.append",
    ]);
    expect(selected.stream).not.toHaveBeenCalled();
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
    expect(await inspectCheckpoint(f, "denied-receipt", threadId)).toMatchObject({
      status: "completed",
      model: acceptanceSelection,
      lastRunId: "denied-run",
      committed: { messages: history.messages, historyRevision: history.revision },
    });
    expect(await f.checkpoints.findUnfinished("custom-agent", threadId)).toBeNull();
    await host.close();
    expect(selected.state.released).toBe(true);
    expect(installed.state.released).toBe(true);
    expect(model.installations[0].released).toBe(true);
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
    expect(f.binding.dispose).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });
});

describe("generic session host configuration and authority", () => {
  it("runs custom no-plugin dialogue and cannot execute an uninstalled capability", async () => {
    const f = fixture();
    const host = await ownHost(f.options);
    const plainInput = { ...activation("plain", "plain-run"), threadId: "foreign-thread" };
    const plain = await host.run(plainInput);
    expect(await plain.completed).toMatchObject({
      status: "completed",
      identity: { threadId: "fixed-thread", queryId: "plain", runId: "plain-run" },
      output: [answer("plain completion").message],
    });
    expect(f.bind.mock.calls[0][0]).toEqual(f.agent.model);
    expect(f.generate.mock.calls[0][0].tools ?? []).toEqual([]);
    expect(f.generate.mock.calls[0][0].messages).toContainEqual({
      role: "system",
      content: [{ type: "text", text: f.agent.definition.instructions }],
    });
    expect((await f.history.read("foreign-thread")).messages).toEqual([]);
    expect(await inspectCheckpoint(f, "plain")).toMatchObject({
      definition: { id: "custom-definition", version: "3" },
      model: f.agent.model,
      maxSteps: 3,
      plugins: [],
      status: "completed",
    });

    f.generate.mockImplementation(async (request) => consumeCredit(request));
    const missing = await host.run(activation("missing", "missing-run"));
    expect((await missing.completed).status).toBe("completed");
    expect((await f.history.read("fixed-thread")).messages).toEqual(
      expect.arrayContaining([
        {
          role: "tool",
          content: [
            expect.objectContaining({ type: "tool-result", callId: "credit-1", isError: true }),
          ],
        },
      ]),
    );
    expect(f.authorizeTool).not.toHaveBeenCalled();
    expect(f.generate.mock.calls.every(([request]) => !request.tools?.length)).toBe(true);
  });

  it.each(["", "   ", null])("rejects invalid fixed thread %j before binding", async (threadId) => {
    const f = fixture();
    await expect(
      createSessionHost({
        ...f.options,
        threadId,
      } as unknown as SessionHostOptions),
    ).rejects.toMatchObject({ code: "HOST_OPTIONS_INVALID" });
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.binding.stored).toBeUndefined();
  });

  it.each(["binding", "authorizeTool", "models", "history", "checkpoints"] as const)(
    "rejects missing %s before plugin or model acquisition",
    async (missing) => {
      const f = fixture();
      const capability = ledger();
      if (missing !== "authorizeTool") f.agent.plugins.push(capability.plugin);
      const options =
        missing === "binding"
          ? { ...f.options, binding: undefined }
          : { ...f.options, services: { ...f.services, [missing]: undefined } };
      await expect(
        createSessionHost(options as unknown as SessionHostOptions),
      ).rejects.toMatchObject({
        code: "HOST_OPTIONS_INVALID",
      });
      expect(capability.setup).not.toHaveBeenCalled();
      expect(f.bind).not.toHaveBeenCalled();
      expect(f.borrowedDisposed).not.toHaveBeenCalled();
    },
  );

  it("keeps binding unpublished and snapshots all configuration before its await", async () => {
    const f = fixture();
    const capability = ledger();
    const unexpected = ledger();
    unexpected.plugin = { ...unexpected.plugin, id: "unexpected-ledger" };
    f.agent.plugins.push(capability.plugin);
    f.agent.maxSteps = 2;
    f.services.authorizeTool = approvalPolicy();
    f.generate.mockImplementation(async (request) => consumeCredit(request));
    const gate = Promise.withResolvers<void>();
    f.binding.beforeEnsure = () => gate.promise;
    let published = false;
    const pending = createSessionHost(f.options).then((host) => {
      published = true;
      cleanup.push(() => host.close());
      return host;
    });
    await f.binding.entered.promise;
    expect(published).toBe(false);
    expect(capability.setup).not.toHaveBeenCalled();
    expect(f.bind).not.toHaveBeenCalled();

    f.agent.definition.id = "drifted-definition";
    f.agent.definition.instructions = "Drifted instructions";
    f.agent.model.modelId = "drifted-model";
    f.agent.model.reasoningEffort = "different";
    f.agent.agentId = "drifted-agent";
    f.agent.maxSteps = 1;
    f.agent.signal = AbortSignal.abort("wrong creation signal");
    f.agent.plugins.splice(0, 1, unexpected.plugin);
    f.options.threadId = "drifted-thread";
    f.options.agent = { ...f.agent, plugins: [] };
    f.options.binding = {
      async ensure() {
        throw new Error("Wrong binding");
      },
    };
    f.services.models = {
      async create() {
        throw new Error("Wrong model factory");
      },
    };
    f.services.history = {
      async read() {
        throw new Error("Wrong history");
      },
      async append() {
        throw new Error("Wrong history");
      },
    };
    f.services.checkpoints = {
      async findUnfinished() {
        throw new Error("Wrong checkpoints");
      },
      async acquire() {
        throw new Error("Wrong checkpoints");
      },
      async save() {
        throw new Error("Wrong checkpoints");
      },
      async release() {
        throw new Error("Wrong checkpoints");
      },
    };
    f.services.authorizeTool = () => ({ type: "allow" });
    f.options.services = { ...f.services };
    gate.resolve();
    const host = await pending;
    const waiting = await (await host.run(activation())).completed;
    expect(waiting.status).toBe("waiting");
    expect(capability.state.balance).toBe(0);
    expect(unexpected.setup).not.toHaveBeenCalled();
    expect(f.bind.mock.calls[0][0]).toEqual({
      providerId: "deterministic",
      modelId: "selected-model",
      reasoningEffort: "balanced",
    });
    expect(f.generate.mock.calls[0][0].messages).toContainEqual({
      role: "system",
      content: [{ type: "text", text: "Use only chosen capabilities." }],
    });
    expect(await inspectCheckpoint(f)).toMatchObject({
      agentId: "custom-agent",
      threadId: "fixed-thread",
      maxSteps: 2,
      definition: { id: "custom-definition", version: "3" },
      plugins: [{ id: "test-ledger", version: "1" }],
    });
    if (waiting.status !== "waiting") throw new Error("Expected host approval.");
    const resumed = await host.resume({
      queryId: "query",
      runId: "approved",
      response: { type: "answer", interactionId: waiting.interaction.id, value: true },
    });
    expect((await resumed.completed).status).toBe("completed");
    expect(capability.state.balance).toBe(7);
  });

  it("rejects a binding mismatch without acquiring resources and leaves borrowed stores usable", async () => {
    const f = fixture();
    const capability = ledger();
    f.agent.plugins.push(capability.plugin);
    const gate = Promise.withResolvers<void>();
    f.binding.beforeEnsure = () => gate.promise;
    f.binding.stored = { incompatible: true };
    const pending = createSessionHost(f.options);
    const rejected = expect(pending).rejects.toMatchObject({ code: "FIXTURE_BINDING_MISMATCH" });
    await f.binding.entered.promise;
    expect(capability.setup).not.toHaveBeenCalled();
    expect(f.bind).not.toHaveBeenCalled();
    gate.resolve();
    await rejected;
    expect(capability.setup).not.toHaveBeenCalled();
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.binding.dispose).not.toHaveBeenCalled();
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
    expect((await f.history.read("fixed-thread")).revision).toBe(0);
    expect(await f.checkpoints.findUnfinished("custom-agent", "fixed-thread")).toBeNull();
  });
});

describe("generic session host approval and recovery", () => {
  it("persists waiting, closes without cancellation, and consumes only the matching answer in a new Run", async () => {
    const f = fixture();
    const capability = ledger();
    f.agent.plugins.push(capability.plugin);
    f.services.authorizeTool = approvalPolicy();
    f.generate.mockImplementation(async (request) => consumeCredit(request));
    const first = await ownHost(f.options);
    const runtimeInput = { ...activation(), threadId: "foreign-thread" };
    const waiting = await (await first.run(runtimeInput)).completed;
    if (waiting.status !== "waiting") throw new Error("Expected host approval.");
    expect(capability.state.balance).toBe(0);
    expect((await inspectCheckpoint(f))?.status).toBe("waiting");
    await first.close();
    expect((await inspectCheckpoint(f))?.status).toBe("waiting");
    expect(f.borrowedDisposed).not.toHaveBeenCalled();

    const resumedHost = await ownHost(f.options);
    const reused = await resumedHost.resume({ queryId: "query", runId: "run" });
    await expect(reused.completed).rejects.toMatchObject({ code: "RUN_ID_REUSED" });
    const stale = await resumedHost.resume({
      queryId: "query",
      runId: "wrong-answer",
      response: { type: "answer", interactionId: "not-pending", value: true },
    });
    await expect(stale.completed).rejects.toMatchObject({ code: "STALE_INTERACTION" });
    expect(capability.state.balance).toBe(0);
    const runtimeResume = {
      queryId: "query",
      runId: "approved",
      threadId: "foreign-thread",
      response: { type: "answer" as const, interactionId: waiting.interaction.id, value: true },
    };
    const resumed = await resumedHost.resume(runtimeResume);
    expect(await resumed.completed).toMatchObject({
      status: "completed",
      identity: { queryId: "query", runId: "approved", threadId: "fixed-thread" },
      output: expect.arrayContaining([answer("Observed balance:7").message]),
    });
    expect(capability.state.balance).toBe(7);
    expect((await f.history.read("foreign-thread")).messages).toEqual([]);
    expect((await inspectCheckpoint(f))?.status).toBe("completed");
    const duplicate = await resumedHost.resume({
      queryId: "query",
      runId: "duplicate",
      response: { type: "answer", interactionId: waiting.interaction.id, value: true },
    });
    await expect(duplicate.completed).rejects.toMatchObject({ code: "QUERY_TERMINAL" });
    expect(capability.state.balance).toBe(7);
  });

  it.each(["deny", "reject", "cancel"] as const)(
    "does not credit the ledger after %s",
    async (decision) => {
      const f = fixture();
      const capability = ledger();
      f.agent.plugins.push(capability.plugin);
      f.services.authorizeTool =
        decision === "deny"
          ? () => ({ type: "deny", reason: "Ledger access denied." })
          : approvalPolicy();
      f.generate.mockImplementation(async (request) => consumeCredit(request));
      const host = await ownHost(f.options);
      let result = await (await host.run(activation())).completed;
      if (decision !== "deny") {
        if (result.status !== "waiting") throw new Error("Expected host approval.");
        result = await (
          await host.resume({
            queryId: "query",
            runId: "declined",
            response: { type: decision, interactionId: result.interaction.id },
          })
        ).completed;
      }
      expect(result.status).toBe(decision === "cancel" ? "cancelled" : "completed");
      expect(capability.state.balance).toBe(0);
      const history = await f.history.read("fixed-thread");
      expect(JSON.stringify(history.messages)).not.toContain("balance:7");
    },
  );

  it("does not forward a runtime takeover or alternate thread to steal an active writer", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.generate.mockImplementation(async (_request, signal) => {
      entered.resolve();
      await release.promise;
      signal.throwIfAborted();
      return answer("writer completed");
    });
    const first = await ownHost(f.options);
    const active = await first.run(activation());
    await entered.promise;
    const observed = await f.checkpoints.acquire(checkpointKey(), "observer");
    if (observed.status !== "busy") throw new Error("Expected an active writer.");
    const second = await ownHost(f.options);
    cleanup.push(() => release.resolve());
    const runtimeResume = {
      queryId: "query",
      runId: "intruder",
      threadId: "foreign-thread",
      takeover: observed.lease,
    };
    const attempted = await second.resume(runtimeResume);
    await expect(attempted.completed).rejects.toMatchObject({ code: "WRITER_BUSY" });
    expect(await f.checkpoints.acquire(checkpointKey(), "observer-again")).toEqual(observed);
    release.resolve();
    expect((await active.completed).status).toBe("completed");
    expect((await inspectCheckpoint(f))?.lastRunId).toBe("run");
    expect((await f.history.read("foreign-thread")).messages).toEqual([]);
  });
});

describe("generic session host ownership and cancellation", () => {
  it("reclaims installed plugins when the model factory fails and preserves the original error", async () => {
    const f = fixture();
    const capability = ledger();
    f.agent.plugins.push(capability.plugin);
    const failure = new Error("model binding failed");
    f.bind.mockRejectedValue(failure);
    await expect(createSessionHost(f.options)).rejects.toBe(failure);
    expect(capability.disposed).toHaveBeenCalledTimes(1);
    expect(f.modelBindingDisposed).not.toHaveBeenCalled();
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
    expect(f.binding.dispose).not.toHaveBeenCalled();
    expect((await f.history.read("fixed-thread")).revision).toBe(0);
  });

  it("forwards user cancellation without closing the host or its borrowed services", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    f.generate.mockImplementation(async (_request, signal) => {
      const stopped = Promise.withResolvers<ModelResponse>();
      signal.addEventListener("abort", () => stopped.reject(signal.reason), { once: true });
      entered.resolve();
      return stopped.promise;
    });
    const host = await ownHost(f.options);
    const controller = new AbortController();
    const active = await host.run({ ...activation(), signal: controller.signal });
    await entered.promise;
    controller.abort("user cancelled");
    expect((await active.completed).status).toBe("cancelled");
    expect((await inspectCheckpoint(f))?.status).toBe("cancelled");
    expect(f.modelBindingDisposed).not.toHaveBeenCalled();
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
    f.generate.mockResolvedValue(answer("still available"));
    const next = await host.run(activation("next", "next-run"));
    expect((await next.completed).status).toBe("completed");
  });

  it.each(["before", "during"] as const)(
    "honors creation cancellation %s ensure without installing capabilities",
    async (when) => {
      const f = fixture();
      const capability = ledger();
      f.agent.plugins.push(capability.plugin);
      const controller = new AbortController();
      f.agent.signal = controller.signal;
      const gate = Promise.withResolvers<void>();
      f.binding.beforeEnsure = () => gate.promise;
      if (when === "before")
        controller.abort(new AgentError("TEST_CANCELLED", "Cancelled creation."));
      const pending = createSessionHost(f.options);
      const rejected = expect(pending).rejects.toMatchObject({ code: "TEST_CANCELLED" });
      if (when === "during") {
        await f.binding.entered.promise;
        controller.abort(new AgentError("TEST_CANCELLED", "Cancelled creation."));
      }
      gate.resolve();
      await rejected;
      expect(capability.setup).not.toHaveBeenCalled();
      expect(f.bind).not.toHaveBeenCalled();
      expect(f.binding.dispose).not.toHaveBeenCalled();
      expect(f.borrowedDisposed).not.toHaveBeenCalled();
    },
  );

  it("reclaims a late model binding and installed plugin when creation is cancelled", async () => {
    const f = fixture();
    const capability = ledger();
    f.agent.plugins.push(capability.plugin);
    const controller = new AbortController();
    f.agent.signal = controller.signal;
    const modelEntered = Promise.withResolvers<void>();
    const modelReady = Promise.withResolvers<void>();
    const originalBind = f.bind.getMockImplementation()!;
    f.bind.mockImplementation(async (selection, signal) => {
      const binding = await originalBind(selection, signal);
      modelEntered.resolve();
      await modelReady.promise;
      return binding;
    });
    const pending = createSessionHost(f.options);
    const rejected = expect(pending).rejects.toBeDefined();
    await modelEntered.promise;
    controller.abort("cancel creation");
    modelReady.resolve();
    await rejected;
    expect(capability.disposed).toHaveBeenCalledTimes(1);
    expect(f.modelBindingDisposed).toHaveBeenCalledTimes(1);
    expect(f.binding.dispose).not.toHaveBeenCalled();
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
    expect((await f.history.read("fixed-thread")).revision).toBe(0);
  });

  it("preserves setup and rollback failures without exposing private exception data in protocol projection", async () => {
    const f = fixture();
    const setupError = new Error("private provider credential");
    const cleanupError = new Error("private disposal detail");
    const disposed = vi.fn(async () => {
      throw cleanupError;
    });
    f.agent.plugins.push({
      id: "broken",
      version: "1",
      setup({ scope }) {
        scope.own({ dispose: disposed });
        throw setupError;
      },
    });
    const failure = await createSessionHost(f.options).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const retainedErrors = (error: unknown): unknown[] =>
      error instanceof AggregateError ? error.errors.flatMap(retainedErrors) : [error];
    expect(retainedErrors(failure)).toContain(setupError);
    expect(retainedErrors(failure)).toContain(cleanupError);
    expect(asProtocolError(failure)).toEqual({
      code: "EXECUTION_FAILED",
      message: "Agent execution failed",
    });
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
    expect(f.binding.dispose).not.toHaveBeenCalled();
    expect((await f.history.read("fixed-thread")).revision).toBe(0);
  });

  it("closes idempotently, synchronously refuses activation, and drains work before owned resources", async () => {
    const f = fixture();
    const capability = ledger();
    f.agent.plugins.push(capability.plugin);
    const entered = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    f.generate.mockImplementation(async (_request, signal) => {
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await stopped.promise;
      signal.throwIfAborted();
      return answer("not committed");
    });
    const host = await ownHost(f.options);
    cleanup.push(() => stopped.resolve());
    const active = await host.run(activation());
    await entered.promise;
    const closing = host.close();
    expect(host.close()).toBe(closing);
    expect(host.dispose()).toBe(closing);
    await expect(host.run(activation("after-close", "after-close"))).rejects.toMatchObject({
      code: "HOST_CLOSED",
    });
    await expect(host.resume({ queryId: "query", runId: "after-close" })).rejects.toMatchObject({
      code: "HOST_CLOSED",
    });
    await aborted.promise;
    expect(f.modelBindingDisposed).not.toHaveBeenCalled();
    expect(capability.disposed).not.toHaveBeenCalled();
    stopped.resolve();
    expect((await active.completed).status).toBe("interrupted");
    await closing;
    expect((await inspectCheckpoint(f))?.status).toBe("interrupted");
    expect(capability.disposed).toHaveBeenCalledTimes(1);
    expect(f.modelBindingDisposed).toHaveBeenCalledTimes(1);
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
    expect(f.binding.dispose).not.toHaveBeenCalled();
    expect((await f.history.read("fixed-thread")).messages).toEqual(activation().input);
  });
});
