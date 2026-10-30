import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import { createAgentConfiguration } from "../../src/main/agent-configuration";

const root = process.env.AGENT_PPT_DATA_DIR;
const endpoint = process.env.AGENT_DEV_TEST_ENDPOINT;
const apiKey = process.env.AGENT_DEV_TEST_KEY;
if (!root || !endpoint || !apiKey)
  throw new Error("Isolated integration configuration is required.");
app.setName("agent-ppt");
mkdirSync(join(root, "electron"), { recursive: true });
app.setPath("userData", join(root, "electron"));
// 与开发入口一样，先完成 ESM 加载，再等待 Electron 就绪。
void app.whenReady().then(async () => {
  try {
    const configuration = createAgentConfiguration({
      applicationDataRoot: root,
      safeStorage,
      environment: {},
    });
    const vendor = {
      id: "integration",
      kind: "custom" as const,
      label: "Isolated integration endpoint",
      protocol: "openai" as const,
      baseURL: endpoint,
      enabled: true,
      models: [
        {
          id: "integration-configured",
          name: "Integration",
          model: "integration-remote",
          enabled: true,
          openaiApiMode: "chat-completions" as const,
        },
      ],
    };
    await configuration.management.initialize({
      vendors: [vendor],
      gateway: { timeoutMs: 5000, maxOutputTokens: 1024 },
      stepLimits: { enabled: true, mainMaxSteps: 4, subMaxSteps: 2 },
      executionStrategy: "REQUEST_APPROVAL",
      defaultTemplateId: "builtin/swiss-minimal",
    });
    const snapshot = await configuration.management.saveVendor({
      vendor,
      credential: { type: "replace", apiKey },
    });
    const written = Promise.withResolvers<void>();
    process.stdout.write(
      `${JSON.stringify({ type: "seeded", configured: snapshot.credentials.models[0]?.configured })}\n`,
      (error) => (error ? written.reject(error) : written.resolve()),
    );
    await written.promise;
    app.exit(0);
  } catch {
    console.error("Isolated safeStorage integration setup failed.");
    app.exit(1);
  }
});
