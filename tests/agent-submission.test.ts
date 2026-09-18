import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptAgentRequest } from "../src/main/agent/submit-agent-request";
import { AgentSettingsStore, resolveConfiguredModel } from "../src/main/agent-settings-store";
import { FileSessionStore } from "../src/main/session-store";
import { agentSettingsSchema } from "../src/shared/agent-settings";
import { DEFAULT_AGENT_STEP_LIMITS } from "../src/shared/agent-step-limits";
import { type SubmitAgentRequest, submitAgentRequestSchema } from "../src/shared/ipc";
import { APPLICATION_DEFAULT_TEMPLATE_ID } from "../src/shared/template-protocol";

const settings = agentSettingsSchema.parse({
  vendors: [
    {
      id: "vendor",
      kind: "custom",
      label: "Test",
      protocol: "openai",
      baseURL: "https://example.com/v1",
      enabled: true,
      models: [
        {
          id: "configured-model",
          name: "Test",
          model: "remote-model",
          openaiApiMode: "responses",
          enabled: true,
        },
      ],
    },
  ],
  gateway: {},
  stepLimits: DEFAULT_AGENT_STEP_LIMITS,
  executionStrategy: "REQUEST_APPROVAL",
  defaultTemplateId: APPLICATION_DEFAULT_TEMPLATE_ID,
});
const directories: string[] = [];
const stores: FileSessionStore[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "agent-submission-"));
  directories.push(directory);
  const store = new FileSessionStore(
    join(directory, "conversations.sqlite"),
    join(directory, "projects"),
  );
  stores.push(store);
  await store.initialize();
  return { store, directory };
}
function request(patch: Partial<SubmitAgentRequest> = {}): SubmitAgentRequest {
  return submitAgentRequestSchema.parse({
    requestId: crypto.randomUUID(),
    userMessageId: crypto.randomUUID(),
    assistantMessageId: crypto.randomUUID(),
    target: { type: "new-session" },
    prompt: "创建演示文稿",
    modelId: "configured-model",
    action: { type: "message" },
    ...patch,
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Main-owned Agent submission", () => {
  it("rejects execution configuration smuggled through the submit contract", () => {
    expect(() =>
      submitAgentRequestSchema.parse({ ...request(), gatewayConfig: { timeoutMs: 1 } }),
    ).toThrow();
    expect(() =>
      submitAgentRequestSchema.parse({
        ...request(),
        model: { baseURL: "https://other.example.com" },
      }),
    ).toThrow();
  });

  it("migrates once, persists settings and resolves model identity in Main", async () => {
    const { directory } = await fixture();
    const path = join(directory, "settings.json");
    const config = new AgentSettingsStore(path);
    expect(await config.get()).toBeUndefined();
    await config.save(settings, true);
    const changed = { ...settings, stepLimits: { ...settings.stepLimits, mainMaxSteps: 9 } };
    await config.save(changed);
    expect(await new AgentSettingsStore(path).save(settings, true)).toEqual(changed);
    expect(resolveConfiguredModel((await config.get())!, "configured-model")).toMatchObject({
      configurationId: "configured-model",
      vendorId: "vendor",
      model: "remote-model",
      baseURL: "https://example.com/v1",
    });
    expect(await readFile(path, "utf8")).not.toContain("apiKey");
    expect(() =>
      config.save({ ...settings, vendors: [{ ...settings.vendors[0], apiKey: "secret" }] }),
    ).toThrow();
  });

  it("rejects unknown or disabled model IDs before creating a session", async () => {
    const { store } = await fixture();
    await expect(
      acceptAgentRequest(store, settings, request({ modelId: "missing" })),
    ).rejects.toThrow("does not exist");
    const disabled = structuredClone(settings);
    disabled.vendors[0].enabled = false;
    await expect(acceptAgentRequest(store, disabled, request())).rejects.toThrow("disabled");
    expect(store.getBootstrap().sessions).toHaveLength(0);
  });

  it("omits a disabled optional fallback while retaining the selected model", async () => {
    const { store } = await fixture();
    const config = structuredClone(settings);
    config.vendors[0].models.push({
      ...config.vendors[0].models[0],
      id: "fallback",
      enabled: false,
    });
    config.gateway.fallbackModelId = "fallback";
    const admitted = await acceptAgentRequest(store, config, request());
    expect(admitted.model.configurationId).toBe("configured-model");
    expect(admitted.services.fallbackModel).toBeUndefined();
  });

  it("does not register a new session when its first admission transaction fails", async () => {
    const { store } = await fixture();
    vi.spyOn(store.conversationDatabase, "beginRun").mockImplementation(() => {
      throw new Error("write failed");
    });
    await expect(acceptAgentRequest(store, settings, request())).rejects.toThrow("write failed");
    expect(store.getBootstrap().sessions).toEqual([]);
    expect(store.conversationDatabase.loadState().sessions).toEqual([]);
  });

  it("creates the session and accepts only one copy of its input and run", async () => {
    const { store } = await fixture();
    const command = request();
    const admitted = await acceptAgentRequest(store, settings, command);
    expect(admitted.history).toEqual([]);
    expect(admitted.model.model).toBe("remote-model");
    expect(admitted.services).not.toHaveProperty("fallbackModelId");
    expect(store.getSession(admitted.sessionId).messages.map((item) => item.id)).toEqual([
      command.userMessageId,
      command.assistantMessageId,
    ]);
    await expect(acceptAgentRequest(store, settings, command)).rejects.toThrow(
      "already been accepted",
    );
    expect(store.getBootstrap().sessions).toHaveLength(1);
    expect(store.conversationDatabase.interruptRunningRuns()).toContain(command.requestId);
  });

  it("rolls back both messages and run when admission persistence fails", async () => {
    const { store } = await fixture();
    const state = await store.createSession();
    const sessionId = state.activeSession!.session.id;
    const command = request({ target: { type: "session", sessionId } });
    const original = store.conversationDatabase.beginRun.bind(store.conversationDatabase);
    vi.spyOn(store.conversationDatabase, "beginRun").mockImplementation((input) => {
      original(input);
      throw new Error("disk failed");
    });
    await expect(acceptAgentRequest(store, settings, command)).rejects.toThrow("disk failed");
    expect(store.getSession(sessionId).messages).toEqual([]);
    expect(store.conversationDatabase.loadState().sessions[0].messages).toEqual([]);
    expect(store.conversationDatabase.hasRun(command.requestId)).toBe(false);
  });

  it("resumes only the current durable question and rejects stale answers", async () => {
    const { store } = await fixture();
    const first = request();
    const admitted = await acceptAgentRequest(store, settings, first);
    store.conversationDatabase.saveServiceThread(first.requestId, {
      version: 1,
      threadId: first.requestId,
      status: "waiting_user",
      messages: [],
      executionStrategy: "REQUEST_APPROVAL",
      updatedAt: new Date().toISOString(),
    });
    await store.finalizeAgentRunMessage(admitted.sessionId, first.requestId, {
      status: "waiting-user",
      message: "受众是谁？",
      threadId: first.requestId,
    });
    const answer = request({
      target: { type: "session", sessionId: admitted.sessionId },
      action: { type: "answer", questionRunId: first.requestId, displayContent: "管理层" },
      prompt: "面向管理层",
    });
    const next = await acceptAgentRequest(store, settings, answer);
    expect(next.threadId).toBe(first.requestId);
    expect(store.getSession(admitted.sessionId).messages.at(-2)?.content).toBe("管理层");
    expect(store.getSession(admitted.sessionId).messages[1].runStatus).toBe("completed");
    await expect(
      acceptAgentRequest(store, settings, { ...answer, requestId: crypto.randomUUID() }),
    ).rejects.toThrow("no longer awaiting");
  });

  it("branches an edit in Main without resuming the old waiting Query", async () => {
    const { store } = await fixture();
    const first = request();
    const admitted = await acceptAgentRequest(store, settings, first);
    store.conversationDatabase.saveServiceThread(first.requestId, {
      version: 1,
      threadId: first.requestId,
      status: "waiting_user",
      messages: [],
      executionStrategy: "REQUEST_APPROVAL",
      updatedAt: new Date().toISOString(),
    });
    const edit = request({
      target: { type: "session", sessionId: admitted.sessionId },
      action: { type: "edit", messageId: first.userMessageId },
      prompt: "修改后的目标",
    });
    const next = await acceptAgentRequest(store, settings, edit);
    expect(next.threadId).toBeUndefined();
    expect(next.history).toEqual([]);
    expect(store.getSession(admitted.sessionId).messages.map((item) => item.id)).toEqual([
      edit.userMessageId,
      edit.assistantMessageId,
    ]);
  });
});
