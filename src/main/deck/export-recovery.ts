import { readFile } from "node:fs/promises";
import { hashArtifactValue, hashBytes } from "@ppt/core/artifact-hash";
import type { ExportPresentationOptions } from "@shared/ppt-export";
import { type Presentation, presentationSchema } from "@shared/presentation";
import type { PptJobId, PresentationRevisionId } from "@shared/presentation-lifecycle";
import { createPptxExportIdentity } from "../../ppt/core/export-identity";
import { inspectPptxExport } from "../../ppt/core/pptx-postflight";
import type { PresentationLifecycleOrchestrator } from "../presentation-lifecycle/presentation-lifecycle-orchestrator";

export interface ExportRecoveryProof {
  passed: true;
  validator: "pptx-postflight" | "canonical-presentation-json";
  slideCount: number;
}

export interface InterruptedExportRecovery {
  destination: string;
  fileHash: ReturnType<typeof hashBytes>;
  byteLength: number;
  proof: ExportRecoveryProof;
  state: ReturnType<PresentationLifecycleOrchestrator["completeExport"]>;
}

/**
 * Proves a file left by an interrupted export without executing the export
 * again. HTML is intentionally excluded because its rendered output does not
 * carry enough canonical source identity to prove an exact revision.
 */
export async function proveExistingExport(
  filePath: string,
  format: "pptx" | "html" | "json",
  presentation: Presentation,
  options: ExportPresentationOptions,
): Promise<ExportRecoveryProof | undefined> {
  try {
    if (format === "pptx") {
      const report = await inspectPptxExport(
        filePath,
        presentation,
        createPptxExportIdentity(presentation, options),
      );
      return report.passed && report.slideCount === presentation.slides.length
        ? {
            passed: true,
            validator: "pptx-postflight",
            slideCount: report.slideCount,
          }
        : undefined;
    }
    if (format === "json") {
      const decoded = JSON.parse(await readFile(filePath, "utf8"));
      const recovered = presentationSchema.parse(decoded);
      return hashArtifactValue(recovered) === hashArtifactValue(presentation)
        ? {
            passed: true,
            validator: "canonical-presentation-json",
            slideCount: recovered.slides.length,
          }
        : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reconciles an export claim whose process died after the file may have been
 * written. This path only reads and proves the existing destination; it never
 * invokes an exporter. The caller must use it only after observing an
 * `in_progress` side-effect claim.
 */
export async function recoverInterruptedExport(input: {
  lifecycle: PresentationLifecycleOrchestrator;
  jobId: PptJobId;
  effectKey: string;
  presentationRevisionId: PresentationRevisionId;
  presentation: Presentation;
  options: ExportPresentationOptions;
  destination: string;
  format: "pptx" | "html" | "json";
}): Promise<InterruptedExportRecovery> {
  const proof = await proveExistingExport(
    input.destination,
    input.format,
    input.presentation,
    input.options,
  );
  if (!proof) {
    input.lifecycle.waitForUser(
      input.jobId,
      "A previous export attempt has an unproven outcome; it will not be replayed.",
    );
    throw new Error(
      "A previous export attempt may have written this destination. " +
        "Choose a new destination after verifying the file.",
    );
  }

  const bytes = await readFile(input.destination);
  const fileHash = hashBytes(bytes);
  const state = input.lifecycle.completeExport({
    jobId: input.jobId,
    effectKey: input.effectKey,
    presentationRevisionId: input.presentationRevisionId,
    options: input.options,
    destination: input.destination,
    format: input.format,
    fileHash,
    byteLength: bytes.byteLength,
    postflight: proof,
  });
  return {
    destination: input.destination,
    fileHash,
    byteLength: bytes.byteLength,
    proof,
    state,
  };
}
