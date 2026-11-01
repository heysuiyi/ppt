import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getModelProfile } from "@agent-harness/models/model-profiles";
import { app, safeStorage } from "electron";

const mimoProfile = getModelProfile("mimo-token-plan-cn");
if (mimoProfile?.endpoint?.kind !== "fixed")
  throw new Error("The MiMo fixed endpoint profile is required.");
const mimoBaseURL = mimoProfile.endpoint.url;

// 只在测试入口替换 transport；生产 provider 的固定地址与 SDK 均保持原样。
const endpoint = process.env.MIMO_TEST_HTTP_ENDPOINT;
const root = process.env.AGENT_PPT_DATA_DIR;
if (!endpoint || !root) throw new Error("Isolated native integration environment required");
const transport = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!url.href.startsWith(`${mimoBaseURL}/`))
    throw new Error("Unexpected native integration destination");
  const target = endpoint + url.href.slice(mimoBaseURL.length);
  return transport(input instanceof Request ? new Request(target, input) : target, init);
};
// Load the host only after interception: external SDK modules may capture global fetch on import.
const { createAgentConfiguration } = await import("../../src/main/agent-configuration");
const { createSqliteAgentStores } = await import("../../src/main/agent-host/sqlite-agent-stores");
const mode = process.argv[2];
if (["seed", "inspect", "set-effort", "set-budget", "rotate-key"].includes(mode)) {
  app.setName("agent-ppt");
  mkdirSync(join(root, "electron"), { recursive: true });
  app.setPath("userData", join(root, "electron"));
  void app.whenReady().then(async () => {
    try {
      if (mode === "seed") {
        const configuration = createAgentConfiguration({
          applicationDataRoot: root,
          safeStorage,
          environment: {},
        });
        const vendor = {
          id: "mimo-integration",
          kind: "mimo-token-plan-cn" as const,
          label: "MiMo isolated integration",
          protocol: "openai" as const,
          baseURL: mimoBaseURL,
          enabled: true,
          models: [
            {
              id: "mimo-configured",
              name: "MiMo Flash",
              model: "mimo-v2.6-flash",
              enabled: true,
              openaiApiMode: "responses" as const,
              reasoningEffort: "high",
            },
          ],
        };
        await configuration.management.initialize({
          vendors: [vendor],
          gateway: { timeoutMs: 5000, maxOutputTokens: 1024 },
          stepLimits: { enabled: true, mainMaxSteps: 4, subMaxSteps: 2 },
          executionStrategy: "REQUEST_APPROVAL",
          defaultTemplateId: "builtin/swiss-minimal",
          cli: { defaultModelId: "mimo-configured" },
        });
        await configuration.management.saveVendor({
          vendor,
          credential: { type: "replace", apiKey: "tp-isolated-native-integration" },
        });
        const result = await configuration.management.listRemoteModels({
          type: "saved-vendor",
          vendorId: vendor.id,
        });
        console.log(
          JSON.stringify({ type: "seeded", models: result.models.map((model) => model.id) }),
        );
      } else if (mode === "set-effort" || mode === "set-budget" || mode === "rotate-key") {
        const configuration = createAgentConfiguration({
          applicationDataRoot: root,
          safeStorage,
          environment: {},
        });
        const snapshot = await configuration.management.getSnapshot();
        if (!snapshot) throw new Error("Expected saved configuration");
        if (mode === "set-effort") {
          const vendor = snapshot.settings.vendors[0]!;
          await configuration.management.saveVendor({
            vendor: {
              ...vendor,
              models: vendor.models.map((model) => ({
                ...model,
                reasoningEffort: process.argv[3],
              })),
            },
            credential: { type: "keep" },
          });
        } else if (mode === "rotate-key") {
          await configuration.management.saveVendor({
            vendor: snapshot.settings.vendors[0]!,
            credential: { type: "replace", apiKey: "tp-rotated-native-integration" },
          });
        } else {
          const { vendors: _vendors, cli: _cli, ...preferences } = snapshot.settings;
          await configuration.management.savePreferences({
            ...preferences,
            gateway: { ...preferences.gateway, maxOutputTokens: Number(process.argv[3]) },
          });
        }
        console.log(JSON.stringify({ type: "configuration.updated" }));
      } else {
        const stores = createSqliteAgentStores(join(root, "agent-development.sqlite"));
        try {
          const queryId = process.argv[3];
          const key = { agentId: "development-agent", threadId: process.argv[4], queryId };
          const acquired = await stores.checkpoints.acquire(key, "integration-inspector");
          if (acquired.status !== "acquired") throw new Error("Execution lease not released");
          try {
            const checkpoint = acquired.checkpoint;
            const history = await stores.history.read(key.threadId);
            console.log(
              JSON.stringify({
                type: "checkpoint",
                leaseReleased: true,
                status: checkpoint?.status,
                runId: checkpoint?.lastRunId,
                model: checkpoint?.model,
                replay: history.messages
                  .filter((message) => message.role === "assistant")
                  .map((message) => message.replayState?.format),
              }),
            );
          } finally {
            await stores.checkpoints.release(acquired.lease);
          }
        } finally {
          await stores.dispose();
        }
      }
      app.exit(0);
    } catch {
      console.error("Native integration fixture failed");
      app.exit(1);
    }
  });
} else {
  // 动态导入实际开发入口，不复制其执行、审批或关闭机制。
  void import("../../src/main/agent-host/development-runner");
}
