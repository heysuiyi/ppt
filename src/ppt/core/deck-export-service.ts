import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { exportToHtml } from "@shared/html-exporter";
import {
  type DeckExportResult,
  type ExportPresentationOptions,
  exportPresentationOptionsSchema,
} from "@shared/ppt-export";
import { type Presentation, presentationSchema } from "@shared/presentation";
import { deckValidationService } from "./deck-validation-service";
import { createPptxExportIdentity } from "./export-identity";
import { exportToPptx, type PptExportLogger } from "./ppt-exporter";
import { inspectPptxExport } from "./pptx-postflight";

export interface DeckExportInput {
  presentation: Presentation;
  options: ExportPresentationOptions;
  filePath?: string;
  format?: "pptx" | "json" | "html";
  workspaceRoot?: string;
}

function sanitizeFileName(title: string): string {
  return title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "presentation";
}

async function inlineHtmlImageAssets(presentation: Presentation): Promise<Presentation> {
  return presentation;
}

/**
 * 文件层导出服务：Presentation → .pptx（或 JSON 镜像）。
 * 与数据生成（CommandBus / revision）解耦，同一 revision 可多次导出。
 */
export class DeckExportService {
  constructor(private readonly logger: PptExportLogger = console) {}
  /**
   * 从不可变 Presentation 快照导出目标格式。
   * PPTX 导出前执行 deck/素材校验，导出后执行结构 postflight，失败时不伪装为成功产物。
   */
  async exportDeck(input: DeckExportInput): Promise<DeckExportResult> {
    const presentation = presentationSchema.parse(structuredClone(input.presentation));
    const options = exportPresentationOptionsSchema.parse(input.options);
    const format = input.format ?? "pptx";
    const filePath = input.filePath ?? (await this.createDefaultExportPath(presentation, format));

    if (filePath.endsWith(".json")) {
      await writeFile(filePath, JSON.stringify(presentation, null, 2), "utf8");
    } else {
      const validationErrors = deckValidationService
        .validate(presentation, {
          workspaceRoot: input.workspaceRoot,
          allowUnverifiedAssets: options.allowUnverifiedAssets,
        })
        .issues.filter((issue) => issue.severity === "error");
      if (validationErrors.length > 0) {
        throw new Error(
          `Export blocked by deck validation: ${validationErrors.map((issue) => issue.message).join("; ")}`,
        );
      }

      if (filePath.endsWith(".html")) {
        const portablePresentation = await inlineHtmlImageAssets(presentation);
        const html = exportToHtml(portablePresentation);
        await writeFile(filePath, html, "utf8");
        return {
          filePath,
          slideCount: presentation.slides.length,
        };
      }
      if (!filePath.endsWith(".pptx")) {
        throw new Error("Unsupported export format; only .pptx, .json, and .html are supported.");
      }
      const temporaryPath = join(
        dirname(filePath),
        `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp.pptx`,
      );
      try {
        await exportToPptx(presentation, options, temporaryPath, input.workspaceRoot, this.logger);
        const postflight = await inspectPptxExport(
          temporaryPath,
          presentation,
          createPptxExportIdentity(presentation, options),
        );
        if (!postflight.passed) {
          throw new Error(`PPTX postflight failed: ${postflight.errors.join("; ")}`);
        }
        await rename(temporaryPath, filePath);
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }

    return {
      filePath,
      slideCount: presentation.slides.length,
    };
  }

  private async createDefaultExportPath(
    presentation: Presentation,
    format: "pptx" | "json" | "html",
  ): Promise<string> {
    const dir = join(tmpdir(), "agent-ppt-exports");
    await mkdir(dir, { recursive: true });
    const base = sanitizeFileName(presentation.title || "presentation");
    return join(dir, `${base}-${Date.now()}.${format}`);
  }
}
