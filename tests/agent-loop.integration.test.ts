import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommitGate } from "../src/main/agent/gate/commit-gate";
import { RiskPolicy } from "../src/main/agent/gate/risk-policy";
import { AgentGateway } from "../src/main/agent/gateway";
import { AgentRuntime } from "../src/main/agent/runtime/agent-runtime";
import { AgentService } from "../src/main/agent/service";
import { scanSkills } from "../src/main/agent/skills/loadSkillsDir";
import { createDefaultToolRegistry } from "../src/main/agent/tools/tool-registry";
import { DeckExportService } from "../src/main/deck/deck-export-service";
import { inspectPptxExport } from "../src/main/deck/pptx-postflight";
import { slideThumbnailService } from "../src/main/deck/slide-thumbnail-service";
import { ContentAddressedBlobStore } from "../src/main/presentation-lifecycle/content-addressed-blob-store";
import { PresentationCommitService } from "../src/main/presentation-lifecycle/presentation-commit-service";
import { PresentationLifecycleOrchestrator } from "../src/main/presentation-lifecycle/presentation-lifecycle-orchestrator";
import { PresentationLifecycleRepository } from "../src/main/presentation-lifecycle/presentation-lifecycle-repository";
import { PresentationLifecycleToolBridge } from "../src/main/presentation-lifecycle/presentation-lifecycle-tool-bridge";
import { FileSessionStore } from "../src/main/session-store";
import { CommandBus } from "../src/shared/commands";
import type { AgentRunResult } from "../src/shared/ipc";
import { asPresentationId, asProjectId } from "../src/shared/presentation-lifecycle";
import {
  hasEnvironment,
  requiredEnvironment,
  resolveAnthropicBaseURL,
  resolveOpenAiBaseURL,
} from "./integration-env";

const OPENAI_AVAILABLE = hasEnvironment("OPENAI_API_KEY", "OPENAI_MODEL");
const ANTHROPIC_AVAILABLE = hasEnvironment("ANTHROPIC_API_KEY", "ANTHROPIC_MODEL");
const PROVIDER_AVAILABLE = OPENAI_AVAILABLE || ANTHROPIC_AVAILABLE;
const LAYER1_TIMEOUT_MS = 900_000;
const PROMPT = [
  "Create exactly two SVG-native slides about why automated tests matter.",
  "Hard constraints:",
  "- Do not ask the user questions. Do not call AskUser.",
  "- Do not search the web. Do not spawn teammates.",
  "- Use ResolveProjectTemplate / the builtin default template.",
  "- Write design/design-spec.json, slides/page-plan.json, slides/svg/P01.svg, and slides/svg/P02.svg.",
  "- PreviewSvgPage every page, then SubmitSvgDeck.",
  "- Each page is a complete 1280x720 SVG. Solid fills or simple geometry only. No raster images.",
  "- P01 is a cover. P02 lists three short claims.",
].join("\n");

const temporaryRoots: string[] = [];
const repositories: PresentationLifecycleRepository[] = [];
const sessionStores: FileSessionStore[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const repository of repositories.splice(0)) repository.close();
  for (const store of sessionStores.splice(0)) store.close();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function resolveProvider(): {
  provider: "openai" | "anthropic";
  model: string;
  apiKey: string;
  baseURL?: string;
} {
  if (OPENAI_AVAILABLE) {
    const baseURL = resolveOpenAiBaseURL();
    return {
      provider: "openai",
      model: requiredEnvironment("OPENAI_MODEL"),
      apiKey: requiredEnvironment("OPENAI_API_KEY"),
      ...(baseURL ? { baseURL } : {}),
    };
  }
  const baseURL = resolveAnthropicBaseURL();
  return {
    provider: "anthropic",
    model: requiredEnvironment("ANTHROPIC_MODEL"),
    apiKey: requiredEnvironment("ANTHROPIC_API_KEY"),
    ...(baseURL ? { baseURL } : {}),
  };
}

async function createTemporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

describe("Layer 1 real-gateway agent loop", () => {
  it.skipIf(!PROVIDER_AVAILABLE)(
    "creates an SVG deck through AgentService, CommitGate, and PPTX export",
    async () => {
      const selection = resolveProvider();
      const root = await createTemporaryRoot("agent-loop-e2e-");
      const workspaceRoot = join(root, "workspace");
      await mkdir(workspaceRoot, { recursive: true });
      const sessionStore = new FileSessionStore(
        join(root, "conversations.sqlite"),
        join(root, "projects"),
      );
      sessionStores.push(sessionStore);
      await sessionStore.initialize();
      const bootstrap = await sessionStore.createSession({
        title: "Layer 1 agent loop",
        rootPath: workspaceRoot,
      });
      const snapshot = bootstrap.activeSession!;
      const sessionId = snapshot.session.id;
      const projectRoot = snapshot.project?.rootPath;
      if (!projectRoot) throw new Error("Session sandbox was not materialized.");

      vi.spyOn(slideThumbnailService, "captureSlide").mockResolvedValue({
        pngBase64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        width: 1280,
        height: 720,
        mimeType: "image/png",
      });

      const presentationId = asPresentationId(snapshot.presentation.id);
      const projectId = asProjectId(
        sessionStore.conversationDatabase.ensureProject(projectRoot, snapshot.presentation.title),
      );
      const repository = new PresentationLifecycleRepository({
        filePath: sessionStore.conversationDatabase.filePath,
        connection: sessionStore.conversationDatabase.sqliteConnection,
      });
      repositories.push(repository);
      const lifecycle = new PresentationLifecycleOrchestrator(repository);
      const blobStore = new ContentAddressedBlobStore(join(root, "blobs"));
      const commandBus = new CommandBus(snapshot.presentation);
      const commitService = new PresentationCommitService(
        sessionId,
        projectId,
        presentationId,
        commandBus,
        sessionStore,
        lifecycle,
        blobStore,
      );
      const gateway = new AgentGateway();
      const modelSelection = gateway.configure({
        provider: selection.provider,
        model: selection.model,
        apiKey: selection.apiKey,
        ...(selection.baseURL ? { baseURL: selection.baseURL } : {}),
      });
      const skillRegistry = await scanSkills(resolve("skills"));
      expect(
        skillRegistry.size,
        "repo skills/ must load for the SVG-native workflow",
      ).toBeGreaterThan(0);
      const runtime = new AgentRuntime(
        createDefaultToolRegistry(),
        gateway,
        skillRegistry,
        sessionStore.conversationDatabase,
        ({ queryId, options }) => {
          if (options.runId) {
            sessionStore.conversationDatabase.bindRunQueryId(options.runId, queryId);
          }
          return new PresentationLifecycleToolBridge(
            lifecycle,
            projectId,
            snapshot.presentation.id,
            queryId,
            options.request,
            blobStore,
          );
        },
      );
      const service = new AgentService(
        commandBus,
        runtime,
        new CommitGate(new RiskPolicy()),
        projectRoot,
        undefined,
        undefined,
        undefined,
        sessionStore.conversationDatabase,
        join(root, "runtime", sessionId),
        lifecycle,
        commitService,
        blobStore,
      );

      const runId = crypto.randomUUID();
      const completedTools: string[] = [];
      sessionStore.conversationDatabase.beginRun({
        runId,
        sessionId,
        threadId: runId,
        provider: modelSelection.provider,
        model: modelSelection.model,
        request: PROMPT,
      });

      const started = await service.start(
        PROMPT,
        modelSelection,
        "AUTO",
        (event) => {
          if (event.type === "tool-state" && event.status === "completed") {
            completedTools.push(event.toolName);
          }
        },
        undefined,
        [],
        undefined,
        runId,
        { enabled: true, mainMaxSteps: 80, subMaxSteps: 16 },
      );

      const result = await resolveToAppliedPresentation(service, started, completedTools);
      expect(result.status).toBe("completed");
      if (result.status !== "completed") {
        throw new Error(`Expected an applied presentation, received ${result.status}.`);
      }

      const presentation = result.presentation;
      expect(presentation.slides.length).toBeGreaterThanOrEqual(1);
      expect(presentation.slides.every((slide) => slide.visualSource.kind === "svg")).toBe(true);

      await expectWorkspaceArtifact(projectRoot, "design/design-spec.json");
      await expectWorkspaceArtifact(projectRoot, "slides/page-plan.json");
      const svgFiles = (await readdir(join(projectRoot, "slides", "svg"))).filter((name) =>
        name.toLowerCase().endsWith(".svg"),
      );
      expect(svgFiles.length).toBeGreaterThanOrEqual(1);

      const projection = lifecycle.getProjection(presentationId);
      expect(projection?.presentationRevisionId).toBeTruthy();

      const exportPath = join(root, "layer1-export.pptx");
      const exported = await new DeckExportService().exportDeck({
        presentation,
        options: {},
        filePath: exportPath,
      });
      expect(exported.slideCount).toBe(presentation.slides.length);
      const report = await inspectPptxExport(exportPath, presentation);
      expect(report.passed).toBe(true);
      expect(report.errors).toEqual([]);
    },
    LAYER1_TIMEOUT_MS,
  );
});

async function resolveToAppliedPresentation(
  service: AgentService,
  result: AgentRunResult,
  completedTools: string[],
): Promise<AgentRunResult> {
  const toolSummary = completedTools.join(",") || "(none)";
  if (result.status === "waiting-user") {
    throw new Error(
      `Layer 1 agent asked the user instead of finishing. tools=${toolSummary} message=${result.message}`,
    );
  }
  if (result.status === "chat") {
    throw new Error(
      `Layer 1 agent ended in chat without a proposal. tools=${toolSummary} message=${result.message.slice(0, 300)}`,
    );
  }
  if (result.status === "failed") {
    throw new Error(`Layer 1 agent failed: ${result.error}. tools=${toolSummary}`);
  }
  if (result.status === "interrupted" || result.status === "rejected") {
    throw new Error(`Layer 1 agent ended as ${result.status}. tools=${toolSummary}`);
  }
  if (result.status === "approval-required") {
    return service.resumeProposal(result.approval.proposalId, true);
  }
  return result;
}

async function expectWorkspaceArtifact(workspaceRoot: string, relativePath: string): Promise<void> {
  const filePath = join(workspaceRoot, ...relativePath.split("/"));
  const info = await stat(filePath);
  expect(info.isFile(), relativePath).toBe(true);
  const body = await readFile(filePath, "utf8");
  expect(body.trim().length, relativePath).toBeGreaterThan(0);
}
