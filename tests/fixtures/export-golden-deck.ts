import { createHash } from "node:crypto";
import { DEFAULT_DESIGN_SYSTEM } from "../../src/design-system";
import type { Presentation, Slide, SlideNarrative } from "../../src/shared/presentation";
import { SVG_PAGE_HEIGHT, SVG_PAGE_WIDTH } from "../../src/shared/svg-page";

const PAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">';

export const EXPORT_GOLDEN_DECK_ID = "export-golden-deck";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function narrative(
  role: string,
  coreMessage: string,
  audienceMove: string,
  rhythm: SlideNarrative["rhythm"],
  layoutIntent: string,
): SlideNarrative {
  return { role, coreMessage, audienceMove, rhythm, layoutIntent };
}

function svgSlide(input: {
  id: string;
  title: string;
  markupBody: string;
  narrative: SlideNarrative;
  speakerNotes?: string;
}): Slide {
  const markup = `${PAGE}${input.markupBody}</svg>`;
  return {
    id: input.id,
    title: input.title,
    ...(input.speakerNotes !== undefined ? { speakerNotes: input.speakerNotes } : {}),
    visualSource: {
      kind: "svg",
      markup,
      width: SVG_PAGE_WIDTH,
      height: SVG_PAGE_HEIGHT,
      sha256: sha256(markup),
      sourcePath: `slides/svg/${input.id}.svg`,
      resources: [],
    },
    narrative: input.narrative,
  };
}

/** Stable multi-slide deck covering hybrid PPTX export cases. IDs must stay fixed. */
export function createExportGoldenPresentation(): Presentation {
  return {
    id: EXPORT_GOLDEN_DECK_ID,
    title: "Export Golden Deck",
    revision: 1,
    designSystem: DEFAULT_DESIGN_SYSTEM,
    slides: [
      svgSlide({
        id: "cover",
        title: "Export Golden",
        markupBody:
          '<rect width="1280" height="720" fill="#0f172a"/>' +
          '<text x="640" y="360" fill="#f8fafc" font-size="64" text-anchor="middle"' +
          ' font-family="Arial, sans-serif">Export Golden</text>',
        narrative: narrative(
          "cover",
          "Hybrid export must keep title geometry stable.",
          "Recognize the golden cover.",
          "anchor",
          "One centered title on a dark field.",
        ),
      }),
      svgSlide({
        id: "evidence",
        title: "Evidence stack",
        markupBody:
          '<rect width="1280" height="720" fill="#111827"/>' +
          '<text x="80" y="120" fill="#e5e7eb" font-size="40" font-family="Arial">Evidence stack</text>' +
          '<text x="80" y="220" fill="#cbd5e1" font-size="24" font-family="Arial">' +
          '<tspan x="80" dy="0">First claim</tspan>' +
          '<tspan x="80" dy="36">Second claim</tspan>' +
          '<tspan x="80" dy="36">Third claim</tspan>' +
          "</text>",
        narrative: narrative(
          "evidence",
          "Multiple text nodes and tspan lines lift independently.",
          "Read the stacked claims.",
          "dense",
          "Title plus a three-line evidence stack.",
        ),
      }),
      svgSlide({
        id: "cjk",
        title: "中文标题",
        markupBody:
          '<rect width="1280" height="720" fill="#0b1220"/>' +
          '<text x="72" y="140" font-size="36" font-weight="700" fill="#f8fafc">' +
          '<tspan x="72" dy="0">决策仍在「周」的节奏，</tspan>' +
          '<tspan x="72" dy="48">业务已在「小时」的战场</tspan>' +
          "</text>",
        narrative: narrative(
          "evidence",
          "Full-width CJK advance must size the editable box.",
          "Trust the bilingual lift.",
          "dense",
          "Two CJK lines with explicit dy.",
        ),
      }),
      svgSlide({
        id: "decoration",
        title: "Decoration only",
        markupBody:
          '<rect width="1280" height="720" fill="#f8fafc"/>' +
          '<circle cx="640" cy="360" r="120" fill="#2563eb"/>',
        narrative: narrative(
          "motif",
          "Pages without liftable text stay a full-page SVG image.",
          "Pause on the motif.",
          "breathing",
          "One decorative mark, no text.",
        ),
      }),
      svgSlide({
        id: "hybrid",
        title: "Hybrid lift",
        markupBody:
          '<rect width="1280" height="720" fill="#1e293b"/>' +
          '<text x="80" y="160" font-size="40" fill="#f8fafc">Editable headline</text>' +
          '<text x="80" y="280" font-size="28" fill="#94a3b8" transform="rotate(8 80 280)">Stays in background</text>',
        narrative: narrative(
          "evidence",
          "Transformed glyphs stay in the SVG background.",
          "Edit only the liftable headline.",
          "dense",
          "One liftable title plus one rotated leftover.",
        ),
      }),
      svgSlide({
        id: "notes",
        title: "Speaker notes",
        markupBody:
          '<rect width="1280" height="720" fill="#0f172a"/>' +
          '<text x="80" y="200" font-size="48" fill="#ffffff">Ask for approval</text>',
        narrative: narrative(
          "summary",
          "Speaker notes must survive hybrid export.",
          "Confirm the close.",
          "breathing",
          "One closing line with notes.",
        ),
        speakerNotes: "Explain the export contract and ask for approval.",
      }),
    ],
  };
}
