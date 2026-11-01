import { z } from "zod";
import type { AgentToolSchema } from "../gateway";
import type { ToolDefinition } from "./tool-definition";

/**
 * 将工具的 zod inputSchema 转为 provider 可直接使用的 JSON Schema。
 *
 * - 使用 zod v4 内置 `z.toJSONSchema`；`unrepresentable: "any"` 兼容 preprocess/transform
 *   等无法精确表达的类型（如 assumptionsSchema），退化为宽松 schema 而非抛错。
 * - 剥离 `$schema` 顶层键：Anthropic / OpenAI 的 tool schema 不需要它。
 * - 保证顶层为 `type: "object"`，符合两个 provider 对 tool 输入的要求。
 */
export function toToolInputSchema(schema: z.ZodObject<any>): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    unrepresentable: "any",
    io: "input",
  }) as Record<string, unknown>;

  delete json.$schema;

  if (json.type !== "object") {
    return {
      type: "object",
      properties: json.properties ?? {},
      ...(json.required ? { required: json.required } : {}),
    };
  }

  return json;
}

/** 将工具定义转为原生 tool-use 的工具声明。 */
export function toToolSchema(definition: ToolDefinition<any, any>): AgentToolSchema {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: toToolInputSchema(definition.inputSchema),
  };
}

/** 批量转换，供 runtime 每步构造 tools 清单。 */
export function toToolSchemas(definitions: ToolDefinition<any, any>[]): AgentToolSchema[] {
  return definitions.map(toToolSchema);
}
