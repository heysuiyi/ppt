import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModelProfile } from "@agent-harness/models/model-profiles";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentConfiguration, createAgentConfiguration } from "../src/main/agent-configuration";
import type { SafeStorageAdapter } from "../src/main/agent-configuration/internal/credential-store";
import {
  type DevelopmentSetupIO,
  ensureDevelopmentModel,
} from "../src/main/agent-host/development-setup";

const mimoProfile = getModelProfile("mimo-token-plan-cn");
if (mimoProfile?.endpoint?.kind !== "fixed")
  throw new Error("The MiMo fixed endpoint profile is required.");
const mimoBaseURL = mimoProfile.endpoint.url;
const mimoAdapterId = mimoProfile.adapterId;

import type { VendorConfiguration } from "../src/shared/agent-configuration";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function configuration(available = true) {
  const directory = await mkdtemp(join(tmpdir(), "development-setup-"));
  directories.push(directory);
  const safeStorage: SafeStorageAdapter = {
    decryptString: (encrypted) => encrypted.toString("utf8"),
    decryptStringAsync: async (encrypted) => ({
      result: encrypted.toString("utf8"),
      shouldReEncrypt: false,
    }),
    encryptString: (value) => Buffer.from(value),
    encryptStringAsync: async (value) => Buffer.from(value),
    getSelectedStorageBackend: () => "unknown",
    isAsyncEncryptionAvailable: async () => available,
    isEncryptionAvailable: () => available,
  };
  return createAgentConfiguration({ applicationDataRoot: directory, safeStorage, environment: {} });
}

function io(inputs: readonly string[], interactive = true) {
  let index = 0;
  const output: string[] = [];
  const readLine = vi.fn(async (prompt: string) => {
    output.push(prompt);
    return inputs[index++];
  });
  const value: DevelopmentSetupIO = {
    interactive,
    readLine,
    write: async (text) => {
      output.push(text);
    },
  };
  return { value, output, readLine };
}

function vendor(id: string): VendorConfiguration {
  return {
    id,
    kind: mimoAdapterId,
    label: `Connection ${id}`,
    protocol: "openai",
    baseURL: mimoBaseURL,
    enabled: true,
    models: [
      {
        id: `${id}-model`,
        name: `${id} chat`,
        model: "mimo-v2.6-pro",
        openaiApiMode: "responses",
        enabled: true,
      },
    ],
  };
}

async function saveConnection(config: AgentConfiguration, connection: VendorConfiguration) {
  await config.management.initialize();
  return config.management.saveVendor({
    vendor: connection,
    credential: { type: "replace", apiKey: "stored-secret" },
  });
}

describe("development model setup", () => {
  it("initializes an empty configuration, discovers before saving, and returns the persisted default ID", async () => {
    const config = await configuration();
    const discover = vi.spyOn(config.management, "listRemoteModels").mockResolvedValue({
      models: [
        { id: "future-model", supported: true },
        { id: "mimo-v2.6-pro", supported: false },
        { id: "mimo-v2.6-flash", supported: true },
      ],
    });
    const save = vi.spyOn(config.management, "saveVendor");
    const preferences = vi.spyOn(config.management, "saveCliPreferences");
    const input = io(["1", "temporary-plain-key", "1"]);
    const modelId = await ensureDevelopmentModel(config.management, input.value);
    const snapshot = (await config.management.getSnapshot())!;
    expect(modelId).toBe(snapshot.settings.cli?.defaultModelId);
    expect(snapshot.settings.vendors).toHaveLength(1);
    expect(snapshot.settings.vendors[0]).toMatchObject({
      kind: mimoAdapterId,
      protocol: "openai",
      baseURL: mimoBaseURL,
      models: [
        { id: modelId, model: "mimo-v2.6-flash", openaiApiMode: "responses", enabled: true },
      ],
    });
    expect(snapshot.settings.vendors[0]!.models[0]).not.toHaveProperty("reasoningEffort");
    expect(discover).toHaveBeenCalledWith({
      type: "draft",
      provider: "openai",
      baseURL: mimoBaseURL,
      modelAdapter: mimoAdapterId,
      apiKey: "temporary-plain-key",
    });
    expect(discover.mock.invocationCallOrder[0]).toBeLessThan(save.mock.invocationCallOrder[0]!);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(preferences.mock.invocationCallOrder[0]!);
    expect(input.output.join("")).not.toContain("temporary-plain-key");
    expect(input.readLine).toHaveBeenCalledTimes(3);
  });

  it("reuses a ready default without consuming input or discovering models", async () => {
    const config = await configuration();
    await saveConnection(config, vendor("saved"));
    await config.management.saveCliPreferences({ defaultModelId: "saved-model" });
    const discover = vi.spyOn(config.management, "listRemoteModels");
    const save = vi.spyOn(config.management, "saveVendor");
    const input = io([], false);
    await expect(ensureDevelopmentModel(config.management, input.value)).resolves.toBe(
      "saved-model",
    );
    expect(input.readLine).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(input.output).toEqual([]);
  });

  it("selects the connection before its model even with an existing default and preserves other models", async () => {
    const config = await configuration();
    const unsupported: VendorConfiguration = { ...vendor("unsupported"), kind: "custom" };
    await saveConnection(config, unsupported);
    await saveConnection(config, vendor("first"));
    const second = vendor("second");
    second.models.push({
      id: "other-model",
      name: "Other",
      model: "future-model",
      openaiApiMode: "responses",
      enabled: false,
    });
    await saveConnection(config, second);
    await config.management.saveCliPreferences({ defaultModelId: "first-model" });
    const discover = vi.spyOn(config.management, "listRemoteModels");
    const input = io(["2", "1"]);
    await expect(ensureDevelopmentModel(config.management, input.value, true)).resolves.toBe(
      "second-model",
    );
    expect(input.output[0]!.indexOf("Connection first")).toBeLessThan(
      input.output[0]!.indexOf("Connection second"),
    );
    expect(input.output[0]).not.toContain(unsupported.label);
    expect(input.readLine).toHaveBeenCalledTimes(2);
    expect(discover).not.toHaveBeenCalled();
    const snapshot = (await config.management.getSnapshot())!;
    expect(snapshot.settings.cli?.defaultModelId).toBe("second-model");
    expect(snapshot.settings.vendors.find((entry) => entry.id === "second")!.models).toEqual(
      second.models,
    );
    expect(snapshot.settings.vendors.find((entry) => entry.id === "first")).toEqual(
      vendor("first"),
    );
    expect(snapshot.settings.vendors.find((entry) => entry.id === "unsupported")).toEqual(
      unsupported,
    );
  });

  it("appends a discovered model to an existing connection without replacing its model table", async () => {
    const config = await configuration();
    const connection = vendor("saved");
    await saveConnection(config, connection);
    const discover = vi.spyOn(config.management, "listRemoteModels").mockResolvedValue({
      models: [{ id: "mimo-v2.6-flash", supported: true }],
    });
    const input = io(["1", "2", "1"]);
    const modelId = await ensureDevelopmentModel(config.management, input.value);
    expect(discover).toHaveBeenCalledWith({ type: "saved-vendor", vendorId: "saved" });
    const snapshot = (await config.management.getSnapshot())!;
    expect(snapshot.settings.vendors[0]!.models).toEqual([
      ...connection.models,
      expect.objectContaining({ id: modelId, model: "mimo-v2.6-flash" }),
    ]);
    expect(snapshot.settings.cli?.defaultModelId).toBe(modelId);
  });

  it("collects a missing connection key through the supplied IO before saving the selected model", async () => {
    const config = await configuration();
    await config.management.initialize();
    await config.management.saveVendor({ vendor: vendor("missing"), credential: { type: "keep" } });
    const input = io(["1", "new-connection-key", "1"]);
    await expect(ensureDevelopmentModel(config.management, input.value)).resolves.toBe(
      "missing-model",
    );
    expect((await config.management.getSnapshot())!.credentials.models).toEqual([
      { vendorId: "missing", configured: true },
    ]);
    expect(input.output.join("")).not.toContain("new-connection-key");
  });

  it.each([["0"], ["1", "0", "0"], []])(
    "cancels without saving for inputs %j",
    async (...inputs: string[]) => {
      const config = await configuration();
      const save = vi.spyOn(config.management, "saveVendor");
      const preferences = vi.spyOn(config.management, "saveCliPreferences");
      const discover = vi.spyOn(config.management, "listRemoteModels");
      await expect(
        ensureDevelopmentModel(config.management, io(inputs).value),
      ).resolves.toBeUndefined();
      expect(save).not.toHaveBeenCalled();
      expect(preferences).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
      expect((await config.management.getSnapshot())!.settings.vendors).toEqual([]);
    },
  );

  it("refuses noninteractive setup without reading stdin or discovering models", async () => {
    const config = await configuration();
    const discover = vi.spyOn(config.management, "listRemoteModels");
    const input = io(["1", "piped-prompt"], false);
    await expect(ensureDevelopmentModel(config.management, input.value)).rejects.toMatchObject({
      code: "CLI_MODEL_SETUP_FAILED",
    });
    expect(input.readLine).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });

  it("fails explicitly when credential storage is unavailable without consuming a key", async () => {
    const config = await configuration(false);
    const input = io(["1", "must-not-read"]);
    await expect(ensureDevelopmentModel(config.management, input.value)).rejects.toMatchObject({
      code: "CLI_MODEL_SETUP_FAILED",
    });
    expect(input.readLine).not.toHaveBeenCalled();
  });

  it("allows editing a key after discovery failure without exposing SDK errors or keys", async () => {
    const config = await configuration();
    const discover = vi
      .spyOn(config.management, "listRemoteModels")
      .mockRejectedValueOnce(new Error("SDK error contains rejected-secret"))
      .mockResolvedValueOnce({ models: [{ id: "mimo-v2.6-pro", supported: true }] });
    const input = io(["1", "rejected-secret", "2", "replacement-secret", "1"]);
    const modelId = await ensureDevelopmentModel(config.management, input.value);
    expect(modelId).toBe((await config.management.getSnapshot())!.settings.cli?.defaultModelId);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(discover.mock.calls[1]![0]).toMatchObject({
      type: "draft",
      apiKey: "replacement-secret",
    });
    expect(input.output.join("")).not.toContain("rejected-secret");
    expect(input.output.join("")).not.toContain("replacement-secret");
    expect(input.output.join("")).not.toContain("SDK error");
  });

  it("does not save a default or expose secrets when saving the connection fails", async () => {
    const config = await configuration();
    vi.spyOn(config.management, "listRemoteModels").mockResolvedValue({
      models: [{ id: "mimo-v2.6-pro", supported: true }],
    });
    vi.spyOn(config.management, "saveVendor").mockRejectedValue(
      new Error("SDK failure includes unsaved-secret"),
    );
    const preferences = vi.spyOn(config.management, "saveCliPreferences");
    const input = io(["1", "unsaved-secret", "1"]);
    let failure: unknown;
    try {
      await ensureDevelopmentModel(config.management, input.value);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "CLI_MODEL_SETUP_FAILED" });
    expect(String(failure)).not.toContain("unsaved-secret");
    expect(input.output.join("")).not.toContain("unsaved-secret");
    expect(preferences).not.toHaveBeenCalled();
    expect((await config.management.getSnapshot())!.settings.vendors).toEqual([]);
  });

  it("does not report completion if saving the default fails after the connection is saved", async () => {
    const config = await configuration();
    await saveConnection(config, vendor("saved"));
    vi.spyOn(config.management, "saveCliPreferences").mockRejectedValue(
      new Error("sensitive-storage-details"),
    );
    const input = io(["1", "1"]);
    let failure: unknown;
    try {
      await ensureDevelopmentModel(config.management, input.value);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "CLI_MODEL_SETUP_FAILED" });
    expect(String(failure)).not.toContain("sensitive-storage-details");
    expect((await config.management.getSnapshot())!.settings.cli?.defaultModelId).toBeUndefined();
    expect(input.readLine).toHaveBeenCalledTimes(2);
  });
});
