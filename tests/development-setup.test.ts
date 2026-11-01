import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentConfiguration } from "@agent-harness/configuration/configuration";
import type { VendorConfiguration } from "@agent-harness/configuration/configuration-contract";
import type { CredentialProtection } from "@agent-harness/configuration/credential-contract";
import { getModelProfile } from "@agent-harness/models/model-profiles";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalSetupIO } from "../cli/host/host-contract.js";
import { ensureConfiguredModel } from "../cli/host/model-setup.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const profile = getModelProfile("mimo-token-plan-cn")!;
if (profile.endpoint?.kind !== "fixed") throw new Error("Expected fixed MiMo profile");
const endpoint = profile.endpoint.url;

// A controlled protection port isolates configuration transactions; real OS
// encryption and terminal hidden echo are exercised by the CLI smoke separately.
function protection(secure = true): CredentialProtection {
  return {
    scheme: "electron-safe-storage",
    inspect: async () => ({ state: secure ? "secure" : "unavailable", backend: "unknown" }),
    encrypt: async (text) => Buffer.from(Buffer.from(text).toString("base64")),
    decrypt: async (value) => ({
      result: Buffer.from(Buffer.from(value).toString(), "base64").toString(),
      shouldReEncrypt: false,
    }),
  };
}
async function configuration(secure = true) {
  const root = await mkdtemp(join(tmpdir(), "cli-model-setup-"));
  roots.push(root);
  const port = protection(secure);
  const config = createAgentConfiguration({
    applicationDataRoot: root,
    credentialProtection: port,
    defaultTemplateId: "none",
    environment: {},
  });
  return { config, port };
}
function input(
  selections: readonly (string | undefined)[],
  secret: string | undefined = "controlled-key",
) {
  let index = 0;
  const io: TerminalSetupIO = {
    select: async () => selections[index++],
    secret: vi.fn(async () => secret),
    text: async () => undefined,
    notify: async () => {},
  };
  return io;
}
function vendor(id = "saved"): VendorConfiguration {
  return {
    id,
    kind: "mimo-token-plan-cn",
    label: "Configured MiMo",
    protocol: "openai",
    baseURL: endpoint,
    enabled: true,
    models: [
      {
        id: `${id}-model`,
        name: "Flash",
        model: "mimo-v2.6-flash",
        enabled: true,
        openaiApiMode: "responses",
      },
    ],
  };
}

describe("Node CLI secure model setup", () => {
  it("persists a discovered supported model and its bound credential as a reusable default", async () => {
    const { config, port } = await configuration();
    vi.spyOn(config.management, "listRemoteModels").mockResolvedValue({
      models: [
        { id: "unknown-future", supported: true },
        { id: "mimo-v2.6-flash", supported: true },
      ],
    });
    const io = input(["0", "0"]);
    const modelId = await ensureConfiguredModel(config.management, {
      ...io,
      protection: port,
      signal: new AbortController().signal,
    });
    const snapshot = (await config.management.getSnapshot())!;
    expect(snapshot.settings.cli?.defaultModelId).toBe(modelId);
    expect(snapshot.settings.vendors[0]?.models).toEqual([
      expect.objectContaining({ id: modelId, model: "mimo-v2.6-flash", enabled: true }),
    ]);
    expect(snapshot.credentials.models).toEqual([
      { vendorId: snapshot.settings.vendors[0]!.id, configured: true },
    ]);
    const plan = await config.runtime.loadExecutionPlan(modelId!);
    expect((await config.runtime.resolveRuntime(plan)).primary.apiKey).toBe("controlled-key");
  });

  it.each([
    ["1", "openai", "responses", "https://api.openai.com/v1"],
    ["2", "openai", "chat-completions", "https://compatible.example.test/v1"],
    ["3", "anthropic", "responses", "https://api.anthropic.com"],
  ] as const)(
    "saves protocol choice %s as a reusable native default",
    async (choice, protocol, mode, baseURL) => {
      const { config, port } = await configuration();
      vi.spyOn(config.management, "listRemoteModels").mockResolvedValue({
        models: [{ id: "compatible-conversation", supported: true }],
      });
      const modelId = await ensureConfiguredModel(config.management, {
        ...input([choice, "0"]),
        text: async () => baseURL,
        protection: port,
        signal: new AbortController().signal,
      });
      const snapshot = (await config.management.getSnapshot())!;
      expect(snapshot.settings.cli?.defaultModelId).toBe(modelId);
      const plan = await config.runtime.loadExecutionPlan(modelId!);
      expect((await config.runtime.resolveRuntime(plan)).primary).toMatchObject({
        provider: protocol,
        model: "compatible-conversation",
        ...(protocol === "openai" ? { openaiApiMode: mode } : {}),
        baseURL,
        apiKey: "controlled-key",
      });
    },
  );

  it("does not collect a key or save a vendor if OS protection is unavailable", async () => {
    const { config, port } = await configuration(false);
    const io = input(["0"]);
    await expect(
      ensureConfiguredModel(config.management, {
        ...io,
        protection: port,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "CLI_MODEL_SETUP_FAILED" });
    expect(io.secret).not.toHaveBeenCalled();
    expect((await config.management.getSnapshot())?.settings.vendors).toEqual([]);
  });

  it("abandoned discovery does not persist a transient key or change the default", async () => {
    const { config, port } = await configuration();
    vi.spyOn(config.management, "listRemoteModels").mockResolvedValue({
      models: [{ id: "mimo-v2.6-flash", supported: true }],
    });
    await expect(
      ensureConfiguredModel(config.management, {
        ...input(["0", undefined]),
        protection: port,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();
    const snapshot = (await config.management.getSnapshot())!;
    expect(snapshot.settings.vendors).toEqual([]);
    expect(snapshot.credentials.models).toEqual([]);
    expect(snapshot.settings.cli?.defaultModelId).toBeUndefined();
  });

  it("keeps an already configured default without asking for a secret or replacing other models", async () => {
    const { config, port } = await configuration();
    await config.management.initialize();
    const connection = vendor();
    connection.models.push({
      id: "disabled",
      name: "Other",
      model: "future",
      enabled: false,
      openaiApiMode: "responses",
    });
    await config.management.saveVendor({
      vendor: connection,
      credential: { type: "replace", apiKey: "saved-key" },
    });
    await config.management.saveCliPreferences({ defaultModelId: "saved-model" });
    const io = input([]);
    await expect(
      ensureConfiguredModel(config.management, {
        ...io,
        protection: port,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("saved-model");
    expect(io.secret).not.toHaveBeenCalled();
    expect((await config.management.getSnapshot())?.settings.vendors[0]?.models).toEqual(
      connection.models,
    );
  });

  it("rejects a copied execution plan rather than resolving its credential", async () => {
    const { config } = await configuration();
    await config.management.initialize();
    await config.management.saveVendor({
      vendor: vendor(),
      credential: { type: "replace", apiKey: "saved-key" },
    });
    const plan = await config.runtime.loadExecutionPlan("saved-model");
    await expect(config.runtime.resolveRuntime(structuredClone(plan))).rejects.toThrow();
    expect((await config.runtime.resolveRuntime(plan)).primary.apiKey).toBe("saved-key");
  });
});
