import { join, resolve } from "node:path";
import type { CredentialProtection } from "./credential-contract.js";
import { CredentialStore } from "./internal/credential-store.js";
import { AgentSettingsStore } from "./internal/settings-store.js";
import { acquireTransactionLock, type LockRelease } from "./internal/transaction-lock.js";
import { createManagement } from "./management.js";
import { createRuntime } from "./runtime.js";
import type { AgentConfiguration } from "./types.js";

export type { AgentConfiguration, ExecutionPlan, ResolvedRunConfiguration } from "./types.js";

export interface AgentConfigurationOptions {
  applicationDataRoot: string;
  credentialProtection: CredentialProtection;
  /** Opaque host preference; configuration does not depend on a template/plugin implementation. */
  defaultTemplateId: string;
  environment?: NodeJS.ProcessEnv;
}

// The local queue orders all reads and mutations; the OS-visible lock additionally
// serializes the complete settings/credential mutation across CLI processes.
const operationTails = new Map<string, Promise<void>>();
export function createAgentConfiguration(options: AgentConfigurationOptions): AgentConfiguration {
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
  const mutate = <T>(operation: () => Promise<T>): Promise<T> =>
    exclusive(async () => {
      let release: LockRelease;
      try {
        release = await acquireTransactionLock(join(root, "agent-configuration.transaction"));
      } catch (cause) {
        throw new Error("The configuration transaction lock could not be acquired.", { cause });
      }
      let result: T;
      try {
        result = await operation();
      } catch (error) {
        try {
          await release();
        } catch {
          // Preserve the mutation failure; never replay effects to recover a lock release.
        }
        throw error;
      }
      try {
        await release();
      } catch (cause) {
        throw new Error("The configuration transaction lock could not be released.", { cause });
      }
      return result;
    });
  return {
    management: createManagement(
      settings,
      credentials,
      environment,
      exclusive,
      mutate,
      options.defaultTemplateId,
    ),
    runtime: createRuntime(settings, credentials, environment, exclusive),
  };
}
