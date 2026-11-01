import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolExecutionEngine } from "../app/main/agent/runtime/tools/tool-execution-engine";
import type { ToolContext, ToolDefinition } from "../app/main/agent/tools/tool-definition";
import { ToolRegistry } from "../app/main/agent/tools/tool-registry";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

describe("multimodal tool results", () => {
  it("delivers mapped image blocks without serializing base64 into text", async () => {
    const schema = z.object({});
    const tool: ToolDefinition<typeof schema, { png: string }> = {
      name: "MultimodalPreview",
      description: "Test preview",
      category: "core",
      loadPolicy: "core",
      inputSchema: schema,
      outputSchema: z.object({ png: z.string() }),
      risk: "low",
      execute: async () => ({ png: "cG5n" }),
      mapResultToModelBlocks: (result) => [
        { type: "text", text: "Rendered preview" },
        { type: "image", mediaType: "image/png", data: result.png },
      ],
    };
    const registry = new ToolRegistry();
    registry.register(tool);

    const outcome = await new ToolExecutionEngine().execute({
      tool,
      args: {},
      context: createContext(registry),
      toolCall: {
        type: "tool_use",
        id: "preview-call",
        name: tool.name,
        input: {},
      },
      threadId: "preview-thread",
      async runPostToolUseHook() {
        return [];
      },
    });

    expect(outcome.modelResult.content).toEqual([
      { type: "text", text: "Rendered preview" },
      { type: "image", mediaType: "image/png", data: "cG5n" },
    ]);
    expect(outcome.preparedResult?.modelContent).toBe("Rendered preview");
  });
});

function createContext(registry: ToolRegistry): ToolContext {
  return {
    presentation: createStarterPresentation(),
    selectedElementIds: [],
    discoverySession: { discoveredToolNames: new Set() },
    registry,
    messageHistory: [],
  };
}
