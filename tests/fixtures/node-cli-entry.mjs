import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getModelProfile } from "@agent-harness/models/model-profiles";

const profile = getModelProfile("mimo-token-plan-cn");
if (profile?.endpoint?.kind !== "fixed") throw new Error("Fixed MiMo profile required");
const root = process.env.CLI_TEST_DATA_DIR;
const endpoint = process.env.CLI_TEST_HTTP_ENDPOINT;
if (!root || !endpoint) throw new Error("An isolated CLI test environment is required");
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!url.href.startsWith(`${profile.endpoint.url}/`))
    throw new Error("Unexpected test destination");
  const target = endpoint + url.href.slice(profile.endpoint.url.length);
  return originalFetch(input instanceof Request ? new Request(target, input) : target, init);
};
// This test intentionally installs transport interception before loading SDKs.
const { createAgentConfiguration } = await import("@agent-harness/configuration/configuration");
const { createNodeCredentialProtection } = await import(
  "@agent-harness/configuration/node-credentials"
);
const { createNodeHost } = await import("../../cli/dist/host/node-host.js");
const { runCli } = await import("../../cli/dist/main.js");
const configuration = createAgentConfiguration({
  applicationDataRoot: root,
  credentialProtection: createNodeCredentialProtection(),
  defaultTemplateId: "none",
  environment: {},
});
const mode = process.argv[2];
if (mode === "seed") {
  const vendor = {
    id: "cli-integration",
    kind: "mimo-token-plan-cn",
    label: "Isolated MiMo",
    protocol: "openai",
    baseURL: profile.endpoint.url,
    enabled: true,
    models: [
      {
        id: "mimo-configured",
        name: "MiMo Flash",
        model: "mimo-v2.6-flash",
        enabled: true,
        openaiApiMode: "responses",
        reasoningEffort: "high",
      },
    ],
  };
  await configuration.management.initialize({
    vendors: [vendor],
    gateway: { timeoutMs: 5000, maxOutputTokens: 1024 },
    stepLimits: { enabled: true, mainMaxSteps: 6, subMaxSteps: 2 },
    executionStrategy: "REQUEST_APPROVAL",
    defaultTemplateId: "none",
    cli: { defaultModelId: "mimo-configured" },
  });
  await configuration.management.saveVendor({
    vendor,
    credential: { type: "replace", apiKey: "controlled-cli-integration-key" },
  });
  console.log(JSON.stringify({ seeded: true }));
} else if (mode === "inspect") {
  const database = new DatabaseSync(join(root, "sessions.sqlite"), { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT payload, owner_id FROM general_agent_checkpoints WHERE thread_id = ? AND query_id = ?",
      )
      .get(process.argv[3], process.argv[4]);
    if (!row) throw new Error("Expected checkpoint");
    const checkpoint = JSON.parse(row.payload);
    console.log(
      JSON.stringify({
        status: checkpoint.status,
        runId: checkpoint.lastRunId,
        leaseReleased: row.owner_id === null,
        interactionId: checkpoint.pending?.interaction.id,
        model: checkpoint.model,
      }),
    );
  } finally {
    database.close();
  }
} else if (mode === "rotate-key" || mode === "change-budget") {
  const snapshot = await configuration.management.getSnapshot();
  if (!snapshot) throw new Error("Expected configuration");
  if (mode === "rotate-key")
    await configuration.management.saveVendor({
      vendor: snapshot.settings.vendors[0],
      credential: { type: "replace", apiKey: "controlled-cli-rotated-key" },
    });
  else {
    const { vendors: _vendors, cli: _cli, ...preferences } = snapshot.settings;
    await configuration.management.savePreferences({
      ...preferences,
      gateway: { ...preferences.gateway, maxOutputTokens: 2048 },
    });
  }
  console.log(JSON.stringify({ updated: true }));
} else {
  const ports = {
    environment: { ...process.env, AGENT_HARNESS_CLI_DATA_DIR: root },
    workspaceRoot: process.env.CLI_TEST_WORKSPACE,
    createHost: (options) =>
      createNodeHost({
        ...options,
        configuration,
        requireReadApproval: process.env.CLI_TEST_REQUIRE_READ === "1",
      }),
  };
  if (mode === "interactive") {
    // Controlled raw/plain owner for process/approval regression, NOT PTY evidence.
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    Object.defineProperty(process.stdin, "setRawMode", {
      value(raw) {
        Object.defineProperty(process.stdin, "isRaw", { value: raw, configurable: true });
      },
    });
    Object.defineProperty(process.stderr, "isTTY", { value: true });
    Object.defineProperty(process.stderr, "columns", { value: 80 });
    Object.defineProperty(process.stderr, "rows", { value: 24 });
  }
  process.exitCode = await runCli(process.argv.slice(3), ports);
}
