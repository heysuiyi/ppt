import type { AgentRunAccepted, AgentRunResult, SubmitAgentRequest } from "@shared/ipc";
import { waitForExecutionSettings } from "../agentSettingsPersistence";

export async function executeAgentRun(options: {
  request: SubmitAgentRequest;
  onAccepted: (event: AgentRunAccepted) => void;
  onRunning: () => void;
}): Promise<AgentRunResult> {
  await waitForExecutionSettings();
  const stopAccepted = window.desktopApi.onAgentRunAccepted((event) => {
    if (event.requestId === options.request.requestId) options.onAccepted(event);
  });
  const stopStream = window.desktopApi.onAgentStream((event) => {
    if (event.runId === options.request.requestId && event.type === "stage-started")
      options.onRunning();
  });
  try {
    return await window.desktopApi.submitAgentRun(options.request);
  } finally {
    stopStream();
    stopAccepted();
  }
}
