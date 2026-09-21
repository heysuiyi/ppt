import { createHash } from "node:crypto";
import type { DeckValidationIssue } from "@shared/deck-validation";
import type { Presentation, Slide } from "@shared/presentation";
import { assertValidSvgPage } from "@shared/svg-page";

export interface LayoutValidatorOptions {
  slideIds?: string[];
}

export class LayoutValidator {
  validate(
    presentation: Presentation,
    options: LayoutValidatorOptions = {},
  ): DeckValidationIssue[] {
    const slideIdSet = options.slideIds ? new Set(options.slideIds) : undefined;
    const issues: DeckValidationIssue[] = [];

    for (const slide of presentation.slides) {
      if (slideIdSet && !slideIdSet.has(slide.id)) continue;
      issues.push(...this.validateSlide(slide));
    }

    return issues;
  }

  private validateSlide(slide: Slide): DeckValidationIssue[] {
    const issues: DeckValidationIssue[] = [];

    if (slide.visualSource?.kind === "svg") {
      try {
        assertValidSvgPage(slide.visualSource.markup);
      } catch (error) {
        issues.push({
          slideId: slide.id,
          category: "layout",
          severity: "error",
          message: `SVG page '${slide.title}' is invalid: ${
            error instanceof Error ? error.message : String(error)
          }`,
          fixHint: "Fix the complete source SVG and submit the page again.",
        });
      }
      const actualHash = createHash("sha256")
        .update(slide.visualSource.markup, "utf8")
        .digest("hex");
      if (actualHash !== slide.visualSource.sha256) {
        issues.push({
          slideId: slide.id,
          category: "layout",
          severity: "error",
          message: `SVG page '${slide.title}' no longer matches its source hash.`,
          fixHint:
            "Resubmit the SVG page so validation, preview, and export share the same source.",
        });
      }
      if (!slide.narrative) {
        issues.push({
          slideId: slide.id,
          category: "structure",
          severity: "error",
          message: `SVG page '${slide.title}' is missing its page narrative contract.`,
          fixHint: "Provide role, coreMessage, audienceMove, rhythm, and layoutIntent.",
        });
      }
      return issues;
    }

    issues.push({
      slideId: slide.id,
      category: "structure",
      severity: "error",
      message: `Slide '${slide.title}' is not SVG-native; element-IR layout validation has been removed.`,
      fixHint: "Submit a complete SVG page as the slide visual source.",
    });

    return issues;
  }
}

export const layoutValidator = new LayoutValidator();
