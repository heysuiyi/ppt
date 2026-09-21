/** Headless PPT operations. No Electron window, Agent runtime or database is required. */

export { type DesignSystemV2, designSystemV2Schema } from "@design-system";
export {
  type DeckExportResult,
  type ExportPresentationOptions,
  exportPresentationOptionsSchema,
} from "@shared/ppt-export";
export { type Presentation, presentationSchema, type Slide } from "@shared/presentation";
export { assertValidSvgPage } from "@shared/svg-page";
export { type DeckExportInput, DeckExportService } from "./deck-export-service";
export { type DeckValidationOptions, DeckValidationService } from "./deck-validation-service";
export { inspectPptxExport, type PptxPostflightReport } from "./pptx-postflight";
