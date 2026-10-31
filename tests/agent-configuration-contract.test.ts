import { describe, expect, it } from "vitest";
import {
  MIMO_REASONING_EFFORTS,
  MIMO_TOKEN_PLAN_CN_BASE_URL,
} from "../src/models/mimo-token-plan-cn-contract";
import {
  agentPreferencesSchema,
  discoverAgentModelsSchema,
  saveAgentVendorSchema,
  updateSearchCredentialSchema,
} from "../src/shared/agent-configuration";
import { agentSettingsSchema } from "../src/shared/agent-settings";
import { DEFAULT_AGENT_STEP_LIMITS } from "../src/shared/agent-step-limits";
import { getModelReasoningEfforts, getModelReasoningLabel } from "../src/shared/model-reasoning";

const vendor = {
  id: "vendor-a",
  kind: "custom",
  label: "Vendor A",
  protocol: "openai",
  baseURL: "https://models.example/v1",
  enabled: true,
  models: [
    {
      id: "model-a",
      name: "Model A",
      model: "api-model-a",
      openaiApiMode: "responses",
      enabled: true,
    },
  ],
};

describe("agent configuration management boundary", () => {
  it.each([
    ["gpt-5", ["minimal", "low", "medium", "high"]],
    ["gpt-5-mini-2025-08-07", ["minimal", "low", "medium", "high"]],
    ["gpt-5-nano", ["minimal", "low", "medium", "high"]],
    ["gpt-5.1", ["none", "low", "medium", "high"]],
    ["gpt-5.2-2025-12-11", ["none", "low", "medium", "high", "xhigh"]],
    ["gpt-5.4", ["none", "low", "medium", "high", "xhigh"]],
    ["gpt-5.5", ["none", "low", "medium", "high", "xhigh"]],
    ["o1", ["low", "medium", "high"]],
    ["o3-2025-04-16", ["low", "medium", "high"]],
    ["o3-mini", ["low", "medium", "high"]],
    ["o4-mini", ["low", "medium", "high"]],
  ] as const)("offers only supported Responses efforts for %s", (model, efforts) => {
    expect(
      getModelReasoningEfforts({ provider: "openai", model, openaiApiMode: "responses" }),
    ).toEqual(efforts);
  });

  it.each([
    { model: "gpt-4.1" },
    { model: "gpt-5-chat-latest" },
    { model: "gpt-5.2-pro" },
    { model: "gpt-5-codex" },
    { model: "gpt-5.9" },
    { model: "o1-mini" },
    { model: "mimo-v2.6-flash" },
    { model: "gpt-5.5", provider: "anthropic" },
    { model: "gpt-5.5", openaiApiMode: "chat-completions" },
    { model: "gpt-5.5", openaiApiMode: undefined },
    { model: "gpt-5.5", vendorKind: "mimo-token-plan-cn" },
  ])("does not claim reasoning override support for %j", (patch) => {
    expect(
      getModelReasoningEfforts({
        provider: "openai",
        openaiApiMode: "responses",
        ...patch,
      }),
    ).toEqual([]);
  });

  it("uses Chinese labels including the omitted default", () => {
    expect(
      [undefined, "", "none", "minimal", "low", "medium", "high", "xhigh"].map(
        getModelReasoningLabel,
      ),
    ).toEqual(["默认", "默认", "关闭", "极低", "低", "中", "高", "极高"]);
  });

  const mimoVendor = {
    ...vendor,
    kind: "mimo-token-plan-cn",
    baseURL: MIMO_TOKEN_PLAN_CN_BASE_URL,
  };

  it.each(MIMO_REASONING_EFFORTS)("preserves the exact MiMo effort %s", (reasoningEffort) => {
    const result = saveAgentVendorSchema.parse({
      vendor: {
        ...mimoVendor,
        models: [{ ...vendor.models[0], reasoningEffort }],
      },
      credential: { type: "keep" },
    });
    expect(result.vendor.models[0]!.reasoningEffort).toBe(reasoningEffort);
  });

  it("omits default effort and does not impose MiMo effort choices on other vendors", () => {
    const result = saveAgentVendorSchema.parse({
      vendor: mimoVendor,
      credential: { type: "keep" },
    });
    expect(result.vendor.models[0]).not.toHaveProperty("reasoningEffort");
    expect(
      saveAgentVendorSchema.parse({
        vendor: {
          ...vendor,
          models: [{ ...vendor.models[0], reasoningEffort: "provider-specific" }],
        },
        credential: { type: "keep" },
      }).vendor.models[0]!.reasoningEffort,
    ).toBe("provider-specific");
  });

  it.each([
    { protocol: "anthropic" },
    { baseURL: "https://api.xiaomimimo.com/v1" },
    { baseURL: "" },
    { models: [{ ...vendor.models[0], openaiApiMode: "chat-completions" }] },
    ...["", "default", "HIGH", "unknown"].map((reasoningEffort) => ({
      models: [{ ...vendor.models[0], reasoningEffort }],
    })),
  ])("rejects invalid MiMo connection/model combination %j", (patch) => {
    expect(
      saveAgentVendorSchema.safeParse({
        vendor: { ...mimoVendor, ...patch },
        credential: { type: "replace", apiKey: "must-not-save" },
      }).success,
    ).toBe(false);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects invalid shared output budget %s",
    (maxOutputTokens) => {
      expect(
        agentSettingsSchema.safeParse({
          vendors: [mimoVendor],
          gateway: { maxOutputTokens },
          stepLimits: DEFAULT_AGENT_STEP_LIMITS,
          executionStrategy: "AUTO",
          defaultTemplateId: "default",
        }).success,
      ).toBe(false);
    },
  );

  it("requires the native draft adapter to use the fixed CN OpenAI route", () => {
    const draft = {
      type: "draft",
      provider: "openai",
      baseURL: MIMO_TOKEN_PLAN_CN_BASE_URL,
      modelAdapter: "mimo-token-plan-cn",
      apiKey: "temporary-key",
    };
    expect(discoverAgentModelsSchema.parse(draft)).toEqual(draft);
    for (const patch of [
      { provider: "anthropic" },
      { baseURL: "https://api.xiaomimimo.com/v1" },
      { modelAdapter: "unknown-adapter" },
    ])
      expect(discoverAgentModelsSchema.safeParse({ ...draft, ...patch }).success).toBe(false);
    expect(
      discoverAgentModelsSchema.safeParse({
        type: "saved-vendor",
        vendorId: vendor.id,
        modelAdapter: "mimo-token-plan-cn",
      }).success,
    ).toBe(false);
  });

  it("does not let a client persist a credential or claim credential availability in vendor metadata", () => {
    for (const extra of [{ apiKey: "secret" }, { credentialConfigured: true }]) {
      expect(
        saveAgentVendorSchema.safeParse({
          vendor: { ...vendor, ...extra },
          credential: { type: "keep" },
        }).success,
      ).toBe(false);
    }
  });

  it("requires explicit, unambiguous credential actions", () => {
    for (const credential of [
      undefined,
      { type: "replace", apiKey: " " },
      { type: "keep", apiKey: "secret" },
      { type: "remove", apiKey: "secret" },
    ]) {
      expect(saveAgentVendorSchema.safeParse({ vendor, credential }).success).toBe(false);
    }
  });

  it("rejects credentials hidden inside execution preferences", () => {
    expect(
      agentPreferencesSchema.safeParse({
        gateway: { webSearchApiKey: "must-not-be-persisted" },
        stepLimits: { enabled: true, mainMaxSteps: 24, subMaxSteps: 16 },
        executionStrategy: "AUTO",
        defaultTemplateId: "default",
      }).success,
    ).toBe(false);
  });

  it("cannot combine a saved credential reference with a caller-chosen discovery destination", () => {
    expect(
      discoverAgentModelsSchema.safeParse({
        type: "saved-vendor",
        vendorId: "vendor-a",
        baseURL: "https://other.example/v1",
      }).success,
    ).toBe(false);
    expect(
      discoverAgentModelsSchema.safeParse({
        type: "draft",
        provider: "openai",
        baseURL: "https://other.example/v1",
        credentialBinding: { vendorId: "vendor-a" },
      }).success,
    ).toBe(false);
  });

  it.each([
    "http://remote.example/v1",
    "https://user:password@remote.example/v1",
    "file:///tmp/key",
  ])("rejects unsafe discovery route %s", (baseURL) => {
    expect(
      discoverAgentModelsSchema.safeParse({
        type: "draft",
        provider: "openai",
        baseURL,
        apiKey: "temporary-key",
      }).success,
    ).toBe(false);
  });

  it("permits loopback HTTP without permitting an empty search replacement", () => {
    const result = discoverAgentModelsSchema.parse({
      type: "draft",
      provider: "openai",
      baseURL: "http://127.0.0.1:8000/v1/",
      apiKey: "temporary-key",
    });
    expect(result).toMatchObject({ baseURL: "http://127.0.0.1:8000/v1" });
    expect(
      updateSearchCredentialSchema.safeParse({
        endpoint: "https://api.tavily.com/search",
        credential: { type: "replace", apiKey: " " },
      }).success,
    ).toBe(false);
  });
});
