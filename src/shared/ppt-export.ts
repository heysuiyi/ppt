import { z } from "zod";

export const exportPresentationOptionsSchema = z
  .object({
    /** Explicit human approval for assets whose commercial license is not yet verified. */
    allowUnverifiedAssets: z.boolean().optional(),
  })
  .strict();

export type ExportPresentationOptions = z.infer<typeof exportPresentationOptionsSchema>;

export interface DeckExportResult {
  filePath: string;
  slideCount: number;
}
