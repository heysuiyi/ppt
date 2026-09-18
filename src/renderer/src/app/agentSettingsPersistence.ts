import type { AgentSettings } from "@shared/agent-settings";

let pendingSave: Promise<unknown> = Promise.resolve();

// Settings writes start when settings change, never as an extra submit-time IPC.
export function saveExecutionSettings(settings: AgentSettings): Promise<unknown> {
  pendingSave = pendingSave
    .catch(() => undefined)
    .then(() => window.desktopApi.saveAgentSettings(settings));
  return pendingSave;
}

export async function waitForExecutionSettings(): Promise<void> {
  await pendingSave;
}
