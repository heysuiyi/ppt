/** Context compaction thresholds — cheap layers first, LLM summary last. */

export const SNIP_MESSAGE_THRESHOLD = 50;
export const SNIP_KEEP_HEAD = 3;
export const SNIP_KEEP_TAIL = 47;

export const MICRO_COMPACT_KEEP_TOOL_RESULTS = 3;
export const MICRO_COMPACT_MIN_RESULT_CHARS = 2_000;
export const MICRO_COMPACT_PREVIEW_HEAD_CHARS = 900;
export const MICRO_COMPACT_PREVIEW_TAIL_CHARS = 300;
export const MICRO_COMPACT_ALWAYS_PRESERVE_TOOLS = ["LoadSkill"] as const;
export const MICRO_COMPACT_PRESERVE_LATEST_TOOLS = [
  "AskUser",
  "ListSlides",
  "PreviewSvgPage",
  "ReadPresentationSnapshot",
  "SubmitSvgDeck",
  "TaskClaim",
  "TaskReviewApprove",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "respond_plan_approval",
] as const;

export const TOOL_RESULT_BUDGET_BYTES = 200 * 1024;
export const TOOL_RESULT_PREVIEW_CHARS = 2_000;
export const TOOL_RESULTS_DIR = ".task_outputs/tool-results";

export const COMPACT_TRANSCRIPTS_DIR = ".transcripts";
export const COMPACT_HISTORY_MAX_FAILURES = 3;

/** Rough chars-per-token ratio for JSON payloads (no tokenizer dependency). */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

export const DEFAULT_CONTEXT_TOKEN_THRESHOLD = 256_000;
export const EXTENDED_CONTEXT_TOKEN_THRESHOLD = 1_000_000;
export const DEFAULT_CONTEXT_COMPACT_SOFT_RATIO = 0.8;

export function resolveContextTokenThreshold(
  env: NodeJS.ProcessEnv = process.env,
  supports1MContext = false,
): number {
  const raw = env.AGENT_CONTEXT_TOKEN_THRESHOLD?.trim();
  const modelThreshold = supports1MContext
    ? EXTENDED_CONTEXT_TOKEN_THRESHOLD
    : DEFAULT_CONTEXT_TOKEN_THRESHOLD;
  if (!raw) return modelThreshold;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : modelThreshold;
}

export function resolveContextSoftTokenThreshold(
  tokenThreshold: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.AGENT_CONTEXT_COMPACT_SOFT_TOKEN_THRESHOLD?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(Math.floor(parsed), tokenThreshold);
    }
  }
  return Math.max(1, Math.floor(tokenThreshold * DEFAULT_CONTEXT_COMPACT_SOFT_RATIO));
}
