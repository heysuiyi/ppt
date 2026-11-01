export function formatToolApprovalDetail(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";

  const record = args as Record<string, unknown>;
  if (toolName === "bash" && typeof record.command === "string") {
    return record.command;
  }
  if (toolName === "WriteFile") {
    const path = typeof record.path === "string" ? record.path : "";
    const content = typeof record.content === "string" ? record.content : "";
    const preview = content.length > 240 ? `${content.slice(0, 237)}...` : content;
    return `path: ${path}\n${preview}`;
  }
  if (toolName === "EditFile") {
    const path = typeof record.path === "string" ? record.path : "";
    const oldString = typeof record.old_string === "string" ? record.old_string : "";
    const newString = typeof record.new_string === "string" ? record.new_string : "";
    return `path: ${path}\n- ${oldString}\n+ ${newString}`;
  }
  if (toolName === "ReadFile" || toolName === "Glob") {
    const path =
      typeof record.path === "string"
        ? record.path
        : typeof record.pattern === "string"
          ? record.pattern
          : "";
    return path;
  }

  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
