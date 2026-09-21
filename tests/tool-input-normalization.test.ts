import { createPptRuntime } from "@main/plugins/ppt/plugin";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  AgentModelGateway,
  AgentModelRequest,
  AgentModelResponse,
} from "../src/main/agent/gateway/types";
import { askUserTool } from "../src/main/agent/tools/core/ask-user";
import { toToolCard } from "../src/main/agent/tools/tool-card";
import { parseDefinedToolInput, parseToolInput } from "../src/main/agent/tools/tool-input";
import { ToolRegistry } from "../src/main/agent/tools/tool-registry";
import { toToolSchema } from "../src/main/agent/tools/tool-schema";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

describe("tool input normalization", () => {
  it("repairs a double-serialized AskUser responseUi object", () => {
    const parsed = parseDefinedToolInput(askUserTool, {
      message: "请补充目标受众",
      responseUi: JSON.stringify({
        variant: "markdown",
        allowFreeText: true,
        resolved: { optionIds: [], value: "", label: "" },
      }),
      missingFields: ["audience"],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.responseUi).toEqual({
      variant: "markdown",
      selectionMode: "single",
      allowFreeText: true,
    });
    expect(parsed.repairs).toEqual([
      { path: "responseUi", expected: "object", kind: "decoded-json-string" },
    ]);
  });

  it("recursively repairs arrays only when the schema expects an array", () => {
    const schema = z.object({
      config: z.object({ values: z.array(z.string()) }),
      content: z.string(),
    });
    const parsed = parseToolInput(schema, {
      config: JSON.stringify({ values: JSON.stringify(["a", "b"]) }),
      content: '{"must":"remain text"}',
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data).toEqual({
      config: { values: ["a", "b"] },
      content: '{"must":"remain text"}',
    });
    expect(parsed.repairs.map((repair) => repair.path)).toEqual(["config", "config.values"]);
  });

  it("keeps malformed JSON for Zod to reject", () => {
    const parsed = parseToolInput(z.object({ config: z.object({ enabled: z.boolean() }) }), {
      config: "{not-json}",
    });

    expect(parsed.success).toBe(false);
    expect(parsed.repairs).toEqual([]);
  });

  it("exposes a model-only responseUi schema without application resolved state", () => {
    const schema = toToolSchema(askUserTool).inputSchema;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties).toHaveProperty("responseUi");
    expect(properties).not.toHaveProperty("question");
    expect(JSON.stringify(properties.responseUi)).not.toContain("resolved");

    const card = toToolCard(askUserTool);
    expect(card.parameterSummary.message.type).toBe("string");
    expect(card.parameterSummary.responseUi.type).toBe("object");
    expect(card.examples.length).toBeGreaterThan(0);
  });

  it("applies schema-guided normalization at the main runtime boundary", async () => {
    const requests: AgentModelRequest[] = [];
    const response: AgentModelResponse = {
      provider: "anthropic",
      model: "test-model",
      content: [
        {
          type: "tool_use",
          id: "call-ask-user",
          name: "AskUser",
          input: {
            message: "请选择受众",
            responseUi: JSON.stringify({
              variant: "choices",
              options: [
                { id: "manager", title: "管理者" },
                { id: "student", title: "学生" },
              ],
            }),
          },
        },
      ],
    };
    const gateway: AgentModelGateway = {
      async queryModel(request) {
        requests.push(request);
        return response;
      },
      async *queryModelStream(request) {
        requests.push(request);
        yield { type: "complete" as const, content: response.content };
      },
    };
    const registry = new ToolRegistry();
    registry.register(askUserTool);
    const progress: string[] = [];

    const result = await createPptRuntime(registry, gateway).run({
      threadId: "ask-user-normalization",
      request: "做一份培训 PPT",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      onProgress: (event) => progress.push(event.type),
    });

    expect(result.type).toBe("ask_user");
    if (result.type !== "ask_user") throw new Error("Expected AskUser result");
    expect(result.question?.variant).toBe("choices");
    expect(result.question?.options?.map((option) => option.id)).toEqual(["manager", "student"]);
    expect(requests).toHaveLength(1);
    expect(progress).toContain("tool-state");
  });
});
