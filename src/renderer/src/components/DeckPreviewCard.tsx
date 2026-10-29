import type { Presentation } from "@shared/presentation";
import type React from "react";
import { ArtifactCard, CardActions, CardHeader } from "./ArtifactCard";
import { Button } from "./Button";
import { DownloadIcon, OpenPreviewIcon } from "./Icons";
import { SlidePreviewSurface } from "./SlidePreviewSurface";

interface DeckPreviewCardProps {
  presentation: Presentation;
  isExporting?: boolean;
  resolved?: "confirmed" | "dismissed";
  onPreview?: () => void;
  onExport?: () => void;
}

export const DeckPreviewCard: React.FC<DeckPreviewCardProps> = ({
  presentation,
  isExporting,
  resolved,
  onPreview,
  onExport,
}) => {
  const previewSlides = presentation.slides.slice(0, 6);

  return (
    <ArtifactCard className="deck-preview-card">
      <CardHeader badge="演示文稿" title={presentation.title || "演示文稿"}>
        <span className="deck-preview-count">
          {presentation.slides.length} 页{resolved === "confirmed" && " · 已导出"}
        </span>
      </CardHeader>

      <div className="deck-preview-thumbnails">
        {previewSlides.map((slide) => (
          <div key={slide.id} className="deck-preview-thumb" title={slide.title}>
            <SlidePreviewSurface slide={slide} compact className="deck-preview-thumb-inner" />
          </div>
        ))}
        {presentation.slides.length > previewSlides.length && (
          <div className="deck-preview-thumb deck-preview-thumb-more">
            +{presentation.slides.length - previewSlides.length}
          </div>
        )}
      </div>

      <CardActions>
        {onPreview && (
          <Button variant="secondary" onClick={onPreview}>
            <OpenPreviewIcon size={13} />
            <span>预览 PPT</span>
          </Button>
        )}
        {onExport && (
          <Button
            variant="secondary"
            data-theme-emphasis="primary"
            disabled={isExporting}
            onClick={onExport}
          >
            <DownloadIcon size={13} />
            <span>{isExporting ? "导出中…" : "导出 PPT"}</span>
          </Button>
        )}
      </CardActions>
    </ArtifactCard>
  );
};
