import {
  type AgentConfiguration,
  createAgentConfiguration,
} from "@agent-harness/configuration/configuration";
import { APPLICATION_DEFAULT_TEMPLATE_ID } from "@shared/template-protocol";
import {
  createSafeStorageCredentialProtection,
  type SafeStorageAdapter,
} from "./safe-storage-protection";

export function createDesktopAgentConfiguration(options: {
  applicationDataRoot: string;
  safeStorage: SafeStorageAdapter;
  environment?: NodeJS.ProcessEnv;
}): AgentConfiguration {
  return createAgentConfiguration({
    applicationDataRoot: options.applicationDataRoot,
    credentialProtection: createSafeStorageCredentialProtection(options.safeStorage),
    defaultTemplateId: APPLICATION_DEFAULT_TEMPLATE_ID,
    environment: options.environment,
  });
}
