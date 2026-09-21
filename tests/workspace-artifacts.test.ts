import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_DESIGN_SYSTEM } from "../src/design-system";
import {
  probeWorkspaceArtifactDetails,
  probeWorkspaceArtifacts,
} from "../src/main/plugins/ppt/presentation/workspace-artifacts";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";
import {
  createDefaultBriefMarkdown,
  createDefaultOutlineMarkdown,
  createDefaultResearchMarkdown,
} from "../src/shared/project-artifacts";

const workspaces: string[] = [];

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ppt-workspace-artifacts-"));
  workspaces.push(root);
  return root;
}

async function writeWorkspaceFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = join(root, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function designSpec() {
  return {
    version: 1,
    canvas: { width: 1280, height: 720 },
    communicationContract: {
      audience: "Executive team",
      objective: "Approve the plan",
      desiredOutcome: "Approve",
      coreMessage: "The plan is ready",
      deliveryContext: "Board meeting",
      afterUse: "Decision record",
    },
    presentationDesignSystem: DEFAULT_DESIGN_SYSTEM,
    argumentMode: DEFAULT_DESIGN_SYSTEM.argumentMode,
    visualStyle: { id: DEFAULT_DESIGN_SYSTEM.visualStyle },
    readingMode: DEFAULT_DESIGN_SYSTEM.readingMode,
  };
}

function pagePlan(path = "slides/svg/P01.svg") {
  return {
    version: 1,
    designSpec: "design/design-spec.json",
    slides: [
      {
        id: "P01",
        path,
        narrativeRole: "cover",
        finalCopy: { title: "First" },
        coreMessage: "The plan is ready",
        audienceMove: "Create confidence",
        rhythm: "anchor",
        layoutIntent: "One dominant statement.",
      },
    ],
  };
}

function svgPage(): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
    '<rect width="1280" height="720" fill="#111827"/>',
    '<text x="80" y="180" fill="#fff" font-size="64">First</text>',
    "</svg>",
  ].join("");
}

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("workspace artifact probing", () => {
  it("reports every SVG-native artifact and optional reference as absent", async () => {
    const root = await createWorkspace();

    await expect(probeWorkspaceArtifacts(root)).resolves.toEqual({
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
    });
  });

  it("does not treat optional reference scaffolds as lifecycle progress", async () => {
    const root = await createWorkspace();
    await writeWorkspaceFile(root, "brief.md", createDefaultBriefMarkdown("Test"));
    await writeWorkspaceFile(root, "outline.md", createDefaultOutlineMarkdown("Test"));
    await writeWorkspaceFile(root, "research/notes.md", createDefaultResearchMarkdown());

    const details = await probeWorkspaceArtifactDetails(root);
    expect(details.brief.status).toBe("default");
    expect(details.outline.status).toBe("default");
    expect(details.research.status).toBe("default");
    expect(details.designSpec.status).toBe("missing");
  });

  it("validates design-spec, page-plan, and the exact planned SVG page set", async () => {
    const root = await createWorkspace();
    await writeWorkspaceFile(root, "design/design-spec.json", JSON.stringify(designSpec()));
    await writeWorkspaceFile(root, "slides/page-plan.json", JSON.stringify(pagePlan()));
    await writeWorkspaceFile(root, "slides/svg/P01.svg", svgPage());
    await writeWorkspaceFile(root, "assets/hero.png", "not-decoded-by-probe");

    const artifacts = await probeWorkspaceArtifacts(root);
    expect(artifacts).toMatchObject({
      designSpec: true,
      pagePlan: true,
      pageSvg: true,
      assets: true,
    });
  });

  it("rejects downstream author files when their lock dependency is invalid", async () => {
    const root = await createWorkspace();
    await writeWorkspaceFile(root, "design/design-spec.json", "{}");
    await writeWorkspaceFile(root, "slides/page-plan.json", JSON.stringify(pagePlan()));
    await writeWorkspaceFile(root, "slides/svg/P01.svg", svgPage());

    const details = await probeWorkspaceArtifactDetails(root);
    expect(details.designSpec.status).toBe("invalid");
    expect(details.pagePlan.status).toBe("invalid");
    expect(details.pagePlan.reason).toContain("requires a verified");
    expect(details.pageSvg.status).toBe("invalid");
  });

  it("rejects page SVG drift from the current page plan", async () => {
    const root = await createWorkspace();
    await writeWorkspaceFile(root, "design/design-spec.json", JSON.stringify(designSpec()));
    await writeWorkspaceFile(
      root,
      "slides/page-plan.json",
      JSON.stringify(pagePlan("slides/svg/P02.svg")),
    );
    await writeWorkspaceFile(root, "slides/svg/P01.svg", svgPage());

    const details = await probeWorkspaceArtifactDetails(root);
    expect(details.pageSvg.status).toBe("invalid");
    expect(details.pageSvg.reason).toContain("Missing planned SVG pages");
    expect(details.pageSvg.reason).toContain("Unexpected SVG pages");
  });

  it("treats deck and export history as proof only when they contain committed output", async () => {
    const root = await createWorkspace();
    await writeWorkspaceFile(
      root,
      "deck/snapshot.json",
      JSON.stringify(createStarterPresentation()),
    );
    await writeWorkspaceFile(
      root,
      "history/exports.json",
      JSON.stringify({
        exports: [
          {
            revision: 1,
            filePath: "C:/exports/deck.pptx",
            exportedAt: "2026-07-30T00:00:00.000Z",
            designSystem: DEFAULT_DESIGN_SYSTEM,
          },
        ],
      }),
    );

    const artifacts = await probeWorkspaceArtifacts(root);
    expect(artifacts.deck).toBe(true);
    expect(artifacts.exportHistory).toBe(true);
  });

  it("ignores legacy storyboard and layout-plan files as new-flow facts", async () => {
    const root = await createWorkspace();
    await writeWorkspaceFile(
      root,
      "slides/storyboard.json",
      JSON.stringify([
        {
          id: "legacy",
          title: "Legacy",
          keyPoints: ["Old route"],
        },
      ]),
    );
    await writeWorkspaceFile(
      root,
      "slides/layout-plan.json",
      JSON.stringify({
        version: 1,
        slides: [],
      }),
    );

    const artifacts = await probeWorkspaceArtifacts(root);
    expect(artifacts.designSpec).toBe(false);
    expect(artifacts.pagePlan).toBe(false);
    expect(artifacts.pageSvg).toBe(false);
  });
});
