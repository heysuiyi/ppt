import { join, resolve } from "node:path";
import { CredentialStore, type SafeStorageAdapter } from "./internal/credential-store";
import { AgentSettingsStore } from "./internal/settings-store";
import { createManagement } from "./management";
import { createRuntime } from "./runtime";
import type { AgentConfiguration } from "./types";

export { registerAgentConfigurationIpc } from "./ipc";
export type { AgentConfiguration, ExecutionPlan, ResolvedRunConfiguration } from "./types";

// Coordinate whole configuration operations across factories in this process.
// CredentialStore additionally retains its inter-process transaction lock.
const operationTails = new Map<string, Promise<void>>();
export function createAgentConfiguration(options: {
  applicationDataRoot: string;
  safeStorage: SafeStorageAdapter;
  environment?: NodeJS.ProcessEnv;
}): AgentConfiguration {
  const credentials = new CredentialStore(options);
  const root = resolve(options.applicationDataRoot);
  const settings = new AgentSettingsStore(join(root, "agent-settings.json"));
  const environment = options.environment ?? process.env;
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = (operationTails.get(root) ?? Promise.resolve()).then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    operationTails.set(root, tail);
    void tail.then(() => {
      if (operationTails.get(root) === tail) operationTails.delete(root);
    });
    return result;
  };
  return {
    management: createManagement(settings, credentials, environment, exclusive),
    runtime: createRuntime(settings, credentials, environment, exclusive),
  };
}
