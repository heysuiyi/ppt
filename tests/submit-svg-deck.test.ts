import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requirePresentation } from "@main/plugins/ppt/context";
import { createPptToolRegistry } from "@main/plugins/ppt/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESIGN_SYSTEM } from "../src/design-system";
import { WorkspaceFileService } from "../src/main/agent/tools/files/workspace-file-service";
import type { ToolContext } from "../src/main/agent/tools/tool-definition";
import { slideThumbnailService } from "../src/main/plugins/ppt/adapters/electron-thumbnail-service";
import { CommitGate } from "../src/main/plugins/ppt/gate/commit-gate";
import { RiskPolicy } from "../src/main/plugins/ppt/gate/risk-policy";
import { loadWorkspaceSvgPage } from "../src/main/plugins/ppt/svg-page-loader";
import { previewSvgPageTool } from "../src/main/plugins/ppt/tools/preview-svg-page";
import {
  submitSvgDeckSchema,
  submitSvgDeckTool,
} from "../src/main/plugins/ppt/tools/submit-svg-deck";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

const temporaryRoots: string[] = [];
const VALID_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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

describe("SubmitSvgDeck", () => {
  it("localizes workspace raster assets and proposes the exact SVG pages", async () => {
    const root = await createWorkspace();
    const fileService = new WorkspaceFileService(root);
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(
      join(root, "assets", "pixel.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await fileService.write("slides/svg/P01.svg", `\n${svgPage("../../assets/pixel.png")}\n`);
    const context = createContext(root, fileService);
    const args: SubmissionArgs = {
      title: "SVG deck",
      designSpecPath: "design/design-spec.json",
      pagePlanPath: "slides/page-plan.json",
      communication: {
        audience: "Executive team",
        objective: "Make an investment decision",
        desiredOutcome: "Approve the next phase",
        coreMessage: "The opportunity is ready to scale",
        deliveryContext: "Live board presentation",
        afterUse: "Decision record",
      },
      designSystem: DEFAULT_DESIGN_SYSTEM,
      slides: [
        {
          id: "P01",
          title: "Opportunity",
          path: "slides/svg/P01.svg",
          speakerNotes: "Lead with the decision.",
          narrative: {
            role: "cover",
            coreMessage: "The opportunity is ready to scale",
            audienceMove: "Create confidence",
            rhythm: "anchor",
            layoutIntent: "A single dominant statement with asymmetric evidence.",
          },
        },
      ],
      summary: "Replace the deck with one SVG-native page.",
      risk: "medium",
    };
    await writeSubmissionLocks(fileService, args);
    vi.spyOn(slideThumbnailService, "captureSlide").mockResolvedValue({
      pngBase64: "rendered-page",
      width: 640,
      height: 360,
      mimeType: "image/png",
    });
    const preview = await previewSvgPageTool.execute(
      {
        path: "slides/svg/P01.svg",
        title: "Opportunity",
        includeThumbnail: true,
      },
      context,
    );
    expect(preview.preview.previewGatePassed).toBe(true);

    const result = await submitSvgDeckTool.execute(args, context);

    expect(result.type).toBe("command_proposal");
    const addSlide = result.commands.find((command) => command.type === "add-slide");
    expect(addSlide?.type).toBe("add-slide");
    if (addSlide?.type !== "add-slide") throw new Error("Missing add-slide command");
    expect(addSlide.slide.visualSource).toMatchObject({
      kind: "svg",
      width: 1280,
      height: 720,
      sourcePath: "slides/svg/P01.svg",
    });
    expect(addSlide.slide.visualSource?.markup).toContain("data:image/png;base64,");
    expect(addSlide.slide.visualSource?.markup.startsWith("\n")).toBe(true);
    expect(addSlide.slide.visualSource?.markup.endsWith("\n")).toBe(true);
    expect(addSlide.slide.visualSource?.resources).toHaveLength(1);
    expect(addSlide.slide.visualSource?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.commands.at(-1)).toBe(addSlide);

    const gate = await new CommitGate(new RiskPolicy()).evaluate(
      requirePresentation(context),
      result.commands,
      result.risk,
      { workspaceRoot: root },
    );
    expect(gate).toMatchObject({
      success: true,
      decision: "REQUIRES_APPROVAL",
    });
    expect(gate.preview?.slides[0]?.visualSource?.sha256).toBe(addSlide.slide.visualSource?.sha256);
  });

  it("requires a successful, content-exact PNG preview of P01", async () => {
    const root = await createWorkspace();
    const fileService = new WorkspaceFileService(root);
    const context = createContext(root, fileService);
    await fileService.write(
      "slides/svg/P01.svg",
      svgPage(`data:image/png;base64,${VALID_PIXEL_PNG}`),
    );
    const args = submitArgs();
    await writeSubmissionLocks(fileService, args);

    await expect(submitSvgDeckTool.execute(args, context)).rejects.toThrow(
      "P01 preview gate is missing or stale",
    );

    vi.spyOn(slideThumbnailService, "captureSlide").mockResolvedValue({
      pngBase64: "rendered-page",
      width: 640,
      height: 360,
      mimeType: "image/png",
    });
    const preview = await previewSvgPageTool.execute(
      {
        path: "slides/svg/P01.svg",
        includeThumbnail: true,
      },
      context,
    );
    expect(preview.preview.previewGatePassed).toBe(true);

    await fileService.write(
      "slides/svg/P01.svg",
      `${svgPage(`data:image/png;base64,${VALID_PIXEL_PNG}`)} `,
    );
    await expect(submitSvgDeckTool.execute(args, context)).rejects.toThrow(
      "P01 preview gate is missing or stale",
    );
  });

  it("requires a current preview for every new page", async () => {
    const root = await createWorkspace();
    const fileService = new WorkspaceFileService(root);
    const context = createContext(root, fileService);
    await fileService.write("slides/svg/P01.svg", textSvgPage("First"));
    await fileService.write("slides/svg/P02.svg", textSvgPage("Second"));
    const args = submitArgs(["slides/svg/P01.svg", "slides/svg/P02.svg"]);
    await writeSubmissionLocks(fileService, args);
    vi.spyOn(slideThumbnailService, "captureSlide").mockResolvedValue({
      pngBase64: "rendered-page",
      width: 640,
      height: 360,
      mimeType: "image/png",
    });

    await previewSvgPageTool.execute(
      {
        path: "slides/svg/P01.svg",
        includeThumbnail: true,
      },
      context,
    );
    await expect(submitSvgDeckTool.execute(args, context)).rejects.toThrow(
      "P02 preview gate is missing or stale",
    );

    await previewSvgPageTool.execute(
      {
        path: "slides/svg/P02.svg",
        includeThumbnail: true,
      },
      context,
    );
    const result = await submitSvgDeckTool.execute(args, context);
    expect(result.commands.filter((command) => command.type === "add-slide")).toHaveLength(2);
  });

  it("does not reuse a preview receipt from another thread-scoped file service", async () => {
    const root = await createWorkspace();
    const previewFileService = new WorkspaceFileService(root);
    const submitFileService = new WorkspaceFileService(root);
    await previewFileService.write("slides/svg/P01.svg", textSvgPage("First"));
    const args = submitArgs();
    await writeSubmissionLocks(previewFileService, args);
    vi.spyOn(slideThumbnailService, "captureSlide").mockResolvedValue({
      pngBase64: "rendered-page",
      width: 640,
      height: 360,
      mimeType: "image/png",
    });

    await previewSvgPageTool.execute(
      {
        path: "slides/svg/P01.svg",
        includeThumbnail: true,
      },
      createContext(root, previewFileService),
    );

    await expect(
      submitSvgDeckTool.execute(args, createContext(root, submitFileService)),
    ).rejects.toThrow("P01 preview gate is missing or stale");
  });

  it("rejects remote image dependencies instead of exporting a partial page", async () => {
    const root = await createWorkspace();
    const fileService = new WorkspaceFileService(root);
    await fileService.write("slides/svg/P01.svg", svgPage("https://example.com/hero.png"));

    const args: SubmissionArgs = {
      title: "Unsafe deck",
      designSpecPath: "design/design-spec.json",
      pagePlanPath: "slides/page-plan.json",
      communication: {
        audience: "Team",
        objective: "Review",
        desiredOutcome: "Align",
        coreMessage: "One message",
        deliveryContext: "Meeting",
        afterUse: "Reference",
      },
      designSystem: DEFAULT_DESIGN_SYSTEM,
      slides: [
        {
          id: "P01",
          title: "Unsafe",
          path: "slides/svg/P01.svg",
          narrative: {
            role: "cover",
            coreMessage: "One message",
            audienceMove: "Focus attention",
            rhythm: "anchor",
            layoutIntent: "Hero image.",
          },
        },
      ],
      summary: "Unsafe",
      risk: "low",
    };
    await writeSubmissionLocks(fileService, args);
    await expect(submitSvgDeckTool.execute(args, createContext(root, fileService))).rejects.toThrow(
      "image source must be workspace-relative or embedded",
    );
  });

  it("requires both canonical lock files before inspecting SVG pages", async () => {
    const root = await createWorkspace();
    const fileService = new WorkspaceFileService(root);

    await expect(
      submitSvgDeckTool.execute(submitArgs(), createContext(root, fileService)),
    ).rejects.toThrow("requires readable lock file design/design-spec.json");
  });

  it("rejects invalid JSON and internally inconsistent design axes", async () => {
    const root = await createWorkspace();
    const fileService = new WorkspaceFileService(root);
    const args = submitArgs();
    await fileService.write("design/design-spec.json", "{");

    await expect(submitSvgDeckTool.execute(args, createContext(root, fileService))).rejects.toThrow(
      "design/design-spec.json must contain valid JSON",
    );

    await fileService.read("design/design-spec.json");
    const designSpec = designSpecFixture(args);
    designSpec.argumentMode = designSpec.argumentMode === "briefing" ? "pyramid" : "briefing";
    await fileService.write("design/design-spec.json", JSON.stringify(designSpec));
    await fileService.write("slides/page-plan.json", JSON.stringify(pagePlanFixture(args)));

    await expect(submitSvgDeckTool.execute(args, createContext(root, fileService))).rejects.toThrow(
      "argumentMode must match presentationDesignSystem.argumentMode",
    );
  });

  it.each([
    {
      label: "communication",
      mutate: (args: SubmissionArgs) => {
        args.communication.coreMessage = "A different core message";
      },
      expected: "communication.coreMessage must exactly match",
    },
    {
      label: "presentation design system and visual axis",
      mutate: (args: SubmissionArgs) => {
        args.designSystem = {
          ...args.designSystem,
          visualStyle:
            args.designSystem.visualStyle === "dark-tech" ? "swiss-minimal" : "dark-tech",
        };
      },
      expected: "designSystem.visualStyle must exactly match",
    },
    {
      label: "page id",
      mutate: (args: SubmissionArgs) => {
        args.slides[0]!.id = "P99";
      },
      expected: "slides[0].id must exactly match",
    },
    {
      label: "page path",
      mutate: (args: SubmissionArgs) => {
        args.slides[0]!.path = "slides/svg/P99.svg";
      },
      expected: "slides[0].path must exactly match",
    },
    ...(["role", "coreMessage", "audienceMove", "rhythm", "layoutIntent"] as const).map((key) => ({
      label: `narrative ${key}`,
      mutate: (args: SubmissionArgs) => {
        if (key === "rhythm") {
          args.slides[0]!.narrative.rhythm = "dense";
        } else {
          args.slides[0]!.narrative[key] = `Changed ${key}`;
        }
      },
      expected: `slides[0].narrative.${key} must exactly match`,
    })),
  ])("rejects $label drift from the lock files", async ({ mutate, expected }) => {
    const root = await createWorkspace();
    const fileService = new WorkspaceFileService(root);
    const args = submitArgs();
    await writeSubmissionLocks(fileService, args);
    mutate(args);

    await expect(submitSvgDeckTool.execute(args, createContext(root, fileService))).rejects.toThrow(
      expected,
    );
  });

  it("rejects reordered pages even when every page remains present", async () => {
    const root = await createWorkspace();
    const fileService = new WorkspaceFileService(root);
    const args = submitArgs(["slides/svg/P01.svg", "slides/svg/P02.svg"]);
    await writeSubmissionLocks(fileService, args);
    args.slides.reverse();

    await expect(submitSvgDeckTool.execute(args, createContext(root, fileService))).rejects.toThrow(
      "slides[0].id must exactly match",
    );
  });

  it.each(["../P01.svg", "/tmp/P01.svg", "C:\\tmp\\P01.svg"])(
    "reports invalid workspace paths as schema errors without throwing: %s",
    (path) => {
      let parsed: ReturnType<typeof submitSvgDeckSchema.safeParse> | undefined;
      expect(() => {
        parsed = submitSvgDeckSchema.safeParse(submitArgs([path]));
      }).not.toThrow();
      expect(parsed?.success).toBe(false);
    },
  );

  it("does not read image-looking tags in comments or data-href attributes", async () => {
    const root = await createWorkspace();
    const fileService = new WorkspaceFileService(root);
    const markup = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
      '<!-- <image href="../../private-comment.png"/> -->',
      `<image data-href="../../private-attribute.png" href="data:image/png;base64,${VALID_PIXEL_PNG}" `,
      'x="0" y="0" width="1" height="1"/>',
      "</svg>",
    ].join("");
    await fileService.write("slides/svg/P01.svg", markup);

    const result = await previewSvgPageTool.execute(
      {
        path: "slides/svg/P01.svg",
        includeThumbnail: false,
      },
      createContext(root, fileService),
    );

    expect(result.preview.resourceCount).toBe(1);
    expect(result.preview.previewGatePassed).toBe(false);
  });

  it("hydrates many repeated local images in one ordered pass", async () => {
    const root = await createWorkspace();
    const fileService = new WorkspaceFileService(root);
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "pixel.png"), Buffer.from(VALID_PIXEL_PNG, "base64"));
    const imageCount = 2_000;
    await fileService.write(
      "slides/svg/P01.svg",
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
        ...Array.from(
          { length: imageCount },
          (_, index) =>
            `<image id="image-${index}" href="../../assets/pixel.png" x="0" y="0" width="1" height="1"/>`,
        ),
        "</svg>",
      ].join(""),
    );

    const page = await loadWorkspaceSvgPage({
      requestedPath: "slides/svg/P01.svg",
      workspaceRoot: root,
      fileService,
    });

    expect(page.markup.match(/data:image\/png;base64,/g)).toHaveLength(imageCount);
    expect(page.markup.indexOf('id="image-0"')).toBeLessThan(
      page.markup.indexOf(`id="image-${imageCount - 1}"`),
    );
    expect(page.resources).toHaveLength(1);
  });

  it("rejects duplicate image hrefs and embedded MIME spoofing", async () => {
    const root = await createWorkspace();
    const fileService = new WorkspaceFileService(root);
    await fileService.write(
      "slides/svg/P01.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" ' +
        'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1280 720">' +
        `<image href="data:image/png;base64,${VALID_PIXEL_PNG}" ` +
        `xlink:href="data:image/png;base64,${VALID_PIXEL_PNG}"/>` +
        "</svg>",
    );
    await expect(
      previewSvgPageTool.execute(
        {
          path: "slides/svg/P01.svg",
          includeThumbnail: false,
        },
        createContext(root, fileService),
      ),
    ).rejects.toThrow("exactly one href");

    await fileService.read("slides/svg/P01.svg");
    await fileService.write(
      "slides/svg/P01.svg",
      svgPage(`data:image/jpeg;base64,${VALID_PIXEL_PNG}`),
    );
    await expect(
      previewSvgPageTool.execute(
        {
          path: "slides/svg/P01.svg",
          includeThumbnail: false,
        },
        createContext(root, fileService),
      ),
    ).rejects.toThrow("signature does not match image/jpeg");
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-ppt-svg-deck-"));
  temporaryRoots.push(root);
  return root;
}

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

function svgPage(imageHref: string): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
    '<rect width="1280" height="720" fill="#0f172a"/>',
    `<image href="${imageHref}" x="900" y="80" width="280" height="280"/>`,
    '<text x="80" y="180" font-size="64" fill="#ffffff">Opportunity</text>',
    "</svg>",
  ].join("");
}

function submitArgs(
  paths: string[] = ["slides/svg/P01.svg"],
): Parameters<typeof submitSvgDeckTool.execute>[0] {
  return {
    title: "SVG deck",
    designSpecPath: "design/design-spec.json",
    pagePlanPath: "slides/page-plan.json",
    communication: {
      audience: "Executive team",
      objective: "Make an investment decision",
      desiredOutcome: "Approve the next phase",
      coreMessage: "The opportunity is ready to scale",
      deliveryContext: "Live board presentation",
      afterUse: "Decision record",
    },
    designSystem: DEFAULT_DESIGN_SYSTEM,
    slides: paths.map((path, index) => ({
      id: `P${String(index + 1).padStart(2, "0")}`,
      title: index === 0 ? "Opportunity" : `Evidence ${index}`,
      path,
      narrative: {
        role: index === 0 ? "cover" : "evidence",
        coreMessage: index === 0 ? "The opportunity is ready to scale" : `Evidence page ${index}`,
        audienceMove: index === 0 ? "Create confidence" : "Build conviction",
        rhythm: index === 0 ? "anchor" : "dense",
        layoutIntent:
          index === 0
            ? "A single dominant statement with asymmetric evidence."
            : "Layer evidence with a clear reading path.",
      },
    })),
    summary: "Replace the deck with one SVG-native page.",
    risk: "medium",
  };
}

type SubmissionArgs = Parameters<typeof submitSvgDeckTool.execute>[0];

function designSpecFixture(args: SubmissionArgs) {
  return {
    version: 1 as const,
    canvas: { width: 1280 as const, height: 720 as const },
    communicationContract: { ...args.communication },
    presentationDesignSystem: { ...args.designSystem },
    argumentMode: args.designSystem.argumentMode,
    visualStyle: {
      id: args.designSystem.visualStyle,
      reference: {},
    },
    readingMode: args.designSystem.readingMode,
    imageLanguage: {},
    colors: {},
    typography: {},
    geometry: {},
    rhythmBehavior: {},
    forbidden: [],
  };
}

function pagePlanFixture(args: SubmissionArgs) {
  return {
    version: 1 as const,
    designSpec: "design/design-spec.json" as const,
    slides: args.slides.map((slide) => ({
      id: slide.id,
      path: slide.path,
      narrativeRole: slide.narrative.role,
      finalCopy: { title: slide.title },
      coreMessage: slide.narrative.coreMessage,
      audienceMove: slide.narrative.audienceMove,
      rhythm: slide.narrative.rhythm,
      layoutIntent: slide.narrative.layoutIntent,
      assetRefs: [],
    })),
  };
}

async function writeSubmissionLocks(
  fileService: WorkspaceFileService,
  args: SubmissionArgs,
): Promise<void> {
  await fileService.write(
    "design/design-spec.json",
    `${JSON.stringify(designSpecFixture(args), null, 2)}\n`,
  );
  await fileService.write(
    "slides/page-plan.json",
    `${JSON.stringify(pagePlanFixture(args), null, 2)}\n`,
  );
}

function textSvgPage(text: string): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
    '<rect width="1280" height="720" fill="#0f172a"/>',
    `<text x="80" y="180" font-size="64" fill="#ffffff">${text}</text>`,
    "</svg>",
  ].join("");
}
