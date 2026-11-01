import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getModelProfile } from "@agent-harness/models/model-profiles";
import { app, safeStorage } from "electron";

const mimoProfile = getModelProfile("mimo-token-plan-cn");
if (mimoProfile?.endpoint?.kind !== "fixed")
  throw new Error("The MiMo fixed endpoint profile is required.");
const mimoBaseURL = mimoProfile.endpoint.url;

const root = process.env.AGENT_PPT_DATA_DIR;
const endpoint = process.env.AGENT_DEV_TEST_ENDPOINT;
const apiKey = process.env.AGENT_DEV_TEST_KEY;
if (!root || !endpoint || !apiKey)
  throw new Error("Isolated integration configuration is required.");
const local = new URL(endpoint);
if (
  local.protocol !== "http:" ||
  local.hostname !== "127.0.0.1" ||
  !local.port ||
  local.pathname !== "/v1" ||
  local.search ||
  local.hash ||
  local.username ||
  local.password
)
  throw new Error("Isolated integration transport must use local HTTP.");
const native = new URL(mimoBaseURL);
const transport = globalThis.fetch;
// 测试专用且失败关闭：真实 SDK 只能将固定 CN Responses 请求转发至本地服务。
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (
    url.origin !== native.origin ||
    url.pathname !== `${native.pathname}/responses` ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Unexpected native integration destination.");
  const target = `${local.href}/responses`;
  return transport(input instanceof Request ? new Request(target, input) : target, {
    ...init,
    redirect: "error",
  });
};
// Load the host only after interception: external SDK modules may capture global fetch on import.
const { createAgentConfiguration } = await import("../../app/main/agent-configuration");
if (process.argv[2] === "seed") {
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
        kind: "mimo-token-plan-cn" as const,
        label: "Isolated native MiMo integration",
        protocol: "openai" as const,
        baseURL: mimoBaseURL,
        enabled: true,
        models: [
          {
            id: "integration-configured",
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
        cli: { defaultModelId: "integration-configured" },
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
} else {
  // 必须先安装本地 transport，再加载实际 runner；不复制执行、审批或关闭逻辑。
  void import("../../app/main/agent-host/development-runner");
}
