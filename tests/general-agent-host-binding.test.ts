import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelMessage } from "@agent-harness/core/model/model-contract";
import { afterEach, describe, expect, it } from "vitest";
import type { HostSessionBinding } from "../app/main/agent-host/host-session-binding";
import {
  createSqliteAgentStores,
  type SqliteAgentStores,
} from "../app/main/agent-host/sqlite-agent-stores";

const cleanup: Array<() => void | Promise<void>> = [];
const user: ModelMessage = { role: "user", content: [{ type: "text", text: "inspect" }] };

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "general-agent-binding-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "agent.sqlite");
}

function openStores(path: string): SqliteAgentStores {
  const stores = createSqliteAgentStores(path);
  cleanup.push(() => stores.dispose());
  return stores;
}

function binding(overrides: Partial<HostSessionBinding> = {}): HostSessionBinding {
  return {
    schemaVersion: 2,
    agentId: "development-agent",
    threadId: "thread",
    workspaceRoot: join(tmpdir(), "bound-workspace"),
    toolMode: "read-only",
    model: {
      providerId: "mimo-token-plan-cn",
      modelId: "mimo-v2.6-flash",
      reasoningEffort: "high",
    },
    connectionFingerprint: "a".repeat(64),
    definition: { id: "general", version: "1" },
    plugins: [{ id: "tools", version: "1" }],
    maxSteps: 12,
    ...overrides,
  };
}

const changedError = {
  name: "AgentError",
  code: "HOST_BINDING_CHANGED",
  message: "Host session binding has changed.",
};
const missingError = {
  name: "AgentError",
  code: "HOST_BINDING_MISSING",
  message: "Existing thread state has no host session binding.",
};

describe("persistent host session bindings", () => {
  it("reopens an identical binding and the history committed on the same stores", async () => {
    const path = databasePath();
    const first = openStores(path);
    const original = binding();
    expect(await first.bindings.read(original.threadId)).toBeNull();
    await first.bindings.ensure(original);
    await first.history.append(original.threadId, 0, [user], "batch");
    await first.dispose();

    const reopened = openStores(path);
    expect(await reopened.bindings.read(original.threadId)).toEqual(original);
    // JSON 字段顺序不构成配置变化；有绑定的历史允许恢复。
    await reopened.bindings.ensure({
      ...original,
      model: {
        reasoningEffort: "high",
        modelId: "mimo-v2.6-flash",
        providerId: "mimo-token-plan-cn",
      },
    });
    expect(await reopened.history.read(original.threadId)).toMatchObject({
      revision: 1,
      messages: [user],
    });
  });

  it("atomically verifies competing connections and preserves the first committed binding", async () => {
    const path = databasePath();
    const first = openStores(path);
    const second = openStores(path);
    const original = binding();
    const competing = binding({ workspaceRoot: join(tmpdir(), "another-workspace") });
    const results = await Promise.allSettled([
      first.bindings.ensure(original),
      second.bindings.ensure(competing),
    ]);
    expect(results[0]).toEqual({ status: "fulfilled", value: undefined });
    expect(results[1]).toMatchObject({ status: "rejected", reason: changedError });
    await Promise.all([first.bindings.ensure(original), second.bindings.ensure(original)]);
    expect(await second.bindings.read(original.threadId)).toEqual(original);
    await first.dispose();
    await second.dispose();
    const reopened = openStores(path);
    await expect(reopened.bindings.ensure(competing)).rejects.toMatchObject(changedError);
    expect(await reopened.bindings.read(original.threadId)).toEqual(original);
  });

  it("rejects every restore identity or execution boundary change without replacing the original", async () => {
    const stores = openStores(databasePath());
    const original = binding();
    await stores.bindings.ensure(original);
    const changes: Partial<HostSessionBinding>[] = [
      { agentId: "other-agent" },
      { workspaceRoot: join(tmpdir(), "private-workspace") },
      { toolMode: "read-write" },
      { model: { ...original.model, providerId: "other-provider" } },
      { model: { ...original.model, modelId: "other-model" } },
      { model: { ...original.model, reasoningEffort: "low" } },
      { model: { providerId: original.model.providerId, modelId: original.model.modelId } },
      { connectionFingerprint: "b".repeat(64) },
      { definition: { ...original.definition, id: "other-definition" } },
      { definition: { ...original.definition, version: "2" } },
      { plugins: [{ id: "other-plugin", version: "1" }] },
      { plugins: [{ id: "tools", version: "2" }] },
      { plugins: [] },
      { maxSteps: original.maxSteps + 1 },
    ];
    for (const change of changes) {
      await expect(stores.bindings.ensure(binding(change))).rejects.toMatchObject(changedError);
      expect(await stores.bindings.read(original.threadId)).toEqual(original);
    }
    await stores.bindings.ensure(binding({ threadId: "separate-thread", agentId: "other-agent" }));
    expect(await stores.bindings.read("separate-thread")).toMatchObject({ agentId: "other-agent" });
  });

  it("explicitly rejects a persisted legacy binding without migrating or replacing it", async () => {
    const path = databasePath();
    const first = openStores(path);
    await first.dispose();
    const database = new DatabaseSync(path);
    try {
      const { toolMode: _toolMode, ...fields } = binding();
      const legacy = {
        ...fields,
        schemaVersion: 1,
        definition: { id: "general-file-assistant", version: "1" },
        plugins: [{ id: "files", version: "1" }],
      };
      const payload = JSON.stringify(legacy);
      database
        .prepare("INSERT INTO general_agent_host_bindings (thread_id, payload) VALUES (?, ?)")
        .run("thread", payload);
      const reopened = openStores(path);
      const unsupported = {
        code: "HOST_BINDING_VERSION_UNSUPPORTED",
        message: "Host session binding version is unsupported; start a new thread.",
      };
      await expect(reopened.bindings.read("thread")).rejects.toMatchObject(unsupported);
      await expect(reopened.bindings.ensure(binding())).rejects.toMatchObject(unsupported);
      expect(
        database
          .prepare("SELECT payload FROM general_agent_host_bindings WHERE thread_id = ?")
          .get("thread"),
      ).toMatchObject({ payload });
    } finally {
      database.close();
    }
  });

  it("refuses adoption of unbound history, including an empty committed batch", async () => {
    const path = databasePath();
    const first = openStores(path);
    await first.history.append("thread", 0, [user], "old-history");
    await first.history.append("empty-thread", 0, [], "empty-history");
    await first.dispose();
    const reopened = openStores(path);
    for (const threadId of ["thread", "empty-thread"]) {
      await expect(reopened.bindings.ensure(binding({ threadId }))).rejects.toMatchObject(
        missingError,
      );
      expect(await reopened.bindings.read(threadId)).toBeNull();
    }
    expect(await reopened.history.read("thread")).toMatchObject({ messages: [user], revision: 1 });
    // 仅仅读取空历史不创建状态，不妨碍首次绑定。
    await reopened.history.read("new-thread");
    await reopened.bindings.ensure(binding({ threadId: "new-thread" }));
  });

  it("refuses even a released unbound checkpoint owned by another Agent", async () => {
    const path = databasePath();
    const first = openStores(path);
    const acquired = await first.checkpoints.acquire(
      { agentId: "old-agent", threadId: "thread", queryId: "old-query" },
      "old-owner",
    );
    if (acquired.status !== "acquired") throw new Error("Expected checkpoint acquisition.");
    await first.checkpoints.release(acquired.lease);
    await first.dispose();
    const reopened = openStores(path);
    await expect(reopened.bindings.ensure(binding())).rejects.toMatchObject(missingError);
    expect(await reopened.bindings.read("thread")).toBeNull();
    await reopened.bindings.ensure(binding({ threadId: "unrelated-thread" }));
  });

  it("detaches both the submitted binding and all returned nested values", async () => {
    const stores = openStores(databasePath());
    const supplied = binding();
    const original = structuredClone(supplied);
    const pending = stores.bindings.ensure(supplied);
    Object.assign(supplied.model, { modelId: "mutated-before-await" });
    Object.assign(supplied.definition, { version: "changed" });
    Object.assign(supplied.plugins[0], { id: "changed" });
    await pending;
    const read = await stores.bindings.read("thread");
    expect(read).toEqual(original);
    if (!read) throw new Error("Expected binding.");
    Object.assign(read, { maxSteps: 999 });
    Object.assign(read.model, { modelId: "mutated-read" });
    Object.assign(read.definition, { id: "mutated-read" });
    Object.assign(read.plugins[0], { version: "mutated-read" });
    expect(await stores.bindings.read("thread")).toEqual(original);
    await stores.bindings.ensure(original);
  });

  it("validates the full JSON boundary and never accepts credential or endpoint configuration", async () => {
    const stores = openStores(databasePath());
    const invalid: unknown[] = [
      null,
      {},
      binding({ agentId: " " }),
      binding({ threadId: "" }),
      binding({ workspaceRoot: " " }),
      binding({ toolMode: "write" as HostSessionBinding["toolMode"] }),
      binding({ connectionFingerprint: "" }),
      binding({ maxSteps: 0 }),
      binding({ maxSteps: -1 }),
      binding({ maxSteps: 1.5 }),
      binding({ maxSteps: Number.MAX_SAFE_INTEGER + 1 }),
      binding({ model: { providerId: "", modelId: "model" } }),
      binding({ model: { providerId: "provider", modelId: "" } }),
      binding({ model: { providerId: "provider", modelId: "model", reasoningEffort: "" } }),
      binding({ definition: { id: "definition", version: "" } }),
      binding({ plugins: [{ id: "", version: "1" }] }),
      { ...binding(), apiKey: "private-credential" },
      { ...binding(), endpoint: "https://private-host.invalid" },
      { ...binding(), model: { ...binding().model, apiKey: "private-credential" } },
      { ...binding(), model: { ...binding().model, endpoint: "https://private-host.invalid" } },
      {
        ...binding(),
        definition: { id: "definition", version: "1", apiKey: "private-credential" },
      },
      { ...binding(), plugins: [{ id: "files", version: "1", endpoint: "private-host" }] },
    ];
    for (const candidate of invalid) {
      await expect(stores.bindings.ensure(candidate as HostSessionBinding)).rejects.toMatchObject({
        code: "HOST_BINDING_INVALID",
        message: "Host session binding is invalid.",
      });
      expect(await stores.bindings.read("thread")).toBeNull();
    }
    const cyclic: Record<string, unknown> = { ...binding() };
    cyclic.self = cyclic;
    for (const candidate of [
      { ...binding(), maxSteps: Number.NaN },
      { ...binding(), model: { ...binding().model, reasoningEffort: undefined } },
      { ...binding(), definition: new Date() },
      cyclic,
    ]) {
      await expect(
        stores.bindings.ensure(candidate as unknown as HostSessionBinding),
      ).rejects.toMatchObject({
        code: "INVALID_PROTOCOL_VALUE",
      });
    }
    await stores.bindings.ensure(binding());
    expect(await stores.bindings.read("thread")).toEqual(binding());
  });

  it("borrows the stores lifecycle and rejects reads and ensures after idempotent disposal", async () => {
    const stores = openStores(databasePath());
    await stores.bindings.ensure(binding());
    await stores.dispose();
    await stores.dispose();
    await expect(stores.bindings.read("thread")).rejects.toMatchObject({ code: "store-disposed" });
    await expect(stores.bindings.ensure(binding())).rejects.toMatchObject({
      code: "store-disposed",
    });
    await expect(
      stores.bindings.ensure(null as unknown as HostSessionBinding),
    ).rejects.toMatchObject({
      code: "store-disposed",
    });
  });
});
