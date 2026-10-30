import { z } from "zod";
import type { ModelToolSchema } from "../model/model-contract";
import { AgentError, snapshot } from "../protocol-utils";
import type { Disposable, InteractionResponse, JsonValue, VersionedData } from "../protocol-values";
import { RegistrationStore } from "../scope/registration-store";
import type {
  ToolCompletion,
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistrar,
  ToolResult,
  ToolSuspension,
} from "./tool-contract";

const modelContentSchema = z.array(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({
      type: z.literal("image"),
      source: z.discriminatedUnion("type", [
        z.object({ type: z.literal("url"), url: z.string() }),
        z.object({ type: z.literal("base64"), mediaType: z.string(), data: z.string() }),
      ]),
    }),
  ]),
);
const presentationSchema = z.object({
  type: z.string(),
  version: z.number().int(),
  data: z.json(),
});

/** 泛型只在注册闭包内擦除；输入/输出始终经过原定义的模式。 */
export interface BoundToolDefinition {
  readonly name: string;
  readonly version: string;
  readonly owner: string;
  readonly schema: ModelToolSchema;
  prepare(
    input: unknown,
  ): Promise<(context: ToolExecutionContext) => Promise<ToolResult | ToolSuspension>>;
  readonly resume?: (
    continuation: VersionedData,
    response: InteractionResponse,
    context: ToolExecutionContext,
  ) => Promise<ToolResult | ToolSuspension>;
  project(result: ToolResult): Promise<ToolCompletion>;
}

export class ToolRegistry implements ToolRegistrar, Disposable {
  private readonly registrations = new RegistrationStore<BoundToolDefinition>();

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): Disposable {
    const { name, version, owner, description, inputSchema, outputSchema } = definition;
    const execute = definition.execute.bind(definition);
    const resume = definition.mode === "resumable" ? definition.resume.bind(definition) : undefined;
    const toModelContent = definition.toModelContent.bind(definition);
    const toPresentation = definition.toPresentation?.bind(definition);
    const schema: ModelToolSchema = {
      name,
      description,
      // Zod 的非枚举 Standard Schema 元数据不是模型模式；先投影为 JSON 数据。
      inputSchema: snapshot(
        z.record(z.string(), z.json()).parse(z.toJSONSchema(inputSchema, { io: "input" })),
      ),
    };
    const entry: BoundToolDefinition = {
      name,
      version,
      owner,
      schema,
      async prepare(input) {
        const parsed = await inputSchema.parseAsync(input);
        return (context) => execute(parsed, context);
      },
      ...(resume ? { resume } : {}),
      async project(result) {
        let validated: ToolResult<TOutput>;
        let completion: ToolResult<JsonValue>;
        if (result.status === "succeeded") {
          let output: TOutput;
          try {
            output = await outputSchema.parseAsync(result.output);
          } catch {
            throw new AgentError("tool_output_invalid", `Invalid output from tool: ${name}`);
          }
          validated = { status: "succeeded", effects: result.effects, output: snapshot(output) };
          completion = {
            status: "succeeded",
            effects: result.effects,
            output: z.json().parse(validated.output),
          };
        } else {
          validated = result;
          completion = result;
        }
        const modelContent = modelContentSchema.parse(
          snapshot(await toModelContent(snapshot(validated))),
        );
        const presentation = toPresentation
          ? presentationSchema.parse(snapshot(await toPresentation(snapshot(validated))))
          : undefined;
        return snapshot({ ...completion, modelContent, ...(presentation ? { presentation } : {}) });
      },
    };
    return this.registrations.register(name, entry);
  }

  get(name: string): BoundToolDefinition | undefined {
    this.registrations.assertOpen();
    return this.registrations.entries.get(name);
  }

  getVersion(name: string): string | undefined {
    return this.get(name)?.version;
  }

  getSchemas(): readonly ModelToolSchema[] {
    this.registrations.assertOpen();
    return [...this.registrations.entries.values()].map((entry) => snapshot(entry.schema));
  }

  seal(): void {
    this.registrations.seal();
  }

  dispose(): Promise<void> {
    return this.registrations.dispose();
  }
}
