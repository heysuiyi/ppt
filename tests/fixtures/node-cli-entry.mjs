import { once } from "node:events";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
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
} else if (mode === "rotate-key" || mode === "change-budget" || mode === "restore-budget") {
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
      gateway: {
        ...preferences.gateway,
        maxOutputTokens: mode === "restore-budget" ? 1024 : 2048,
      },
    });
  }
  console.log(JSON.stringify({ updated: true }));
} else {
  const activated = Promise.withResolvers();
  const ports = {
    environment: { ...process.env, AGENT_HARNESS_CLI_DATA_DIR: root },
    workspaceRoot: process.env.CLI_TEST_WORKSPACE,
    createHost: (options) => {
      const host = createNodeHost({
        ...options,
        configuration,
        requireReadApproval: process.env.CLI_TEST_REQUIRE_READ === "1",
      });
      if (mode === "slow-output") {
        const run = host.run.bind(host);
        host.run = async (text) => {
          const handle = await run(text);
          activated.resolve(handle);
          return handle;
        };
      }
      return host;
    },
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
  if (mode === "slow-output") {
    const paused = Promise.withResolvers();
    let flush;
    let callbackPending = false;
    const output = new Writable({
      write(chunk, encoding, callback) {
        const record = JSON.parse(chunk.toString());
        if (record.type === "progress" && record.phase === "run.started") {
          callbackPending = true;
          flush = () => {
            callbackPending = false;
            process.stdout.write(chunk, encoding, callback);
          };
          paused.resolve();
        } else process.stdout.write(chunk, encoding, callback);
      },
    });
    let cliSettled = false;
    const running = runCli(process.argv.slice(3), { ...ports, output }).finally(() => {
      cliSettled = true;
    });
    await paused.promise;
    const handle = await activated.promise;
    const result = await handle.completed;
    const database = new DatabaseSync(join(root, "sessions.sqlite"), { readOnly: true });
    let checkpoint;
    let leaseReleased;
    try {
      const row = database
        .prepare(
          "SELECT payload, owner_id FROM general_agent_checkpoints WHERE thread_id = ? AND query_id = ?",
        )
        .get(handle.identity.threadId, handle.identity.queryId);
      if (!row) throw new Error("Expected slow-output checkpoint");
      checkpoint = JSON.parse(row.payload);
      leaseReleased = row.owner_id === null;
    } finally {
      database.close();
    }
    const release = once(process.stdin, "data");
    process.stderr.write(
      `${JSON.stringify({
        type: "slow-output.observation",
        identity: handle.identity,
        completedStatus: result.status,
        checkpointStatus: checkpoint.status,
        checkpointRunId: checkpoint.lastRunId,
        leaseReleased,
        cliSettled,
        callbackPending,
      })}\n`,
    );
    const [command] = await release;
    if (command.toString() !== "flush\n") throw new Error("Expected slow-output flush command");
    flush();
    process.exitCode = await running;
  } else process.exitCode = await runCli(process.argv.slice(3), ports);
}
