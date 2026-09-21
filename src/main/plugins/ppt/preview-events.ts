import type { AgentRendererEvent } from "../../agent/runtime/lifecycle/agent-event-ports";
import type { SlideThumbnailResult } from "./adapters/electron-thumbnail-service";

export function previewResultEvents(result: {
  preview?: {
    slideId?: string;
    sourcePath?: string;
    sha256?: string;
    title?: string;
    description?: string;
  };
  thumbnail?: SlideThumbnailResult | null;
  thumbnailError?: string;
}): AgentRendererEvent[] {
  const previewId =
    result.preview?.slideId ??
    (result.preview?.sha256 ? `svg-preview-${result.preview.sha256.slice(0, 16)}` : undefined);
  if (!previewId) return [];
  const title = result.preview?.title ?? result.preview?.sourcePath ?? previewId;
  return [
    {
      type: "slide-preview-ready",
      slideId: previewId,
      title,
      description: result.preview?.description ?? "",
      thumbnail: result.thumbnail ?? null,
      ...(result.thumbnailError ? { thumbnailError: result.thumbnailError } : {}),
      message: result.thumbnail ? `已生成 ${title} 的页面预览` : `已读取 ${title} 的页面结构`,
    },
  ];
}
