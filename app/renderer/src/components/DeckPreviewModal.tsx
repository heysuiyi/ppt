import type { Presentation } from "@shared/presentation";
import type React from "react";
import { Button, IconButton } from "./Button";
import { Dialog } from "./Dialog";
import { ClosePreviewIcon } from "./Icons";
import { PreviewNavigation } from "./PreviewNavigation";
import { SlidePreviewSurface } from "./SlidePreviewSurface";

interface DeckPreviewModalProps {
  open: boolean;
  presentation: Presentation;
  selectedSlideId: string;
  onSelectSlide: (slideId: string) => void;
  onClose: () => void;
}

export const DeckPreviewModal: React.FC<DeckPreviewModalProps> = ({
  open,
  presentation,
  selectedSlideId,
  onSelectSlide,
  onClose,
}) => {
  const activeIndex = Math.max(
    0,
    presentation.slides.findIndex((slide) => slide.id === selectedSlideId),
  );
  const activeSlide = presentation.slides[activeIndex];
  const navigate = (delta: number) => {
    const slide =
      presentation.slides[
        Math.max(0, Math.min(presentation.slides.length - 1, activeIndex + delta))
      ];
    if (slide) onSelectSlide(slide.id);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label={presentation.title || "演示文稿预览"}
      overlayClassName="deck-preview-modal-overlay"
      className="deck-preview-modal"
    >
      <div className="deck-preview-modal-header">
        <div>
          <h3>{presentation.title || "演示文稿预览"}</h3>
          <p>只读预览 · 共 {presentation.slides.length} 页</p>
        </div>
        <PreviewNavigation
          index={activeIndex}
          count={presentation.slides.length}
          onNavigate={navigate}
        />
        <IconButton onClick={onClose} title="关闭预览" aria-label="关闭预览">
          <ClosePreviewIcon size={16} />
        </IconButton>
      </div>
      <div className="deck-preview-modal-body">
        <aside className="deck-preview-modal-sidebar">
          {presentation.slides.map((slide, index) => (
            <Button
              key={slide.id}
              variant="quiet"
              className={`deck-preview-modal-thumb ${slide.id === activeSlide?.id ? "active" : ""}`}
              aria-current={slide.id === activeSlide?.id ? "page" : undefined}
              onClick={() => onSelectSlide(slide.id)}
            >
              <span>{index + 1}</span>
              <strong>{slide.title}</strong>
            </Button>
          ))}
        </aside>
        <div className="deck-preview-modal-canvas">
          {activeSlide ? (
            <SlidePreviewSurface slide={activeSlide} className="deck-preview-modal-slide" />
          ) : (
            <div className="deck-preview-modal-empty">暂无幻灯片内容</div>
          )}
        </div>
      </div>
    </Dialog>
  );
};
