import { describe, expect, it } from "vitest";
import { CommitGate } from "../src/main/plugins/ppt/gate/commit-gate";
import { RiskPolicy } from "../src/main/plugins/ppt/gate/risk-policy";
import type { Presentation } from "../src/shared/presentation";
import { createStarterPresentation, createSvgTestSlide } from "../src/shared/presentation-fixtures";
import { TEST_DESIGN_SYSTEM } from "./design-engine-test-utils";

const testNarrative = {
  role: "anchor",
  coreMessage: "Core message for validation",
  audienceMove: "Understand the slide purpose",
  rhythm: "anchor" as const,
  layoutIntent: "Present the headline clearly",
};

function createPresentation(): Presentation {
  return {
    ...createStarterPresentation(),
    designSystem: TEST_DESIGN_SYSTEM,
  };
}

describe("CommitGate validation integration", () => {
  it("rejects restoring a slide with invalid SVG markup", async () => {
    const presentation = createPresentation();
    const slideId = presentation.slides[0].id;
    const gate = new CommitGate(new RiskPolicy());
    const invalidSlide = createSvgTestSlide({
      id: slideId,
      title: "Broken SVG",
      markup: "<svg><script>alert(1)</script></svg>",
    });

    const result = await gate.evaluate(
      presentation,
      [
        {
          id: "cmd-invalid-svg",
          type: "restore-slide",
          slide: invalidSlide,
        },
      ],
      "low",
    );

    expect(result.success).toBe(false);
    expect(result.decision).toBe("REJECT");
    expect(result.errors.join(" ")).toMatch(/invalid|SVG/i);
  });

  it("rejects restoring a slide whose sha256 no longer matches markup", async () => {
    const presentation = createPresentation();
    const slideId = presentation.slides[0].id;
    const gate = new CommitGate(new RiskPolicy());
    const tampered = createSvgTestSlide({ id: slideId, title: "Tampered" });
    tampered.visualSource.sha256 = "0".repeat(64);

    const result = await gate.evaluate(
      presentation,
      [
        {
          id: "cmd-hash-mismatch",
          type: "restore-slide",
          slide: tampered,
        },
      ],
      "low",
    );

    expect(result.success).toBe(false);
    expect(result.decision).toBe("REJECT");
    expect(result.errors.join(" ")).toContain("source hash");
  });

  it("requires approval when duplicate SVG image resources are introduced", async () => {
    const presentation = createPresentation();
    const sharedPath = "assets/shared-photo.png";
    const resource = {
      sourcePath: sharedPath,
      mimeType: "image/png" as const,
      byteSize: 1024,
      sha256: "a".repeat(64),
    };
    const firstSlide = createSvgTestSlide({ id: "slide-a", title: "A", narrative: testNarrative });
    firstSlide.visualSource.resources = [resource];
    const secondSlide = createSvgTestSlide({ id: "slide-b", title: "B", narrative: testNarrative });
    secondSlide.visualSource.resources = [resource];

    const gate = new CommitGate(new RiskPolicy());
    const result = await gate.evaluate(
      presentation,
      [
        { id: "cmd-add-a", type: "add-slide", index: 1, slide: firstSlide },
        { id: "cmd-add-b", type: "add-slide", index: 2, slide: secondSlide },
      ],
      "low",
    );

    expect(result.success).toBe(true);
    expect(result.decision).toBe("REQUIRES_APPROVAL");
    expect(result.warnings?.join(" ")).toContain("same image source");
  });

  it("auto-approves a valid slide title change", async () => {
    const presentation = createPresentation();
    const slideId = presentation.slides[0].id;
    const gate = new CommitGate(new RiskPolicy());

    const result = await gate.evaluate(
      presentation,
      [
        {
          id: "cmd-title",
          type: "set-slide-title",
          slideId,
          title: "Updated title",
        },
      ],
      "low",
    );

    expect(result.success).toBe(true);
    expect(result.decision).toBe("AUTO");
    expect(result.preview?.slides[0].title).toBe("Updated title");
  });
});
