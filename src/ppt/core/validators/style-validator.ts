import { designSystemV2Schema } from "@design-system";
import type { DeckValidationIssue } from "@shared/deck-validation";
import type { Presentation } from "@shared/presentation";

export interface StyleValidatorOptions {
  slideIds?: string[];
}

export class StyleValidator {
  validate(presentation: Presentation, options: StyleValidatorOptions = {}): DeckValidationIssue[] {
    const slideIdSet = options.slideIds ? new Set(options.slideIds) : undefined;
    const issues: DeckValidationIssue[] = [];

    issues.push(...this.validateDesignSystem(presentation));

    const titleToSlideIds = new Map<string, string[]>();
    for (const slide of presentation.slides) {
      if (slideIdSet && !slideIdSet.has(slide.id)) continue;

      if (!slide.title.trim()) {
        issues.push({
          slideId: slide.id,
          category: "structure",
          severity: "warning",
          message: `Slide at index ${presentation.slides.indexOf(slide) + 1} is missing a title.`,
          fixHint: "Set a unique, descriptive slide title.",
        });
      } else {
        const ids = titleToSlideIds.get(slide.title) ?? [];
        ids.push(slide.id);
        titleToSlideIds.set(slide.title, ids);
      }
    }

    for (const [title, slideIds] of titleToSlideIds.entries()) {
      if (slideIds.length > 1) {
        issues.push({
          category: "consistency",
          severity: "warning",
          message: `Slide title '${title}' is repeated across ${slideIds.length} slides.`,
          fixHint: "Differentiate slide titles to improve navigation and narrative clarity.",
        });
      }
    }

    return issues;
  }

  private validateDesignSystem(presentation: Presentation): DeckValidationIssue[] {
    if (presentation.slides.length === 0) return [];

    if (!designSystemV2Schema.safeParse(presentation.designSystem).success) {
      return [
        {
          category: "style",
          severity: "error",
          message: "Presentation designSystem is invalid.",
          fixHint:
            "Lock a complete DesignSystemV2 in design/design-spec.json and resubmit via SubmitSvgDeck.",
        },
      ];
    }
    return [];
  }
}

export const styleValidator = new StyleValidator();
