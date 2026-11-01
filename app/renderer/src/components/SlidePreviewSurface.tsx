import { utf8ToBase64 } from "@shared/base64";
import type { Slide } from "@shared/presentation";

interface SlidePreviewSurfaceProps {
  slide: Slide;
  compact?: boolean;
  className?: string;
}

/** Slide paper is deliberately independent of the surrounding UI theme. */
export function SlidePreviewSurface({
  slide,
  compact = false,
  className,
}: SlidePreviewSurfaceProps) {
  return (
    <div className={["slide-preview-surface", className].filter(Boolean).join(" ")}>
      {slide.visualSource?.kind === "svg" ? (
        <img
          src={`data:image/svg+xml;base64,${utf8ToBase64(slide.visualSource.markup)}`}
          alt={slide.title}
        />
      ) : (
        <div className={`slide-preview-placeholder${compact ? " is-compact" : ""}`}>
          {compact ? (
            <span>非 SVG</span>
          ) : (
            <>
              <span>{slide.title}</span>
              <small>此页非 SVG 原生，无法预览</small>
            </>
          )}
        </div>
      )}
    </div>
  );
}
