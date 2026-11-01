const NO_EFFORTS: readonly string[] = Object.freeze([]);
const STANDARD_EFFORTS: readonly string[] = Object.freeze(["low", "medium", "high"]);
const GPT5_EFFORTS: readonly string[] = Object.freeze(["minimal", ...STANDARD_EFFORTS]);
const GPT51_EFFORTS: readonly string[] = Object.freeze(["none", ...STANDARD_EFFORTS]);
const RECENT_GPT5_EFFORTS: readonly string[] = Object.freeze([...GPT51_EFFORTS, "xhigh"]);

/** Only known reasoning families on the production OpenAI Responses path. */
export function getModelReasoningEfforts(model: {
  provider: string;
  model: string;
  openaiApiMode?: string;
  vendorKind?: string;
}): readonly string[] {
  if (
    model.provider !== "openai" ||
    model.openaiApiMode !== "responses" ||
    model.vendorKind === "mimo-token-plan-cn"
  )
    return NO_EFFORTS;

  // Explicit families and dated snapshots, not chat-latest, pro, codex or future aliases.
  const name = model.model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (name === "gpt-5" || name === "gpt-5-mini" || name === "gpt-5-nano") return GPT5_EFFORTS;
  if (name === "gpt-5.1") return GPT51_EFFORTS;
  if (name === "gpt-5.2" || name === "gpt-5.4" || name === "gpt-5.5") return RECENT_GPT5_EFFORTS;
  if (name === "o1" || name === "o3" || name === "o3-mini" || name === "o4-mini")
    return STANDARD_EFFORTS;
  return NO_EFFORTS;
}

export function getModelReasoningLabel(effort: string | undefined): string {
  switch (effort) {
    case undefined:
    case "":
      return "默认";
    case "none":
      return "关闭";
    case "minimal":
      return "极低";
    case "low":
      return "低";
    case "medium":
      return "中";
    case "high":
      return "高";
    case "xhigh":
      return "极高";
    default:
      return effort;
  }
}
