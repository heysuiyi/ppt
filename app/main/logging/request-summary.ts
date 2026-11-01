export function requestSummary(
  request: string,
  detail: "minimal" | "full" = process.env.AGENT_LOG_DETAIL?.trim().toLowerCase() === "full"
    ? "full"
    : "minimal",
): { requestLength: number; requestPreview: string; requestFull?: string } {
  const normalized = request.replace(/\s+/g, " ").trim();
  return {
    requestLength: request.length,
    requestPreview: normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized,
    ...(detail === "full" ? { requestFull: request } : {}),
  };
}
