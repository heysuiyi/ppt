import type { TerminalRecord } from "./terminal-contract.js";
import { toolSummary } from "./tool-card.js";

export interface HumanRecordOutput {
  readonly output?: string;
  readonly error?: string;
}

/** No layout wrapping in print/plain: pipes receive authoritative text, not screen rows. */
export function humanRecordOutput(record: TerminalRecord): HumanRecordOutput {
  switch (record.type) {
    case "assistant.message": {
      const text = record.content.map((part) => part.text).join("");
      return text.length > 0 ? { output: text.endsWith("\n") ? text : `${text}\n` } : {};
    }
    case "session":
      return {
        error: `Session: ${record.threadId}${record.model ? ` | ${record.model.label}` : ""}\n`,
      };
    case "progress":
      return {
        error:
          record.phase === "run.failed"
            ? `${record.phase}: ${record.error.code}: ${record.error.message}\n`
            : `${record.phase}${"step" in record ? ` ${record.step}` : ""}\n`,
      };
    case "tool":
      return { error: `${toolSummary(record)}\n` };
    case "interaction": {
      if (record.phase === "resolved")
        return { error: `Interaction ${record.interactionId}: ${record.responseType}\n` };
      return {
        error: `Interaction ${record.interactionId} (${record.owner}/${record.payloadType}@${record.payloadVersion}): ${record.display.support === "supported" ? record.display.summary : "Unsupported interaction; no private payload displayed."}\n`,
      };
    }
    case "query.result": {
      if (record.status === "failed")
        return { error: `Query failed: ${record.error.code}: ${record.error.message}\n` };
      if (record.status === "waiting")
        return {
          error: `Query waiting: ${record.interaction.interactionId} (${record.interaction.owner}/${record.interaction.payloadType}@${record.interaction.payloadVersion})\n${record.display.support === "supported" ? record.display.summary : "Unsupported interaction; resume with a supported host."}\n`,
        };
      return record.status === "completed"
        ? {}
        : { error: `Query ${record.status}; unfinished preview discarded.\n` };
    }
    case "error":
      return {
        error: `${record.stage}: ${record.error.code}: ${record.error.message}${record.outcomeUncertain ? " (outcome uncertain)" : ""}\n`,
      };
    case "process.finished":
      return record.exitCode === 0
        ? {}
        : { error: `Process finished: ${record.reason} (exit ${record.exitCode})\n` };
  }
}
