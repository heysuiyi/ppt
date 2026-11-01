import { isRiskApprovalHintRequired } from "../runtime/tools/tool-access-policy";
import type { ToolDefinition } from "./tool-definition";
import { toToolInputSchema } from "./tool-schema";

/**
 * Deferred Tool 的可发现摘要结构，提供给模型做发现决策。
 * 不包含 execute 执行函数或内部权限上下文，避免泄露。
 */
export interface ToolCard {
  name: string;
  description: string;
  disabledScenarios: string[];
  risk: "low" | "medium" | "high";
  parameterSummary: Record<string, { type: string; description: string; required: boolean }>;
  examples: string[];
  approvalRequired: boolean;
  execution: {
    batch: "allowed" | "exclusive";
    mode: "serial" | "parallel";
    conflictScope?: "workspace_path";
  };
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function summarizeSchemaType(schema: Record<string, unknown>): string {
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum))
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  const variants = [schema.oneOf, schema.anyOf]
    .filter(Array.isArray)
    .flatMap((value) => value as unknown[])
    .filter(isSchemaRecord)
    .map(summarizeSchemaType);
  if (variants.length > 0) return [...new Set(variants)].join(" | ");
  if (schema.type === "array") {
    return isSchemaRecord(schema.items) ? `array<${summarizeSchemaType(schema.items)}>` : "array";
  }
  return typeof schema.type === "string" ? schema.type : "unknown";
}

/**
 * 将完整的工具定义收缩转换为模型可见的 ToolCard
 */
export function toToolCard(definition: ToolDefinition<any, any>): ToolCard {
  const paramSummary: Record<string, { type: string; description: string; required: boolean }> = {};
  const inputSchema = toToolInputSchema(definition.inputSchema);
  const properties = isSchemaRecord(inputSchema.properties) ? inputSchema.properties : {};
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);

  for (const [key, value] of Object.entries(properties)) {
    if (isSchemaRecord(value)) {
      paramSummary[key] = {
        type: summarizeSchemaType(value),
        description: typeof value.description === "string" ? value.description : "",
        required: required.has(key),
      };
    }
  }

  const approvalRequired =
    definition.permission?.approval === "always" || isRiskApprovalHintRequired(definition.risk);

  return {
    name: definition.name,
    description: definition.description,
    disabledScenarios: [], // 可由特定工具定义或加载策略注入
    risk: definition.risk,
    parameterSummary: paramSummary,
    examples: definition.examples ?? [],
    approvalRequired,
    execution: {
      batch: definition.behavior?.completion?.exclusiveBatch ? "exclusive" : "allowed",
      mode: definition.behavior?.concurrency?.mode ?? "serial",
      ...(definition.behavior?.concurrency?.conflictScope
        ? { conflictScope: definition.behavior.concurrency.conflictScope }
        : {}),
    },
  };
}
