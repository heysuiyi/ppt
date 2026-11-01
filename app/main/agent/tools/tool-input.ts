import type { z } from "zod";
import type { ToolDefinition } from "./tool-definition";
import { toToolInputSchema } from "./tool-schema";

const MAX_JSON_STRING_LENGTH = 64 * 1024;
const MAX_REPAIR_DEPTH = 12;

export interface ToolInputRepair {
  path: string;
  expected: "object" | "array";
  kind: "decoded-json-string";
}

type ToolInputParseResult<TSchema extends z.ZodObject<any>> =
  | { success: true; data: z.infer<TSchema>; repairs: ToolInputRepair[] }
  | { success: false; error: z.ZodError; repairs: ToolInputRepair[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaCandidates(schema: Record<string, unknown>): Record<string, unknown>[] {
  const combined = [schema.oneOf, schema.anyOf]
    .filter(Array.isArray)
    .flatMap((value) => value as unknown[])
    .filter(isRecord);
  return combined.length > 0 ? combined : [schema];
}

function expectedContainerType(schema: Record<string, unknown>): "object" | "array" | undefined {
  const types = new Set<string>();
  for (const candidate of schemaCandidates(schema)) {
    if (typeof candidate.type === "string") types.add(candidate.type);
  }
  if (types.size !== 1) return undefined;
  const [type] = types;
  return type === "object" || type === "array" ? type : undefined;
}

function selectCandidate(schema: Record<string, unknown>, value: unknown): Record<string, unknown> {
  const candidates = schemaCandidates(schema);
  if (candidates.length === 1) return candidates[0]!;

  if (isRecord(value)) {
    const discriminatorMatch = candidates.find((candidate) => {
      if (!isRecord(candidate.properties)) return false;
      return Object.entries(candidate.properties).some(
        ([key, property]) =>
          isRecord(property) && "const" in property && property.const === value[key],
      );
    });
    if (discriminatorMatch) return discriminatorMatch;
  }

  return (
    candidates.find((candidate) => {
      if (candidate.type === "object") return isRecord(value);
      if (candidate.type === "array") return Array.isArray(value);
      return false;
    }) ?? schema
  );
}

function decodeContainerString(value: unknown, expected: "object" | "array"): unknown {
  if (typeof value !== "string" || value.length > MAX_JSON_STRING_LENGTH) return value;
  const trimmed = value.trim();
  if (expected === "object" && !trimmed.startsWith("{")) return value;
  if (expected === "array" && !trimmed.startsWith("[")) return value;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (expected === "object" && isRecord(parsed)) return parsed;
    if (expected === "array" && Array.isArray(parsed)) return parsed;
  } catch {
    // Zod produces the authoritative validation error below.
  }
  return value;
}

function repairValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  depth: number,
  repairs: ToolInputRepair[],
): unknown {
  if (depth > MAX_REPAIR_DEPTH) return value;
  const expected = expectedContainerType(schema);
  const decoded = expected ? decodeContainerString(value, expected) : value;
  if (decoded !== value && expected) {
    repairs.push({ path: path || "$", expected, kind: "decoded-json-string" });
  }

  const selected = selectCandidate(schema, decoded);
  if (isRecord(decoded) && isRecord(selected.properties)) {
    let changed = decoded !== value;
    const result: Record<string, unknown> = { ...decoded };
    for (const [key, propertySchema] of Object.entries(selected.properties)) {
      if (!(key in decoded) || !isRecord(propertySchema)) continue;
      const repaired = repairValue(
        decoded[key],
        propertySchema,
        path ? `${path}.${key}` : key,
        depth + 1,
        repairs,
      );
      if (repaired !== decoded[key]) {
        result[key] = repaired;
        changed = true;
      }
    }
    return changed ? result : decoded;
  }

  if (Array.isArray(decoded) && isRecord(selected.items)) {
    let changed = decoded !== value;
    const result = decoded.map((item, index) => {
      const repaired = repairValue(
        item,
        selected.items as Record<string, unknown>,
        `${path}[${index}]`,
        depth + 1,
        repairs,
      );
      if (repaired !== item) changed = true;
      return repaired;
    });
    return changed ? result : decoded;
  }

  return decoded;
}

export function parseToolInput<TSchema extends z.ZodObject<any>>(
  schema: TSchema,
  input: unknown,
): ToolInputParseResult<TSchema> {
  const repairs: ToolInputRepair[] = [];
  const repaired = repairValue(input, toToolInputSchema(schema), "", 0, repairs);
  const parsed = schema.safeParse(repaired);
  return parsed.success
    ? { success: true, data: parsed.data, repairs }
    : { success: false, error: parsed.error, repairs };
}

export function parseDefinedToolInput<TSchema extends z.ZodObject<any>>(
  tool: Pick<ToolDefinition<TSchema, unknown>, "inputSchema">,
  input: unknown,
): ToolInputParseResult<TSchema> {
  return parseToolInput(tool.inputSchema, input);
}
