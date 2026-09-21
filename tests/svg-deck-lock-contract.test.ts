import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPptToolRegistry } from "@main/plugins/ppt/tools";
import {
  editFileContract,
  readFileContract,
  writeFileContract,
} from "@main/plugins/ppt/workspace-files";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESIGN_SYSTEM } from "../src/design-system";
import { classifyToolExecutionError } from "../src/main/agent/runtime/tools/tool-execution-error";
import {
  WorkspaceFileError,
  WorkspaceFileService,
} from "../src/main/agent/tools/files/workspace-file-service";
import type { ToolContext } from "../src/main/agent/tools/tool-definition";
import { slideThumbnailService } from "../src/main/plugins/ppt/adapters/electron-thumbnail-service";
import { buildWorkspaceSection } from "../src/main/plugins/ppt/prompts/prompt-sections";
import { loadWorkspaceSvgPage } from "../src/main/plugins/ppt/svg-page-loader";
import { previewSvgPageTool } from "../src/main/plugins/ppt/tools/preview-svg-page";
import {
  readSvgDeckLocks,
  SVG_DECK_DESIGN_SPEC_MINI_SCHEMA,
  SVG_DECK_PAGE_PLAN_MINI_SCHEMA,
  validateSvgDeckLockContent,
} from "../src/main/plugins/ppt/tools/svg-deck-locks";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("SVG deck lock contract", () => {
  it("accepts the shared mini schemas as valid lock content", () => {
    expect(() =>
      validateSvgDeckLockContent("design/design-spec.json", SVG_DECK_DESIGN_SPEC_MINI_SCHEMA),
    ).not.toThrow();
    expect(() =>
      validateSvgDeckLockContent("slides/page-plan.json", SVG_DECK_PAGE_PLAN_MINI_SCHEMA),
    ).not.toThrow();
  });

  it("rejects invalid design-spec writes before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppt-lock-write-"));
    temporaryRoots.push(root);
    const fileService = new WorkspaceFileService(root);
    const context = { workspaceRoot: root, fileService };

    await expect(
      writeFileContract.execute(
        {
          path: "design/design-spec.json",
          content: JSON.stringify({ version: 1 }),
        },
        context,
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof WorkspaceFileError &&
        error.code === "LOCK_SCHEMA_INVALID" &&
        error.message.includes('LoadSkill("ppt-design")') &&
        error.message.includes("communicationContract"),
    );

    await expect(fileService.read("design/design-spec.json")).rejects.toThrow();

    const classified = classifyToolExecutionError(
      new WorkspaceFileError(
        "LOCK_SCHEMA_INVALID",
        "design/design-spec.json does not satisfy the SVG deck lock schema",
      ),
    );
    expect(classified.sideEffects).toBe("none");
    expect(classified.errorCode).toBe("LOCK_SCHEMA_INVALID");
  });

  it("rejects design-spec writes that ignore a custom template policy pin", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppt-lock-template-pin-"));
    temporaryRoots.push(root);
    const fileService = new WorkspaceFileService(root);
    const context = { workspaceRoot: root, fileService };

    await writeFileContract.execute(
      {
        path: "design/template-policy.json",
        content: JSON.stringify(
          {
            version: 1,
            mode: "custom",
            defaultTemplateId: "builtin/swiss-minimal",
            customTemplateId: "uploaded/brand-kit",
            customTemplateRevisionId: "abc123",
          },
          null,
          2,
        ),
      },
      context,
    );

    await expect(
      writeFileContract.execute(
        {
          path: "design/design-spec.json",
          content: SVG_DECK_DESIGN_SPEC_MINI_SCHEMA,
        },
        context,
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof WorkspaceFileError &&
        error.code === "LOCK_SCHEMA_INVALID" &&
        (error.message.includes("pins template") ||
          error.message.includes("missing under design/templates")),
    );
  });

  it("rejects EditFile when the resulting page-plan would be invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppt-lock-edit-"));
    temporaryRoots.push(root);
    const fileService = new WorkspaceFileService(root);
    const context = { workspaceRoot: root, fileService };
    await writeFileContract.execute(
      {
        path: "slides/page-plan.json",
        content: SVG_DECK_PAGE_PLAN_MINI_SCHEMA,
      },
      context,
    );
    const read = await readFileContract.execute(
      {
        path: "slides/page-plan.json",
      },
      context,
    );

    await expect(
      editFileContract.execute(
        {
          path: "slides/page-plan.json",
          old_string: '"coreMessage": "..."',
          new_string: '"coreMessage": ""',
          expected_version: read.version,
        },
        context,
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof WorkspaceFileError &&
        error.code === "LOCK_SCHEMA_INVALID" &&
        error.message.includes('LoadSkill("ppt-design-layout")'),
    );
  });

  it("fails PreviewSvgPage lock precheck before capturing a thumbnail", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppt-lock-preview-"));
    temporaryRoots.push(root);
    const fileService = new WorkspaceFileService(root);
    await fileService.write(
      "slides/svg/P01.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
        '<rect width="1280" height="720" fill="#111827"/>' +
        '<text x="80" y="180" fill="#ffffff" font-size="64">First</text>' +
        "</svg>",
    );
    const capture = vi.spyOn(slideThumbnailService, "captureSlide").mockResolvedValue({
      pngBase64: "should-not-render",
      width: 640,
      height: 360,
      mimeType: "image/png",
    });

    await expect(
      previewSvgPageTool.execute(
        {
          path: "slides/svg/P01.svg",
          includeThumbnail: true,
        },
        createPreviewContext(root, fileService),
      ),
    ).rejects.toThrow(/PreviewSvgPage lock precheck failed/);
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not grant mutation authority through internal lock or SVG reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppt-lock-inspect-"));
    temporaryRoots.push(root);
    const writer = new WorkspaceFileService(root);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" ' +
      'viewBox="0 0 1280 720"><rect width="1280" height="720"/></svg>';
    await writer.write("design/design-spec.json", SVG_DECK_DESIGN_SPEC_MINI_SCHEMA);
    await writer.write("slides/page-plan.json", SVG_DECK_PAGE_PLAN_MINI_SCHEMA);
    await writer.write("slides/svg/P01.svg", svg);

    const reader = new WorkspaceFileService(root);
    await readSvgDeckLocks(reader, "test");
    await loadWorkspaceSvgPage({
      requestedPath: "slides/svg/P01.svg",
      workspaceRoot: root,
      fileService: reader,
    });

    await expect(
      reader.write("slides/page-plan.json", SVG_DECK_PAGE_PLAN_MINI_SCHEMA),
    ).rejects.toMatchObject({ code: "READ_REQUIRED" });
    await expect(reader.write("slides/svg/P01.svg", svg)).rejects.toMatchObject({
      code: "READ_REQUIRED",
    });
  });

  it("exposes invalid artifact reasons and injects the lock contract in the workspace prompt", () => {
    const section = buildWorkspaceSection({
      stage: "discover",
      workspaceRoot: "/tmp/project",
      artifacts: {
        designSpec: false,
        templatePolicy: false,
        templatePack: false,
        pagePlan: false,
        pageSvg: false,
        assets: false,
        deck: false,
        exportHistory: false,
        brief: false,
        outline: false,
        research: false,
      },
      artifactDetails: {
        designSpec: {
          path: "design/design-spec.json",
          status: "invalid",
          verified: false,
          reason: "version: Required; canvas: Required",
        },
        templatePolicy: {
          path: "design/template-policy.json",
          status: "missing",
          verified: false,
          reason: "File does not exist.",
        },
        templatePack: {
          path: "design/template-pack.json",
          status: "missing",
          verified: false,
          reason: "File does not exist.",
        },
        pagePlan: {
          path: "slides/page-plan.json",
          status: "missing",
          verified: false,
          reason: "File does not exist.",
        },
        pageSvg: {
          path: "slides/svg",
          status: "missing",
          verified: false,
        },
        assets: {
          path: "assets",
          status: "missing",
          verified: false,
        },
        deck: {
          path: "deck/snapshot.json",
          status: "missing",
          verified: false,
        },
        exportHistory: {
          path: "history/exports.json",
          status: "missing",
          verified: false,
        },
        brief: {
          path: "brief.md",
          status: "missing",
          verified: false,
        },
        outline: {
          path: "outline.md",
          status: "missing",
          verified: false,
        },
        research: {
          path: "research",
          status: "missing",
          verified: false,
        },
      },
    });

    expect(section).toContain("design/design-spec.json: invalid: version: Required");
    expect(section).toContain("slides/page-plan.json: missing");
    expect(section).toContain("### SVG Deck Lock Contract");
    expect(section).toContain('LoadSkill("ppt-design")');
    expect(section).toContain(DEFAULT_DESIGN_SYSTEM.visualStyle);
  });
});

function createPreviewContext(
  workspaceRoot: string,
  fileService: WorkspaceFileService,
): ToolContext {
  return {
    presentation: createStarterPresentation(),
    selectedElementIds: [],
    discoverySession: { discoveredToolNames: new Set() },
    registry: createPptToolRegistry(),
    messageHistory: [],
    workspaceRoot,
    fileService,
  };
}
