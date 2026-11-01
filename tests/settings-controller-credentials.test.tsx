// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppBootstrapSnapshot } from "../app/renderer/src/app/appBootstrap";
import { useSettingsController } from "../app/renderer/src/app/useSettingsController";
import type {
  AgentConfigurationSnapshot,
  SaveAgentVendorRequest,
} from "../src/shared/agent-configuration";
import { resolveAgentGatewayPreferences } from "../src/shared/agent-gateway-config";
import { DEFAULT_AGENT_STEP_LIMITS } from "../src/shared/agent-step-limits";
import { APPLICATION_DEFAULT_TEMPLATE_ID } from "../src/shared/template-protocol";

function snapshot(configured = true): AgentConfigurationSnapshot {
  return {
    settings: {
      vendors: [
        {
          id: "vendor-one",
          kind: "custom",
          label: "Vendor One",
          protocol: "openai",
          baseURL: "https://old.example.com/v1",
          enabled: true,
          models: [
            {
              id: "model-one",
              name: "Model One",
              model: "model-one",
              openaiApiMode: "responses",
              enabled: true,
              pricing: null,
            },
          ],
        },
      ],
      gateway: resolveAgentGatewayPreferences(),
      stepLimits: DEFAULT_AGENT_STEP_LIMITS,
      executionStrategy: "REQUEST_APPROVAL",
      defaultTemplateId: APPLICATION_DEFAULT_TEMPLATE_ID,
    },
    credentials: {
      storage: { state: "secure", backend: "unknown" },
      models: [{ vendorId: "vendor-one", configured }],
      webSearchConfigured: false,
    },
  };
}

function bootstrap(): AppBootstrapSnapshot {
  const initial = snapshot();
  return {
    persistedUiSettings: {},
    initialColorScheme: "dark",
    initialComputedScheme: "dark",
    vendors: initial.settings.vendors,
    models: [],
    selectedModelId: "model-one",
    agentStepLimits: initial.settings.stepLimits,
    agentGatewayPreferences: initial.settings.gateway,
    credentials: initial.credentials,
    credentialReentryRequired: false,
  };
}

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    getAgentConfiguration: vi.fn().mockResolvedValue(snapshot()),
    saveAgentVendor: vi.fn().mockResolvedValue(snapshot()),
    deleteAgentVendor: vi.fn().mockResolvedValue(snapshot()),
    saveAgentPreferences: vi.fn().mockImplementation(async (preferences) => ({
      ...snapshot(),
      settings: { ...snapshot().settings, ...preferences },
    })),
    updateAgentSearchCredential: vi.fn().mockResolvedValue(snapshot()),
    ...overrides,
  };
  Object.defineProperty(window, "desktopApi", { configurable: true, value: api });
  return api;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("configuration-backed settings controller", () => {
  it("keeps request intensity per model without changing catalog configuration", async () => {
    const api = installApi();
    const initial = bootstrap();
    const vendor = initial.vendors[0]!;
    vendor.models[0]!.model = "gpt-5.2";
    vendor.models.push({ ...vendor.models[0]!, id: "model-two", model: "gpt-5-mini" });
    const notify = vi.fn();
    const { result } = renderHook(() => useSettingsController(initial, undefined, notify));
    await act(async () => result.current.setReasoningEffort("xhigh"));
    expect(result.current.selectedReasoningEffort).toBe("xhigh");
    act(() => result.current.selectModel("model-two"));
    expect(result.current.selectedReasoningEffort).toBeUndefined();
    act(() => result.current.setReasoningEffort("xhigh"));
    expect(result.current.selectedReasoningEffort).toBeUndefined();
    act(() => result.current.setReasoningEffort("low"));
    expect(result.current.selectedReasoningEffort).toBe("low");
    act(() => result.current.selectModel("model-one"));
    expect(result.current.selectedReasoningEffort).toBe("xhigh");
    act(() => result.current.setReasoningEffort(undefined));
    expect(result.current.selectedReasoningEffort).toBeUndefined();
    expect(result.current.models.every((model) => model.reasoningEffort === undefined)).toBe(true);
    expect(api.saveAgentVendor).not.toHaveBeenCalled();
  });

  it("uses Main credential status and waits for the vendor commit before reporting success", async () => {
    const commit = deferred<AgentConfigurationSnapshot>();
    const saveAgentVendor = vi.fn().mockReturnValue(commit.promise);
    const api = installApi({ saveAgentVendor });
    const notify = vi.fn();
    const { result } = renderHook(() => useSettingsController(bootstrap(), undefined, notify));
    await waitFor(() => expect(result.current.enabledModels).toHaveLength(1));
    let saving!: Promise<boolean>;
    act(() => {
      saving = result.current.saveVendor({
        ...result.current.vendors[0]!,
        baseURL: "https://new.example.com/v1",
      });
    });
    await waitFor(() => expect(saveAgentVendor).toHaveBeenCalledTimes(1));
    expect(saveAgentVendor.mock.calls[0]![0]).toMatchObject({
      vendor: { id: "vendor-one", baseURL: "https://new.example.com/v1" },
      credential: { type: "keep" },
    });
    expect(saveAgentVendor.mock.calls[0]![0].vendor).not.toHaveProperty("credentialConfigured");
    expect(result.current.vendors[0]!.baseURL).toBe("https://old.example.com/v1");
    const committed = snapshot(false);
    committed.settings.vendors[0]!.baseURL = "https://new.example.com/v1";
    await act(async () => {
      commit.resolve(committed);
      expect(await saving).toBe(true);
    });
    expect(result.current.vendors[0]!.baseURL).toBe("https://new.example.com/v1");
    expect(result.current.enabledModels).toEqual([]);
    expect(api.saveAgentPreferences).not.toHaveBeenCalled();
  });

  it("retains catalog state when Main rejects a vendor save", async () => {
    installApi({ saveAgentVendor: vi.fn().mockRejectedValue(new Error("disk full")) });
    const notify = vi.fn();
    const { result } = renderHook(() => useSettingsController(bootstrap(), undefined, notify));
    await act(async () => {
      expect(
        await result.current.saveVendor(
          { ...result.current.vendors[0]!, label: "Changed" },
          "new-secret",
        ),
      ).toBe(false);
    });
    expect(result.current.vendors[0]!.label).toBe("Vendor One");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  });

  it("ignores a stale status snapshot after a successful credential replacement", async () => {
    const refresh = deferred<AgentConfigurationSnapshot>();
    const saveAgentVendor = vi.fn().mockResolvedValue(snapshot(true));
    installApi({
      getAgentConfiguration: vi.fn().mockReturnValue(refresh.promise),
      saveAgentVendor,
    });
    const notify = vi.fn();
    const { result } = renderHook(() => useSettingsController(bootstrap(), undefined, notify));
    await act(async () => {
      expect(await result.current.saveVendor(result.current.vendors[0]!, "new-secret")).toBe(true);
    });
    expect(saveAgentVendor.mock.calls[0]![0].credential).toEqual({
      type: "replace",
      apiKey: "new-secret",
    });
    await act(async () => {
      refresh.resolve(snapshot(false));
      await refresh.promise;
    });
    expect(result.current.enabledModels).toHaveLength(1);
  });

  it("fails closed when the configuration snapshot cannot be read", async () => {
    installApi({ getAgentConfiguration: vi.fn().mockRejectedValue(new Error("corrupt store")) });
    const notify = vi.fn();
    const { result } = renderHook(() => useSettingsController(bootstrap(), undefined, notify));
    await waitFor(() => expect(result.current.enabledModels).toEqual([]));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("凭据状态读取失败"));
  });

  it("saves only preferences and does not overwrite a newer preference draft with an old snapshot", async () => {
    const first = deferred<AgentConfigurationSnapshot>();
    const saveAgentPreferences = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async (preferences) => ({
        ...snapshot(),
        settings: { ...snapshot().settings, ...preferences },
      }));
    const api = installApi({ saveAgentPreferences });
    const notify = vi.fn();
    const { result } = renderHook(() => useSettingsController(bootstrap(), undefined, notify));
    act(() =>
      result.current.setAgentStepLimits({ ...DEFAULT_AGENT_STEP_LIMITS, mainMaxSteps: 17 }),
    );
    await waitFor(() => expect(saveAgentPreferences).toHaveBeenCalledTimes(1));
    act(() =>
      result.current.setAgentStepLimits({ ...DEFAULT_AGENT_STEP_LIMITS, mainMaxSteps: 23 }),
    );
    await act(async () => {
      const old = snapshot();
      old.settings.stepLimits = { ...DEFAULT_AGENT_STEP_LIMITS, mainMaxSteps: 17 };
      first.resolve(old);
      await first.promise;
    });
    await waitFor(() => expect(result.current.saveStatus).toBe("saved"));
    expect(result.current.agentStepLimits.mainMaxSteps).toBe(23);
    expect(saveAgentPreferences).toHaveBeenCalledTimes(2);
    expect(saveAgentPreferences.mock.calls[0]![0]).not.toHaveProperty("vendors");
    expect(api.saveAgentVendor).not.toHaveBeenCalled();
  });

  it("commits a preference revert even while the previous edit is still saving", async () => {
    const first = deferred<AgentConfigurationSnapshot>();
    const saveAgentPreferences = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async (preferences) => ({
        ...snapshot(),
        settings: { ...snapshot().settings, ...preferences },
      }));
    installApi({ saveAgentPreferences });
    const notify = vi.fn();
    const { result } = renderHook(() => useSettingsController(bootstrap(), undefined, notify));
    act(() =>
      result.current.setAgentStepLimits({ ...DEFAULT_AGENT_STEP_LIMITS, mainMaxSteps: 17 }),
    );
    await waitFor(() => expect(saveAgentPreferences).toHaveBeenCalledTimes(1));
    act(() => result.current.setAgentStepLimits(DEFAULT_AGENT_STEP_LIMITS));
    await act(async () => {
      const old = snapshot();
      old.settings.stepLimits = { ...DEFAULT_AGENT_STEP_LIMITS, mainMaxSteps: 17 };
      first.resolve(old);
      await first.promise;
    });
    await waitFor(() => expect(saveAgentPreferences).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.saveStatus).toBe("saved"));
    expect(saveAgentPreferences.mock.calls[1]![0].stepLimits).toEqual(DEFAULT_AGENT_STEP_LIMITS);
    expect(result.current.agentStepLimits).toEqual(DEFAULT_AGENT_STEP_LIMITS);
  });

  it("uses explicit search credential actions and the returned status", async () => {
    const configured = snapshot();
    configured.credentials.webSearchConfigured = true;
    const updateAgentSearchCredential = vi
      .fn()
      .mockResolvedValueOnce(configured)
      .mockResolvedValueOnce(snapshot());
    installApi({ updateAgentSearchCredential });
    const notify = vi.fn();
    const { result } = renderHook(() => useSettingsController(bootstrap(), undefined, notify));
    await act(async () => {
      expect(await result.current.saveWebSearchCredential(" search-key ")).toBe(true);
    });
    expect(updateAgentSearchCredential.mock.calls[0]![0].credential).toEqual({
      type: "replace",
      apiKey: "search-key",
    });
    expect(result.current.webSearchCredentialConfigured).toBe(true);
    await act(async () => {
      expect(await result.current.deleteWebSearchCredential()).toBe(true);
    });
    expect(updateAgentSearchCredential.mock.calls[1]![0].credential).toEqual({ type: "remove" });
    expect(result.current.webSearchCredentialConfigured).toBe(false);
  });

  it("awaits Main when deleting a vendor and takes the committed catalog", async () => {
    const commit = deferred<AgentConfigurationSnapshot>();
    const deleteAgentVendor = vi.fn().mockReturnValue(commit.promise);
    const initial = bootstrap();
    initial.credentials!.models[0]!.configured = false;
    installApi({
      getAgentConfiguration: vi.fn().mockResolvedValue(snapshot(false)),
      deleteAgentVendor,
    });
    const notify = vi.fn();
    const { result } = renderHook(() => useSettingsController(initial, undefined, notify));
    let deleting!: Promise<boolean>;
    act(() => {
      deleting = result.current.deleteVendor("vendor-one");
    });
    await waitFor(() => expect(deleteAgentVendor).toHaveBeenCalledExactlyOnceWith("vendor-one"));
    expect(result.current.vendors).toHaveLength(1);
    const empty = snapshot(false);
    empty.settings.vendors = [];
    empty.credentials.models = [];
    await act(async () => {
      commit.resolve(empty);
      expect(await deleting).toBe(true);
    });
    expect(result.current.vendors).toEqual([]);
  });

  it("preserves both model toggles queued against the same vendor", async () => {
    const initial = snapshot();
    const firstModel = initial.settings.vendors[0]!.models[0]!;
    initial.settings.vendors[0]!.models = [
      firstModel,
      { ...firstModel, id: "model-two", name: "Model Two", model: "model-two" },
      { ...firstModel, id: "model-three", name: "Model Three", model: "model-three" },
    ];
    const initialBootstrap = {
      ...bootstrap(),
      vendors: initial.settings.vendors,
      credentials: initial.credentials,
    };
    const firstCommit = deferred<AgentConfigurationSnapshot>();
    const saveAgentVendor = vi
      .fn()
      .mockReturnValueOnce(firstCommit.promise)
      .mockImplementation(async ({ vendor }: SaveAgentVendorRequest) => ({
        ...initial,
        settings: { ...initial.settings, vendors: [vendor] },
      }));
    installApi({ getAgentConfiguration: vi.fn().mockResolvedValue(initial), saveAgentVendor });
    const notify = vi.fn();
    const { result } = renderHook(() => useSettingsController(initialBootstrap, undefined, notify));
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.setModelEnabled("model-one", false);
      second = result.current.setModelEnabled("model-two", false);
    });
    await waitFor(() => expect(saveAgentVendor).toHaveBeenCalledTimes(1));
    await act(async () => {
      firstCommit.resolve({
        ...initial,
        settings: {
          ...initial.settings,
          vendors: [
            {
              ...initial.settings.vendors[0]!,
              models: initial.settings.vendors[0]!.models.map((model) =>
                model.id === "model-one" ? { ...model, enabled: false } : model,
              ),
            },
          ],
        },
      });
      expect(await first).toBe(true);
      expect(await second).toBe(true);
    });
    expect(result.current.enabledModels.map((model) => model.id)).toEqual(["model-three"]);
    expect(result.current.vendors[0]!.models.map((model) => model.enabled)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("selects a remaining credential-configured model after deleting its vendor", async () => {
    const initial = snapshot();
    initial.settings.vendors.push({
      ...initial.settings.vendors[0]!,
      id: "vendor-two",
      label: "Vendor Two",
      models: [{ ...initial.settings.vendors[0]!.models[0]!, id: "model-two", model: "model-two" }],
    });
    initial.credentials.models.push({ vendorId: "vendor-two", configured: true });
    const committed: AgentConfigurationSnapshot = {
      settings: { ...initial.settings, vendors: [initial.settings.vendors[1]!] },
      credentials: {
        ...initial.credentials,
        models: [{ vendorId: "vendor-two", configured: true }],
      },
    };
    installApi({
      getAgentConfiguration: vi.fn().mockResolvedValue(initial),
      deleteAgentVendor: vi.fn().mockResolvedValue(committed),
    });
    const initialBootstrap = {
      ...bootstrap(),
      vendors: initial.settings.vendors,
      credentials: initial.credentials,
    };
    const notify = vi.fn();
    const { result } = renderHook(() => useSettingsController(initialBootstrap, undefined, notify));
    await act(async () => {
      expect(await result.current.deleteVendor("vendor-one")).toBe(true);
    });
    expect(result.current.selectedModelId).toBe("model-two");
    expect(result.current.selectedModel?.id).toBe("model-two");
  });
});
