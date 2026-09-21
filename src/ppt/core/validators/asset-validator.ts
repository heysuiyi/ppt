import type { DeckValidationIssue } from "@shared/deck-validation";
import type { Presentation } from "@shared/presentation";
import { auditPresentationVisualAssets } from "@shared/visual-asset-audit";

export interface AssetValidatorOptions {
  slideIds?: string[];
  workspaceRoot?: string;
  allowUnverifiedAssets?: boolean;
}

export class AssetValidator {
  validate(presentation: Presentation, options: AssetValidatorOptions = {}): DeckValidationIssue[] {
    const slideIdSet = options.slideIds ? new Set(options.slideIds) : undefined;
    const issues: DeckValidationIssue[] = [];
    const visualAudit = auditPresentationVisualAssets(presentation);

    for (const slideAudit of visualAudit.slides) {
      if (slideIdSet && !slideIdSet.has(slideAudit.slideId)) continue;
      if (slideAudit.status === "missing-required") {
        issues.push({
          slideId: slideAudit.slideId,
          category: "asset",
          severity: "error",
          message: `Slide '${slideAudit.title}' uses an image-dependent layout but is missing a required image.`,
          fixHint: slideAudit.reason,
        });
      } else if (slideAudit.status === "missing-recommended") {
        issues.push({
          slideId: slideAudit.slideId,
          category: "asset",
          severity: "warning",
          message: `Slide '${slideAudit.title}' is missing the visual anchor recommended by its layout.`,
          fixHint: slideAudit.reason,
        });
      }
    }

    for (const duplicateUrl of visualAudit.duplicateImageUrls) {
      const duplicateSlides = presentation.slides.filter(
        (slide) =>
          slide.visualSource?.kind === "svg" &&
          slide.visualSource.resources.some((resource) => resource.sourcePath === duplicateUrl),
      );
      if (slideIdSet && !duplicateSlides.some((slide) => slideIdSet.has(slide.id))) continue;
      issues.push({
        category: "asset",
        severity: "warning",
        message: `The same image source is reused across ${duplicateSlides.length} slides.`,
        fixHint:
          "Use a unique, slide-specific visual unless repetition is intentional and approved.",
      });
    }

    return issues;
  }
}

export const assetValidator = new AssetValidator();
