import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentModelContentBlock,
  AgentModelGateway,
  AgentModelRequest,
} from "@main/agent/gateway";
import { DurableRunStore } from "@main/agent/persistence/durable-run-store";
import { AgentRunFactory } from "@main/agent/runtime/agent-run-factory";
import { AgentRuntime } from "@main/agent/runtime/agent-runtime";
import { workspaceFileTools as teammateFileTools } from "@main/agent/subagent/workspace-tools";
import { createHostToolRegistry } from "@main/agent/tools/host-tools";
import type { ToolContext } from "@main/agent/tools/tool-definition";
import { createPptFilePolicy } from "@main/plugins/ppt/file-policy";
import { createPptRuntime } from "@main/plugins/ppt/plugin";
import { formatPptTaskPlanProjection } from "@main/plugins/ppt/task/ppt-task-composer";
import { createPptToolRegistry } from "@main/plugins/ppt/tools";
import { DeckExportService, DeckValidationService, inspectPptxExport } from "@ppt/core";
import { createStarterPresentation } from "@shared/presentation-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceFileService } from "@agent-harness/tools/workspace-files";
import { createExportGoldenPresentation } from "./fixtures/export-golden-deck";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "ppt-plugin-boundary-"));
  directories.push(directory);
  return directory;
}

function gatewayFor(turns: AgentModelContentBlock[][]) {
  const requests: AgentModelRequest[] = [];
  const gateway: AgentModelGateway = {
    async queryModel(request) {
      requests.push(request);
      const content = turns.shift();
      if (!content) throw new Error("Unexpected model turn");
      return { provider: "openai", model: "boundary-test", content };
    },
    async *queryModelStream(request) {
      yield { type: "complete", content: (await this.queryModel(request)).content };
    },
  };
  return { gateway, requests };
}

describe("PPT plugin boundaries", () => {
  it("runs and persists ordinary chat without a Presentation, PPT prompt or PPT job", async () => {
    const root = await workspace();
    const { gateway, requests } = gatewayFor([[{ type: "text", text: "Hello" }]]);
    const runtime = new AgentRuntime(new AgentRunFactory(createHostToolRegistry(), gateway));
    await expect(
      runtime.run({ threadId: "plain-chat", request: "Hello", workspaceRoot: root }),
    ).resolves.toEqual({ type: "message", content: "Hello" });
    expect(requests[0].systemPrompt).not.toMatch(/PPT|Presentation|SubmitSvgDeck|ppt-workflow/);
    const checkpoint = await new DurableRunStore(root).load("plain-chat");
    expect(checkpoint).toMatchObject({ version: 2, status: "completed" });
    expect(checkpoint).not.toHaveProperty("baseRevision");
    expect(checkpoint).not.toHaveProperty("pptTaskPlan");
  });

  it("runs host read/edit/write tools without activating PPT file rules", async () => {
    const root = await workspace();
    await writeFile(join(root, "notes.txt"), "before", "utf8");
    const { gateway } = gatewayFor([
      [{ type: "tool_use", id: "read", name: "ReadFile", input: { path: "notes.txt" } }],
      [
        {
          type: "tool_use",
          id: "edit",
          name: "EditFile",
          input: { path: "notes.txt", old_string: "before", new_string: "after" },
        },
      ],
      [
        {
          type: "tool_use",
          id: "write",
          name: "WriteFile",
          input: { path: "design/design-spec.json", content: "ordinary file" },
        },
      ],
      [{ type: "text", text: "Done" }],
    ]);
    const runtime = new AgentRuntime(new AgentRunFactory(createHostToolRegistry(), gateway));
    await runtime.run({
      threadId: "plain-files",
      request: "Update files",
      workspaceRoot: root,
      requestToolApproval: async () => true,
    });
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("after");
    expect(await readFile(join(root, "design/design-spec.json"), "utf8")).toBe("ordinary file");
  });

  it("keeps domain tools out of the host registry and validates required PPT input", async () => {
    const host = createHostToolRegistry();
    const ppt = createPptToolRegistry();
    for (const name of [
      "BeginPptCapability",
      "PreviewSvgPage",
      "SubmitSvgDeck",
      "SubmitPptReview",
      "GetSelection",
    ]) {
      expect(host.get(name)).toBeUndefined();
      expect(ppt.get(name)).toBeDefined();
    }
    const { gateway, requests } = gatewayFor([]);
    await expect(
      createPptRuntime(ppt, gateway).run({ threadId: "missing-ppt", request: "Create" }),
    ).rejects.toThrow("Presentation snapshot");
    expect(requests).toHaveLength(0);
  });

  it("refreshes the PPT prompt after assessment and restores the plan in a new runtime", async () => {
    const root = await workspace();
    const presentation = createStarterPresentation();
    const { gateway, requests } = gatewayFor([
      [
        {
          type: "tool_use",
          id: "assess",
          name: "SetPptTaskAssessment",
          input: {
            assessment: {
              operation: "create",
              deliverable: "deck",
              dims: {
                workload: "low",
                factBurden: "low",
                visual: "low",
                coupling: "low",
                uncertainty: "low",
              },
            },
          },
        },
      ],
      [
        {
          type: "tool_use",
          id: "ask",
          name: "AskUser",
          input: { message: "Who is the audience?" },
        },
      ],
    ]);
    const input = {
      threadId: "ppt-plan-resume",
      request: "Create slides",
      workspaceRoot: root,
      presentationSnapshot: presentation,
    };
    await expect(
      createPptRuntime(createPptToolRegistry(), gateway).run(input),
    ).resolves.toMatchObject({ type: "ask_user" });
    const checkpoint = await new DurableRunStore(root).load(input.threadId);
    if (checkpoint?.version !== 2 || !checkpoint.pptTaskPlan)
      throw new Error("Missing persisted plan");
    expect(checkpoint.baseRevision).toBe(presentation.revision);
    const planText = formatPptTaskPlanProjection(checkpoint.pptTaskPlan);
    expect(requests[0].systemPrompt).not.toContain(planText);
    expect(requests[1].systemPrompt).toContain(planText);
    const resumed = gatewayFor([[{ type: "text", text: "Audience noted" }]]);
    await createPptRuntime(createPptToolRegistry(), resumed.gateway).run({
      ...input,
      request: "Engineers",
      startMode: { type: "resume_query", reason: "waiting_user" },
    });
    expect(resumed.requests[0].systemPrompt).toContain(planText);
  });

  it("rejects malformed PPT lock files through both plugin and teammate file surfaces", async () => {
    const root = await workspace();
    const registry = createPptToolRegistry();
    const context: ToolContext = {
      selectedElementIds: [],
      registry,
      discoverySession: { discoveredToolNames: new Set() },
      messageHistory: [],
      workspaceRoot: root,
      fileService: new WorkspaceFileService(root),
    };
    const args = { path: "design/design-spec.json", content: "invalid lock" };
    await expect(registry.get("WriteFile")!.execute(args, context)).rejects.toMatchObject({
      code: "LOCK_SCHEMA_INVALID",
    });
    await expect(
      teammateFileTools
        .find((tool) => tool.name === "WriteFile")!
        .execute(args, {
          workspaceRoot: root,
          filePolicy: createPptFilePolicy(),
        }),
    ).rejects.toMatchObject({ code: "LOCK_SCHEMA_INVALID" });
    await expect(stat(join(root, args.path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exports and postflights real PPTX bytes through the headless public core", async () => {
    const root = await workspace();
    const presentation = createExportGoldenPresentation();
    const validation = new DeckValidationService().validate(presentation);
    expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    const result = await new DeckExportService().exportDeck({
      presentation,
      options: {},
      filePath: join(root, "core.pptx"),
    });
    const report = await inspectPptxExport(result.filePath, presentation);
    expect(report.passed).toBe(true);
    expect(report.slideCount).toBe(presentation.slides.length);
  });
});
