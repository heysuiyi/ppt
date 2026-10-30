import type { SlidePreviewEvent } from "@shared/cards/select-slide-previews";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArtifactCard, CardHeader } from "./ArtifactCard";
import { IconButton } from "./Button";
import { Dialog } from "./Dialog";
import { PreviewNavigation } from "./PreviewNavigation";

interface SlidePreviewGalleryProps {
  previews: SlidePreviewEvent[];
  selectedSlideId?: string;
  onSelectSlide?: (slideId: string) => void;
  variant?: "inline" | "panel";
  renderSlide?: (slideId: string) => React.ReactNode;
}

export const SlidePreviewGallery: React.FC<SlidePreviewGalleryProps> = ({
  previews,
  selectedSlideId,
  onSelectSlide,
  variant = "inline",
  renderSlide,
}) => {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const selected = selectedIndex === null ? undefined : previews[selectedIndex];
  const availableIndices = useMemo(
    () => previews.flatMap((preview, index) => (preview.payload.thumbnail ? [index] : [])),
    [previews],
  );

  const openPreview = useCallback(
    (index: number) => {
      const preview = previews[index];
      if (!preview?.payload.thumbnail) return;
      setSelectedIndex(index);
      onSelectSlide?.(preview.payload.slideId);
    },
    [onSelectSlide, previews],
  );

  const movePreview = useCallback(
    (delta: number) => {
      if (selectedIndex === null) return;
      const position = availableIndices.indexOf(selectedIndex);
      const nextIndex =
        availableIndices[Math.max(0, Math.min(availableIndices.length - 1, position + delta))];
      if (nextIndex !== undefined) openPreview(nextIndex);
    },
    [availableIndices, openPreview, selectedIndex],
  );
  useEffect(() => {
    if (selectedIndex !== null && !previews[selectedIndex]) {
      setSelectedIndex(null);
    }
  }, [previews, selectedIndex]);

  if (previews.length === 0) return null;

  const selectedThumbnail = selected?.payload.thumbnail;
  const liveSlide = selected && renderSlide ? renderSlide(selected.payload.slideId) : null;

  return (
    <>
      <ArtifactCard
        className={`slide-preview-gallery${variant === "panel" ? " slide-preview-gallery--panel" : ""}`}
        aria-label="页面检查预览"
      >
        {variant === "panel" ? null : (
          <CardHeader
            badge="页面预览"
            title={
              previews.length === 1 ? previews[0]!.payload.title : `已检查 ${previews.length} 页`
            }
          >
            <span className="slide-preview-gallery-hint">点击查看大图</span>
          </CardHeader>
        )}
        <div className="slide-preview-gallery-grid">
          {previews.map((event, index) => {
            const { thumbnail } = event.payload;
            return (
              <button
                type="button"
                className={[
                  "slide-preview-gallery-item",
                  selectedSlideId === event.payload.slideId ? "is-current-slide" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={event.eventId}
                onClick={() => openPreview(index)}
                disabled={!thumbnail}
                aria-current={selectedSlideId === event.payload.slideId ? "page" : undefined}
                aria-label={thumbnail ? `查看 ${event.payload.title} 大图` : event.payload.title}
              >
                <span className="slide-preview-gallery-media">
                  {thumbnail ? (
                    <img
                      src={`data:${thumbnail.mimeType};base64,${thumbnail.pngBase64}`}
                      width={thumbnail.width}
                      height={thumbnail.height}
                      alt=""
                    />
                  ) : (
                    <span className="slide-preview-gallery-error">
                      {event.payload.thumbnailError ?? "当前环境不支持截图"}
                    </span>
                  )}
                </span>
                <span className="slide-preview-gallery-caption">
                  <b>{index + 1}</b>
                  <span>{event.payload.title}</span>
                </span>
              </button>
            );
          })}
        </div>
      </ArtifactCard>

      <Dialog
        open={Boolean(selected && selectedThumbnail)}
        onClose={() => setSelectedIndex(null)}
        label={selected ? `${selected.payload.title} 页面预览` : "页面预览"}
        overlayClassName="slide-preview-lightbox"
        className="slide-preview-lightbox-panel"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            movePreview(event.key === "ArrowLeft" ? -1 : 1);
          }
        }}
      >
        {selected && selectedThumbnail && (
          <>
            <div className="slide-preview-lightbox-header">
              <span>{selected.payload.title}</span>
              <PreviewNavigation
                index={availableIndices.indexOf(selectedIndex ?? -1)}
                count={availableIndices.length}
                onNavigate={movePreview}
                showPosition
                previousLabel="上一张检查预览"
                nextLabel="下一张检查预览"
              />
              <IconButton onClick={() => setSelectedIndex(null)} aria-label="关闭预览">
                ×
              </IconButton>
            </div>
            {liveSlide ? (
              <div className="slide-preview-lightbox-live">{liveSlide}</div>
            ) : (
              <img
                src={`data:${selectedThumbnail.mimeType};base64,${selectedThumbnail.pngBase64}`}
                width={selectedThumbnail.width}
                height={selectedThumbnail.height}
                alt={`${selected.payload.title} 页面预览`}
              />
            )}
            {selected.payload.description && <p>{selected.payload.description}</p>}
          </>
        )}
      </Dialog>
    </>
  );
};
