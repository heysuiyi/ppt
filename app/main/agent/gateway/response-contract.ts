import type { AgentResponseContract } from "./types";

const MARKDOWN_SUMMARY_MARKER = "<!-- RESPONSE_CONTRACT:markdown-summary -->";
const MARKDOWN_MARKER = "<!-- RESPONSE_CONTRACT:markdown -->";

function buildMarkdownSummaryResponseContract(): string {
  return [
    MARKDOWN_SUMMARY_MARKER,
    "## Response Contract",
    "",
    "Return plain Markdown summary text only. Do not call tools or wrap the response in JSON.",
  ].join("\n");
}

function buildMarkdownResponseContract(): string {
  return [
    MARKDOWN_MARKER,
    "## Response Contract",
    "",
    "Return Markdown text only. Do not call tools or wrap the response in JSON.",
  ].join("\n");
}

export function buildResponseContract(contract: AgentResponseContract): string {
  if (contract === "markdown") return buildMarkdownResponseContract();
  if (contract === "markdown-summary") return buildMarkdownSummaryResponseContract();
  return "";
}

export function applyResponseContract(
  systemPrompt: string | undefined,
  contract: AgentResponseContract | undefined,
): string | undefined {
  if (!contract || contract === "none") return systemPrompt;
  const contractText = buildResponseContract(contract);
  const currentPrompt = systemPrompt?.trim() ?? "";
  const marker = contract === "markdown" ? MARKDOWN_MARKER : MARKDOWN_SUMMARY_MARKER;
  if (!contractText || currentPrompt.includes(marker)) return systemPrompt;
  return currentPrompt ? `${currentPrompt}\n\n${contractText}` : contractText;
}
