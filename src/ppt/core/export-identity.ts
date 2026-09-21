import { hashArtifactValue } from "@ppt/core/artifact-hash";
import type { ExportPresentationOptions } from "@shared/ppt-export";
import type { Presentation } from "@shared/presentation";

const PPTX_EXPORT_IDENTITY_PREFIX = "agent-ppt-export:";

/**
 * Stable identity embedded in exported PPTX metadata. It binds an interrupted
 * output file to the exact authoritative Presentation and export options,
 * which structural postflight checks alone cannot prove.
 */
export function createPptxExportIdentity(
  presentation: Presentation,
  options: ExportPresentationOptions,
): string {
  // Presentation command helpers may leave explicit `undefined` on optional
  // object properties. Export identity follows persisted JSON semantics:
  // object `undefined` fields are omitted before canonical hashing.
  const persistedValue = JSON.parse(
    JSON.stringify({
      presentation,
      options,
    }),
  ) as unknown;
  return `${PPTX_EXPORT_IDENTITY_PREFIX}${hashArtifactValue(persistedValue)}`;
}
