import type { DesignConstraints } from "@shared/deck-persistence";
import {
  type DeckValidationIssue,
  type DeckValidationResult,
  summarizeDeckValidation,
} from "@shared/deck-validation";
import type { Presentation } from "@shared/presentation";
import { type AssetValidator, assetValidator } from "./validators/asset-validator";
import { type LayoutValidator, layoutValidator } from "./validators/layout-validator";
import { type StyleValidator, styleValidator } from "./validators/style-validator";

export interface DeckValidationOptions {
  constraints?: DesignConstraints;
  /** Limit validation to specific slides (e.g. current generation batch) */
  slideIds?: string[];
  /** Workspace root used to validate local image paths. */
  workspaceRoot?: string;
  /** Explicit export-only approval for assets whose commercial license is still unknown. */
  allowUnverifiedAssets?: boolean;
}

export class DeckValidationService {
  constructor(
    private readonly layout: LayoutValidator = layoutValidator,
    private readonly style: StyleValidator = styleValidator,
    private readonly asset: AssetValidator = assetValidator,
  ) {}

  validate(presentation: Presentation, options: DeckValidationOptions = {}): DeckValidationResult {
    const layoutIssues = this.layout.validate(presentation, options);
    const styleIssues = this.style.validate(presentation, options);
    const assetIssues = this.asset.validate(presentation, options);
    return summarizeDeckValidation([...layoutIssues, ...styleIssues, ...assetIssues]);
  }

  listIssues(
    presentation: Presentation,
    options: DeckValidationOptions = {},
  ): DeckValidationIssue[] {
    return this.validate(presentation, options).issues;
  }
}

export const deckValidationService = new DeckValidationService();
