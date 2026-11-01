import type { AgentActivityItem } from "@shared/agent-activity";
import { type AgentRunPhase, deriveAgentRunPresentation } from "@shared/agent-run-presentation";
import type React from "react";

interface RunStatusIndicatorProps {
  phase: AgentRunPhase;
  activityTrace: AgentActivityItem[];
}

export const RunStatusIndicator: React.FC<RunStatusIndicatorProps> = ({ phase, activityTrace }) => {
  const presentation = deriveAgentRunPresentation(phase, activityTrace);

  return (
    <span className="run-status" role="status" aria-live="polite">
      <span
        className={[
          "loading-indicator",
          "loading-indicator--sm",
          presentation.animated ? "" : "loading-indicator--paused",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-hidden="true"
      />
      <span
        className={[
          "run-status-label",
          presentation.animated ? "agent-run-status--shimmer" : "agent-run-status--paused",
        ].join(" ")}
      >
        {presentation.label}
      </span>
    </span>
  );
};
