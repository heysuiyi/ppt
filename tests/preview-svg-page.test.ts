import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPptToolRegistry } from "@main/plugins/ppt/tools";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceFileService } from "../src/main/agent/tools/files/workspace-file-service";
import type { ToolContext } from "../src/main/agent/tools/tool-definition";
import { previewSvgPageTool } from "../src/main/plugins/ppt/tools/preview-svg-page";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("PreviewSvgPage", () => {
  it("validates the same workspace source used by SubmitSvgDeck", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-ppt-preview-svg-"));
    temporaryRoots.push(root);
    const fileService = new WorkspaceFileService(root);
    await fileService.write(
      "slides/svg/P01.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
        '<rect width="1280" height="720" fill="#111827"/>' +
        '<text x="80" y="180" fill="#ffffff" font-size="64">First page</text>' +
        "</svg>",
    );

    const result = await previewSvgPageTool.execute(
      {
        path: "slides/svg/P01.svg",
        title: "First page",
        includeThumbnail: false,
      },
      createContext(root, fileService),
    );

    expect(result.preview).toMatchObject({
      sourcePath: "slides/svg/P01.svg",
      title: "First page",
      width: 1280,
      height: 720,
      resourceCount: 0,
    });
    expect(result.preview.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.preview.previewGatePassed).toBe(false);
    expect(result.thumbnail).toBeNull();
  });
});

function createContext(workspaceRoot: string, fileService: WorkspaceFileService): ToolContext {
  const registry = createPptToolRegistry();
  return {
    presentation: createStarterPresentation(),
    selectedElementIds: [],
    discoverySession: { discoveredToolNames: new Set() },
    registry,
    messageHistory: [],
    workspaceRoot,
    fileService,
  };
}
