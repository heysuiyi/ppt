import { utf8ToBase64 } from "@shared/base64";
import type { ExportPresentationOptions } from "@shared/ppt-export";
import type { Presentation } from "@shared/presentation";
import pptxgen from "pptxgenjs";
import { createPptxExportIdentity } from "./export-identity";
import { type LiftedText, liftSvgText } from "./svg-text-lift";

export interface PptExportLogger {
  warn(event: string, details: Record<string, unknown>): void;
  error(event: string, details: Record<string, unknown>): void;
}

const PPTX_LAYOUT_NAME = "AGENT_PPT_WIDE";
const PPTX_SLIDE_WIDTH_INCHES = 10;
const PPTX_SLIDE_HEIGHT_INCHES = 5.625;

export async function exportToPptx(
  presentation: Presentation,
  options: ExportPresentationOptions,
  filePath: string,
  _workspaceRoot?: string,
  logger: PptExportLogger = console,
): Promise<void> {
  const pptx = new pptxgen();
  pptx.subject = createPptxExportIdentity(presentation, options);
  pptx.title = presentation.title;
  pptx.defineLayout({
    name: PPTX_LAYOUT_NAME,
    width: PPTX_SLIDE_WIDTH_INCHES,
    height: PPTX_SLIDE_HEIGHT_INCHES,
  });
  pptx.layout = PPTX_LAYOUT_NAME;

  for (let i = 0; i < presentation.slides.length; i++) {
    const slideData = presentation.slides[i];
    const slide = pptx.addSlide();
    if (slideData.visualSource?.kind === "svg") {
      slide.background = { fill: "FFFFFF" };
      const exportLayers = resolveSvgExportLayers(slideData.visualSource.markup, i + 1, logger);
      slide.addImage({
        data: `data:image/svg+xml;base64,${utf8ToBase64(exportLayers.backgroundSvg)}`,
        x: 0,
        y: 0,
        w: PPTX_SLIDE_WIDTH_INCHES,
        h: PPTX_SLIDE_HEIGHT_INCHES,
      });
      for (const text of exportLayers.texts) {
        addLiftedText(slide, text);
      }
      if (slideData.speakerNotes) {
        slide.addNotes(slideData.speakerNotes);
      }
      continue;
    }

    throw new Error(`Slide ${i + 1} is not SVG-native; element-IR export has been removed.`);
  }

  try {
    await pptx.writeFile({ fileName: filePath });
  } catch (error) {
    logger.error("pptx.write.failed", { filePath, error });
    throw new Error(
      `Unable to write PPTX export: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function resolveSvgExportLayers(
  markup: string,
  slideNumber: number,
  logger: PptExportLogger,
): { backgroundSvg: string; texts: LiftedText[] } {
  try {
    const lifted = liftSvgText(markup);
    if (lifted.texts.length === 0) {
      return { backgroundSvg: markup, texts: [] };
    }
    return lifted;
  } catch (error) {
    logger.warn("pptx.svg-text-lift.failed", {
      slideNumber,
      error: error instanceof Error ? error.message : String(error),
    });
    return { backgroundSvg: markup, texts: [] };
  }
}

function addLiftedText(
  slide: { addText: (text: string, options: Record<string, unknown>) => void },
  text: LiftedText,
): void {
  slide.addText(text.content, {
    x: text.xIn,
    y: text.yIn,
    w: text.wIn,
    h: text.hIn,
    fontSize: text.fontSizePt,
    fontFace: text.fontFace,
    color: text.color,
    bold: text.bold,
    align: text.align,
    valign: "top",
    margin: 0,
    // The SVG already decided every line break; wrapping or autofit here would
    // reflow the text away from the position it occupies in the background.
    wrap: false,
    fit: "none",
    lineSpacing: text.lineSpacingPt,
    ...(text.charSpacingPt ? { charSpacing: text.charSpacingPt } : {}),
  });
}
