import { posix } from "node:path";
import type { VersionedData } from "@agent-harness/core/protocol-values";
import type { StoredToolInvocation } from "@agent-harness/core/session/session-contract";
import type { TerminalToolDisplay } from "./terminal-contract.js";
import { sanitizeTerminalText } from "./terminal-text.js";

// 展示副本上限，不改变工具执行、原始结果或 tools.<name>@1 协议版本。
const MAX_LINES = 200;
const MAX_LINE_LENGTH = 2000;
const MAX_TEXT_BYTES = 128 * 1024;
const TRUNCATED = "… preview truncated";
const MARKER_BYTES = Buffer.byteLength(TRUNCATED, "utf8") + 1;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function installedTool(name: string, version: string | null): boolean {
  return version === "1" && ["read", "glob", "grep", "write", "edit"].includes(name);
}

function clip(text: string, maxBytes: number): string {
  let end = 0;
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (end + character.length > MAX_LINE_LENGTH || bytes + size > maxBytes) break;
    end += character.length;
    bytes += size;
  }
  if (end === text.length) return text;
  if (maxBytes < 3) return "";
  while (end > 0 && (end + 1 > MAX_LINE_LENGTH || bytes + 3 > maxBytes)) {
    const last = text.charCodeAt(end - 1);
    const size = last >= 0xdc00 && last <= 0xdfff && end > 1 ? 2 : 1;
    bytes -= Buffer.byteLength(text.slice(end - size, end), "utf8");
    end -= size;
  }
  return `${text.slice(0, end)}…`;
}

function line(text: string, maxBytes = MAX_TEXT_BYTES): string {
  // 兼容旧 preview 数组的 CRLF 行尾；其余 CR 与 OMP 一样取最后覆盖段。
  const source = text.endsWith("\r") ? text.slice(0, -1) : text;
  const visible = source.slice(source.lastIndexOf("\r") + 1);
  // 先限输入，再转义，再限输出，控制字符膨胀也不能突破预算。
  const bounded = clip(visible, MAX_TEXT_BYTES);
  return clip(
    sanitizeTerminalText(bounded).replaceAll("\n", "\\n").replaceAll("\t", "    "),
    maxBytes,
  );
}

/** 输出边界重新白名单构建；总 UTF-8 文本含标题/参数/统计/正文与截断标记。 */
export function sanitizeToolDisplay(
  value: unknown,
  name: string,
  version: string | null,
): TerminalToolDisplay | undefined {
  if (!installedTool(name, version)) return undefined;
  const display = object(value);
  if (!display || typeof display.title !== "string") return undefined;
  if (!Array.isArray(display.input) || !Array.isArray(display.output)) return undefined;
  const title = line(display.title);
  let remaining = MAX_TEXT_BYTES - Buffer.byteLength(title, "utf8") - 1;
  function lines(values: unknown[], maximum: number): string[] {
    const result: string[] = [];
    let truncated = false;
    for (let index = 0; index < values.length; index += 1) {
      if (index === maximum) {
        truncated = true;
        break;
      }
      const value = values[index];
      if (typeof value !== "string") continue;
      if (remaining < MARKER_BYTES + 4) {
        truncated = true;
        break;
      }
      const safe = line(value, remaining - MARKER_BYTES - 1);
      result.push(safe);
      remaining -= Buffer.byteLength(safe, "utf8") + 1;
    }
    if (truncated) {
      if (result.length === maximum) {
        const removed = result.pop()!;
        remaining += Buffer.byteLength(removed, "utf8") + 1;
      }
      if (remaining >= MARKER_BYTES) {
        result.push(TRUNCATED);
        remaining -= MARKER_BYTES;
      }
    }
    return result;
  }
  const input = lines(display.input, 16);
  const summary = Array.isArray(display.summary) ? lines(display.summary, 8) : undefined;
  const output = lines(display.output, MAX_LINES);
  return { title, input, ...(summary ? { summary } : {}), output };
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 只比较展示关联的词法路径，不解析工作区、不触碰文件系统或授权。 */
function sameDisplayPath(input: unknown, output: unknown): boolean {
  return (
    text(input) &&
    text(output) &&
    posix.normalize(input.replaceAll("\\", "/")) === posix.normalize(output.replaceAll("\\", "/"))
  );
}

function preview(
  text: string,
  maximum = MAX_LINES,
  prefix = "",
  maxBytes = MAX_TEXT_BYTES,
): string[] {
  const result: string[] = [];
  let offset = 0;
  let remaining = maxBytes;
  while (result.length < maximum) {
    const end = text.indexOf("\n", offset);
    const value = `${prefix}${line(text.slice(offset, end < 0 ? text.length : end))}`;
    if (remaining < Buffer.byteLength(value, "utf8") + MARKER_BYTES + 1) break;
    result.push(value);
    remaining -= Buffer.byteLength(value, "utf8") + 1;
    if (end < 0) return result;
    offset = end + 1;
  }
  if (result.length === maximum) result.pop();
  result.push(TRUNCATED);
  return result;
}

type ResultDisplay = Pick<TerminalToolDisplay, "summary" | "output">;

function resultDisplay(
  name: string,
  input: Record<string, unknown>,
  data: Record<string, unknown>,
): ResultDisplay {
  const empty: ResultDisplay = { output: [] };
  switch (name) {
    case "read": {
      if (
        !sameDisplayPath(input.path, data.path) ||
        !count(data.size) ||
        !count(data.startOffset) ||
        !count(data.endOffset) ||
        !count(data.totalCharacters) ||
        data.endOffset < data.startOffset ||
        data.endOffset > data.totalCharacters ||
        typeof data.hasMore !== "boolean" ||
        typeof data.previewTruncated !== "boolean" ||
        !Array.isArray(data.preview) ||
        !data.preview.slice(0, MAX_LINES).every((item) => typeof item === "string")
      )
        return empty;
      return {
        summary: [
          `${data.size} bytes · offsets ${data.startOffset}–${data.endOffset}/${data.totalCharacters}`,
          ...(data.hasMore ? ["… more file content"] : []),
        ],
        output: [
          ...(data.preview.slice(0, MAX_LINES) as string[]),
          ...(data.previewTruncated || data.preview.length > MAX_LINES ? [TRUNCATED] : []),
        ],
      };
    }
    case "glob": {
      if (
        !count(data.totalMatches) ||
        typeof data.truncated !== "boolean" ||
        typeof data.previewTruncated !== "boolean" ||
        !Array.isArray(data.matches) ||
        !data.matches.slice(0, MAX_LINES).every((item) => typeof item === "string")
      )
        return empty;
      return {
        summary: [`${data.totalMatches} files${data.truncated ? " · search incomplete" : ""}`],
        output: [
          ...(data.matches.slice(0, MAX_LINES) as string[]),
          ...(data.previewTruncated || data.matches.length > MAX_LINES ? [TRUNCATED] : []),
        ],
      };
    }
    case "grep": {
      if (
        !count(data.totalMatches) ||
        !count(data.skippedCount) ||
        typeof data.truncated !== "boolean" ||
        typeof data.previewTruncated !== "boolean" ||
        !Array.isArray(data.matches)
      )
        return empty;
      const matches: string[] = [];
      for (const value of data.matches.slice(0, MAX_LINES)) {
        const match = object(value);
        if (
          !match ||
          !text(match.path) ||
          !count(match.line) ||
          match.line === 0 ||
          typeof match.text !== "string" ||
          typeof match.truncated !== "boolean"
        )
          return empty;
        matches.push(
          `${line(match.path)}:${match.line}: ${line(match.text)}${match.truncated ? " …" : ""}`,
        );
      }
      return {
        summary: [
          `${data.totalMatches} matches · ${data.skippedCount} skipped${data.truncated ? " · search incomplete" : ""}`,
        ],
        output: [
          ...matches,
          ...(data.previewTruncated || data.matches.length > MAX_LINES ? [TRUNCATED] : []),
        ],
      };
    }
    case "write":
      if (
        !sameDisplayPath(input.path, data.path) ||
        !count(data.size) ||
        (data.operation !== "created" && data.operation !== "replaced")
      )
        return empty;
      return {
        summary: [`${data.operation} · ${data.size} bytes`],
        output: typeof input.content === "string" ? preview(input.content) : [],
      };
    case "edit":
      if (
        !sameDisplayPath(input.path, data.path) ||
        !count(data.size) ||
        !count(data.replacements) ||
        data.replacements === 0
      )
        return empty;
      return {
        summary: [`${data.replacements} replacements · ${data.size} bytes`],
        output: [
          ...(typeof input.oldText === "string"
            ? preview(input.oldText, 100, "- ", 60 * 1024)
            : []),
          ...(typeof input.newText === "string"
            ? preview(input.newText, 100, "+ ", 60 * 1024)
            : []),
        ],
      };
    default:
      return empty;
  }
}

/** 仅识别当前文件插件的名称/实现版本与独立展示协议，绝不回退到原始结果。 */
export function projectToolDisplay(
  invocation: StoredToolInvocation,
  presentation?: VersionedData,
): TerminalToolDisplay | undefined {
  const { name } = invocation.call;
  if (!installedTool(name, invocation.toolVersion)) return undefined;
  const input = object(invocation.call.input);
  if (!input) return undefined;
  let title: string;
  let parameters: string[];
  switch (name) {
    case "read":
      if (!text(input.path)) return undefined;
      title = input.path;
      parameters = [
        `offset: ${count(input.offset) ? input.offset : 0}`,
        `limit: ${count(input.limit) ? input.limit : 4000}`,
      ];
      break;
    case "glob":
      if (!text(input.pattern)) return undefined;
      title = input.pattern;
      parameters = [`limit: ${count(input.limit) ? input.limit : 200}`];
      break;
    case "grep":
      if (!text(input.pattern)) return undefined;
      title = input.pattern;
      parameters = [
        `glob: ${typeof input.glob === "string" ? line(input.glob) : "**/*"}`,
        `case-sensitive: ${input.caseSensitive !== false}`,
        `limit: ${count(input.limit) ? input.limit : 200}`,
      ];
      break;
    case "write":
      if (!text(input.path) || (input.mode !== "create" && input.mode !== "replace"))
        return undefined;
      title = input.path;
      parameters = [`mode: ${input.mode}`];
      break;
    case "edit":
      if (!text(input.path)) return undefined;
      title = input.path;
      parameters = [`replace-all: ${input.replaceAll === true}`];
      break;
    default:
      return undefined;
  }
  const data =
    presentation?.type === `tools.${name}` && presentation.version === 1
      ? object(presentation.data)
      : undefined;
  return sanitizeToolDisplay(
    { title, input: parameters, ...(data ? resultDisplay(name, input, data) : { output: [] }) },
    name,
    invocation.toolVersion,
  );
}
