import type { AgentConfigurationSnapshot, AgentPreferences } from "@shared/agent-configuration";

let pendingSave: Promise<unknown> = Promise.resolve();

// Queue preferences and catalog mutations before a run can use the committed configuration.
export function persistAgentConfiguration<T>(save: () => Promise<T>): Promise<T> {
  const result = pendingSave.catch(() => undefined).then(save);
  pendingSave = result;
  return result;
}

export function saveExecutionPreferences(
  preferences: AgentPreferences,
): Promise<AgentConfigurationSnapshot> {
  return persistAgentConfiguration(() => window.desktopApi.saveAgentPreferences(preferences));
}

export async function waitForExecutionSettings(): Promise<void> {
  await pendingSave;
}
