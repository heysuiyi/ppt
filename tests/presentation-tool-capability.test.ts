import { requirePptCapability } from "@main/plugins/ppt/context";
import { createPptToolRegistry } from "@main/plugins/ppt/tools";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolPreflight } from "../src/main/agent/runtime/tools/tool-preflight";
import { executeExtraToolTool } from "../src/main/agent/tools/core/execute-extra-tool";
import { WorkspaceFileService } from "../src/main/agent/tools/files/workspace-file-service";
import type {
  PptLifecycleToolBridge,
  ToolContext,
  ToolDefinition,
} from "../src/main/agent/tools/tool-definition";
import { ToolRegistry } from "../src/main/agent/tools/tool-registry";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";
import {
  asPptCapabilityRequestId,
  asPptJobId,
  asPresentationId,
  asQueryId,
  type PptCapability,
  type PptJobProjection,
  pptJobProjectionSchema,
} from "../src/shared/presentation-lifecycle";

const PRESENTATION_TOOL_NAMES = [
  "GetDesignReference",
  "ResolveProjectTemplate",
  "PreviewSlide",
  "PreviewSvgPage",
  "SearchSlideImages",
  "SubmitPptReview",
  "SubmitSvgDeck",
  "WriteFile",
  "EditFile",
] as const;

function projection(capability: PptCapability): PptJobProjection {
  return pptJobProjectionSchema.parse({
    jobId: asPptJobId("job-capability-test"),
    presentationId: asPresentationId("presentation-capability-test"),
    capability,
    requestId: asPptCapabilityRequestId("request-capability-test"),
    queryId: asQueryId("query-capability-test"),
    status: "running",
    stage: "intent",
    stateRevision: 1,
    committedArtifacts: [],
    staleArtifacts: [],
    updatedAt: "2026-07-31T00:00:00.000Z",
  });
}

function lifecycleBridge(activeCapability?: PptCapability): PptLifecycleToolBridge & {
  requireActiveCapability: ReturnType<typeof vi.fn>;
} {
  const activeProjection = activeCapability ? projection(activeCapability) : undefined;
  const requireActiveCapability = vi.fn((allowedCapabilities?: readonly PptCapability[]) => {
    if (!activeProjection) {
      throw new Error("Call BeginPptCapability before using Presentation tools.");
    }
    if (allowedCapabilities && !allowedCapabilities.includes(activeProjection.capability)) {
      throw new Error(`PPT capability ${activeProjection.capability} cannot use this tool.`);
    }
    return activeProjection;
  });
  return {
    queryId: asQueryId("query-capability-test"),
    withTransaction: (operation) => operation(),
    observeArtifactChanges: async () => undefined,
    beginCapability: ({ capability }) => projection(capability),
    requireActiveCapability,
    commitArtifact: () => {
      throw new Error("not used");
    },
    storeBlob: async () => {
      throw new Error("not used");
    },
    assertBlob: async () => undefined,
    submitReview: () => {
      throw new Error("not used");
    },
  };
}

const deferredRestyleTool: ToolDefinition<any, any> = {
  name: "DeferredRestyleProbe",
  description: "Deferred presentation probe for capability preflight.",
  category: "deferred",
  loadPolicy: "deferred",
  inputSchema: z.object({ note: z.string().optional() }),
  risk: "low",
  validateContext: requirePptCapability(["edit", "restyle"]),
  execute: async () => ({ ok: true }),
};

function createCapabilityTestRegistry(): ToolRegistry {
  const defaults = createPptToolRegistry();
  const registry = new ToolRegistry();
  for (const tool of defaults.getCoreTools()) {
    registry.register(tool);
  }
  // Product default registry omits the empty Deferred discovery shells;
  // capability preflight still exercises ExecuteExtraTool → deferred target.
  registry.register(executeExtraToolTool);
  registry.register(deferredRestyleTool);
  return registry;
}

function context(lifecycle?: PptLifecycleToolBridge): ToolContext {
  return {
    presentation: createStarterPresentation(),
    selectedElementIds: [],
    discoverySession: {
      discoveredToolNames: new Set(["DeferredRestyleProbe"]),
    },
    registry: createCapabilityTestRegistry(),
    messageHistory: [],
    workspaceRoot: "C:\\workspace",
    fileService: new WorkspaceFileService("C:\\workspace"),
    presentationLifecycle: lifecycle,
  };
}

async function prepare(input: {
  name: string;
  args: Record<string, unknown>;
  lifecycle?: PptLifecycleToolBridge;
}) {
  const toolContext = context(input.lifecycle);
  return new ToolPreflight(toolContext.registry).prepare({
    toolCall: {
      type: "tool_use",
      id: `call-${input.name}`,
      name: input.name,
      input: input.args,
    },
    context: toolContext,
    threadId: "thread-capability-test",
    requestToolApproval: async () => true,
    policyGuidance: async () => undefined,
  });
}

describe("Presentation tool capability preflight", () => {
  it("marks every product Presentation work tool with an explicit capability contract", () => {
    const registry = createPptToolRegistry();
    for (const name of PRESENTATION_TOOL_NAMES) {
      expect(registry.get(name)?.validateContext, name).toBeTruthy();
    }
  });

  it("rejects a core Presentation tool before BeginPptCapability", async () => {
    const lifecycle = lifecycleBridge();
    const result = await prepare({
      name: "PreviewSvgPage",
      args: { path: "slides/svg/P01.svg" },
      lifecycle,
    });

    expect(result).toMatchObject({
      type: "immediate_result",
      kind: "unavailable",
      outcome: {
        error: expect.stringContaining("BeginPptCapability"),
      },
    });
    expect(lifecycle.requireActiveCapability).toHaveBeenCalledWith([
      "create",
      "edit",
      "restyle",
      "review",
    ]);
  });

  it("checks the resolved deferred tool and rejects a capability mismatch", async () => {
    const lifecycle = lifecycleBridge("create");
    const result = await prepare({
      name: "ExecuteExtraTool",
      args: {
        toolName: "DeferredRestyleProbe",
        toolArgs: { note: "probe" },
      },
      lifecycle,
    });

    expect(result).toMatchObject({
      type: "immediate_result",
      kind: "unavailable",
      tool: { name: "DeferredRestyleProbe" },
      outcome: {
        error: expect.stringContaining("cannot use this tool"),
      },
    });
    expect(lifecycle.requireActiveCapability).toHaveBeenCalledWith(["edit", "restyle"]);
  });

  it("allows a review capability to render and record an SVG preview", async () => {
    const lifecycle = lifecycleBridge("review");
    const result = await prepare({
      name: "PreviewSvgPage",
      args: { path: "slides/svg/P01.svg" },
      lifecycle,
    });

    expect(result).toMatchObject({ type: "ready" });
    expect(lifecycle.requireActiveCapability).toHaveBeenCalledWith([
      "create",
      "edit",
      "restyle",
      "review",
    ]);
  });

  it("guards Presentation-owned writes but leaves unrelated workspace writes alone", async () => {
    const lifecycle = lifecycleBridge();
    const guarded = await prepare({
      name: "WriteFile",
      args: {
        path: "draft/../slides/svg/P01.svg",
        content: "<svg />",
      },
      lifecycle,
    });
    expect(guarded).toMatchObject({
      type: "immediate_result",
      kind: "unavailable",
    });

    const unrelated = await prepare({
      name: "WriteFile",
      args: {
        path: "notes/research.md",
        content: "Research notes",
      },
      lifecycle,
    });
    expect(unrelated).toMatchObject({ type: "ready" });
  });

  it("keeps Presentation tools available to isolated runtimes without a lifecycle bridge", async () => {
    const result = await prepare({
      name: "ExecuteExtraTool",
      args: {
        toolName: "DeferredRestyleProbe",
        toolArgs: { note: "probe" },
      },
    });

    expect(result).toMatchObject({
      type: "ready",
      prepared: {
        tool: { name: "DeferredRestyleProbe" },
      },
    });
  });
});
