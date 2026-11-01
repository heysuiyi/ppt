import type { TerminalSelectionItem, TerminalToolRecord } from "./terminal-contract.js";
import { sanitizeTerminalText, truncateTerminalText, wrapTerminalText } from "./terminal-text.js";

export function toolCardId(tool: TerminalToolRecord): string {
  return JSON.stringify([
    tool.invocationIdentity.agentId,
    tool.invocationIdentity.threadId,
    tool.invocationIdentity.queryId,
    tool.invocationIdentity.runId,
    tool.callId,
  ]);
}

export function toolSummary(tool: TerminalToolRecord): string {
  const state =
    tool.phase === "started"
      ? "running | effects=not-yet-known"
      : `${tool.status} | effects=${tool.effects}`;
  const error =
    tool.phase === "completed" && tool.status !== "succeeded"
      ? ` | ${tool.error.code}: ${tool.error.message}`
      : "";
  return sanitizeTerminalText(`[tool ${tool.name}] ${state}${error}`);
}

export function toolCardLines(
  tool: TerminalToolRecord,
  columns: number,
  expanded: boolean,
): string[] {
  const state =
    tool.phase === "started"
      ? "running | effects=not-yet-known"
      : `${tool.status} | effects=${tool.effects}`;
  const lines = [
    truncateTerminalText(state, columns),
    truncateTerminalText(`Tool: ${tool.name}`, columns),
  ];
  if (tool.phase === "completed" && tool.status !== "succeeded")
    lines.push(truncateTerminalText(`${tool.error.code}: ${tool.error.message}`, columns));
  if (!expanded) return lines;
  const identity = tool.invocationIdentity;
  if (tool.phase === "completed" && tool.status !== "succeeded")
    lines.push(...wrapTerminalText(`${tool.error.code}: ${tool.error.message}`, columns));
  for (const line of [
    `call: ${tool.callId}; version: ${tool.toolVersion ?? "unknown"}`,
    `agent: ${identity.agentId}; thread: ${identity.threadId}`,
    `query: ${identity.queryId}; run: ${identity.runId}`,
    "Additional details unavailable: no supported safe descriptor.",
    "Ctrl+O collapse; /tools-output selects previous tools.",
  ])
    lines.push(...wrapTerminalText(line, columns));
  return lines;
}

export function toolSelection(tool: TerminalToolRecord): TerminalSelectionItem {
  return {
    id: toolCardId(tool),
    label: sanitizeTerminalText(tool.name),
    description: toolSummary(tool),
  };
}
