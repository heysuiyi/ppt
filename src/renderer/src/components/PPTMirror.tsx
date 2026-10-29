import { formatPublicErrorMessage } from "@shared/agent-activity-display";
import { hasUnverifiedCommercialAssets } from "@shared/asset-license";
import { utf8ToBase64 } from "@shared/base64";
import { useArtifactCardManager } from "@shared/cards/display-card-managers";
import {
  getSlidePreviewBatchKey,
  selectLatestSlidePreviews,
} from "@shared/cards/select-slide-previews";
import type { Presentation, Slide } from "@shared/presentation";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { confirmSvgExportExpectation } from "../app/presentation/exportExpectations";
import {
  CheckIcon,
  ClosePreviewIcon,
  CompressIcon,
  DownloadIcon,
  ExpandIcon,
  LayoutIcon,
  PlayIcon,
} from "./Icons";
import { SlidePreviewGallery } from "./SlidePreviewGallery";

interface PPTMirrorProps {
  sessionId: string;
  presentation: Presentation;
  selectedSlideId: string;
  onSelectSlide: (slideId: string) => void;
  onCloseMirror: () => void;
  highlightSlideId: string | null; // AI 当前正在更新的页面 ID
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  triggerToast?: (msg: string) => void;
}

function SvgSlideSurface({ slide }: { slide: Slide }) {
  if (slide.visualSource?.kind !== "svg") return null;
  const source = `data:image/svg+xml;base64,${utf8ToBase64(slide.visualSource.markup)}`;
  return (
    <img
      src={source}
      alt={slide.title}
      style={{
        display: "block",
        width: "100%",
        height: "100%",
        objectFit: "fill",
      }}
    />
  );
}

function NonSvgSlidePlaceholder({ slide }: { slide: Slide }) {
  return (
    <div className="slide-non-svg-placeholder">
      <span>{slide.title}</span>
      <small>此页非 SVG 原生，无法预览</small>
    </div>
  );
}

interface MirrorSlideFrameProps {
  slide: Slide;
  className?: string;
}

function MirrorSlideFrame({ slide, className }: MirrorSlideFrameProps) {
  return (
    <div className={["mirror-slide-frame", className].filter(Boolean).join(" ")}>
      {slide.visualSource?.kind === "svg" ? (
        <SvgSlideSurface slide={slide} />
      ) : (
        <NonSvgSlidePlaceholder slide={slide} />
      )}
    </div>
  );
}

export const PPTMirror: React.FC<PPTMirrorProps> = ({
  sessionId,
  presentation,
  selectedSlideId,
  onSelectSlide,
  onCloseMirror,
  highlightSlideId,
  isExpanded = false,
  onToggleExpand,
  triggerToast,
}) => {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenIndex, setFullscreenIndex] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [fullscreenWidth, setFullscreenWidth] = useState(0);
  const fullscreenViewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = fullscreenViewportRef.current;
    if (!isFullscreen || !viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setFullscreenWidth(Math.min(width, (height * 1280) / 720));
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [isFullscreen]);
  const artifactCards = useArtifactCardManager((state) => state.cards);
  const inspectionPreviews = useMemo(
    () => selectLatestSlidePreviews(artifactCards),
    [artifactCards],
  );
  const inspectionBatchKey = getSlidePreviewBatchKey(inspectionPreviews);
  const [activeView, setActiveView] = useState<"slides" | "inspection">(() =>
    inspectionPreviews.length > 0 ? "inspection" : "slides",
  );
  const surfacedInspectionBatchRef = useRef<string | undefined>(inspectionBatchKey);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const handleDownload = async () => {
    if (!sessionId || isExporting) return;
    if (!confirmSvgExportExpectation(presentation)) return;
    const needsApproval = hasUnverifiedCommercialAssets(presentation);
    const allowUnverifiedAssets = needsApproval
      ? window.confirm("演示文稿包含尚未核实商业授权的图片。是否明确批准本次导出？")
      : false;
    if (needsApproval && !allowUnverifiedAssets) return;
    setIsExporting(true);
    try {
      const savedPath = await window.desktopApi.exportPresentation(sessionId, {
        allowUnverifiedAssets,
      });
      if (savedPath) {
        triggerToast?.(`已成功导出至: ${savedPath}`);
      }
    } catch (error) {
      console.error(error);
      triggerToast?.(`导出失败：${formatPublicErrorMessage(error, "请稍后重试。")}`);
    } finally {
      setIsExporting(false);
    }
  };

  const slides = presentation.slides;
  const slideOrder = useMemo(
    () => new Map(slides.map((slide, index) => [slide.id, index])),
    [slides],
  );
  const orderedInspectionPreviews = useMemo(
    () =>
      [...inspectionPreviews].sort(
        (left, right) =>
          (slideOrder.get(left.payload.slideId) ?? Number.MAX_SAFE_INTEGER) -
          (slideOrder.get(right.payload.slideId) ?? Number.MAX_SAFE_INTEGER),
      ),
    [inspectionPreviews, slideOrder],
  );
  const reviewedSlideIds = useMemo(
    () => new Set(inspectionPreviews.map((preview) => preview.payload.slideId)),
    [inspectionPreviews],
  );
  const reviewedSlideCount = slides.filter((slide) => reviewedSlideIds.has(slide.id)).length;
  const selectedSlideIndex = slides.findIndex((slide) => slide.id === selectedSlideId);
  const selectedSlide = slides[selectedSlideIndex >= 0 ? selectedSlideIndex : 0];

  useEffect(() => {
    if (!inspectionBatchKey || inspectionBatchKey === surfacedInspectionBatchRef.current) return;
    surfacedInspectionBatchRef.current = inspectionBatchKey;
    setActiveView("inspection");
  }, [inspectionBatchKey]);

  useEffect(() => {
    if (activeView === "inspection" && inspectionPreviews.length === 0) {
      setActiveView("slides");
    }
  }, [activeView, inspectionPreviews.length]);

  // 当外部选中/高亮变化时，平滑滚动至可视区域
  useEffect(() => {
    if (activeView !== "slides") return;
    const targetId = highlightSlideId || selectedSlideId;
    if (targetId && cardRefs.current[targetId]) {
      cardRefs.current[targetId]?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [activeView, selectedSlideId, highlightSlideId]);

  // 监听全屏放映时的键盘事件
  useEffect(() => {
    if (!isFullscreen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "Space" || e.key === " ") {
        e.preventDefault();
        setFullscreenIndex((prev) => Math.min(slides.length - 1, prev + 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setFullscreenIndex((prev) => Math.max(0, prev - 1));
      } else if (e.key === "Escape") {
        e.preventDefault();
        setIsFullscreen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFullscreen, slides.length]);

  // 当全屏放映的页面改变时，同步选中状态到主工作区
  useEffect(() => {
    if (isFullscreen && slides[fullscreenIndex]) {
      onSelectSlide(slides[fullscreenIndex].id);
    }
  }, [fullscreenIndex, isFullscreen, slides, onSelectSlide]);

  const handleFullscreenOpen = () => {
    const idx = slides.findIndex((s) => s.id === selectedSlideId);
    setFullscreenIndex(idx >= 0 ? idx : 0);
    setIsFullscreen(true);
  };

  const selectRelativeSlide = (delta: number) => {
    if (slides.length === 0) return;
    const currentIndex = selectedSlideIndex >= 0 ? selectedSlideIndex : 0;
    const nextIndex = Math.max(0, Math.min(slides.length - 1, currentIndex + delta));
    onSelectSlide(slides[nextIndex]!.id);
  };

  const selectInspectedSlide = (slideId: string) => {
    if (slideOrder.has(slideId)) onSelectSlide(slideId);
  };

  const renderInspectedSlide = (slideId: string) => {
    const index = slideOrder.get(slideId);
    if (index === undefined) return null;
    const slide = slides[index];
    if (!slide) return null;
    return <MirrorSlideFrame slide={slide} />;
  };

  return (
    <aside
      className={`right-panel mirror-panel${isExpanded ? " is-expanded" : ""}`}
      data-ui-region="canvas"
    >
      {/* 顶部工具栏 */}
      <div className="panel-header right-header mirror-header">
        <div className="mirror-header-copy">
          <span title={presentation.title || "未命名演示文稿"}>PPT 预览</span>
        </div>
        <div className="mirror-header-actions">
          <button
            onClick={handleFullscreenOpen}
            className="action-icon-btn mirror-header-icon-btn"
            disabled={slides.length === 0}
            aria-label="放映演示文稿"
            title="放映演示文稿"
          >
            <PlayIcon size={16} />
          </button>
          <button
            onClick={handleDownload}
            className="action-icon-btn mirror-header-icon-btn"
            disabled={isExporting}
            aria-label="下载 PPT"
            title="下载 PPT"
          >
            <DownloadIcon size={16} />
          </button>
          <button
            onClick={onToggleExpand}
            className="action-icon-btn mirror-header-icon-btn mirror-expand-toggle-btn"
            aria-label={isExpanded ? "收缩预览" : "放大预览"}
            title={isExpanded ? "收缩预览" : "放大预览"}
          >
            {isExpanded ? <CompressIcon size={16} /> : <ExpandIcon size={16} />}
          </button>
          <button
            onClick={onCloseMirror}
            className="action-icon-btn mirror-header-icon-btn mirror-panel-close-btn"
            aria-label="关闭右侧预览"
            title="关闭右侧预览"
          >
            <ClosePreviewIcon size={16} />
          </button>
        </div>
      </div>

      <div className="mirror-workbench-toolbar">
        <div className="mirror-view-tabs" role="tablist" aria-label="预览内容">
          <button
            type="button"
            role="tab"
            id="mirror-slides-tab"
            aria-controls="mirror-preview-content"
            aria-selected={activeView === "slides"}
            className={activeView === "slides" ? "is-active" : ""}
            onClick={() => setActiveView("slides")}
          >
            <LayoutIcon size={14} />
            <span>幻灯片</span>
            <b>{slides.length}</b>
          </button>
          <button
            type="button"
            role="tab"
            id="mirror-inspection-tab"
            aria-controls="mirror-preview-content"
            aria-selected={activeView === "inspection"}
            className={activeView === "inspection" ? "is-active" : ""}
            onClick={() => setActiveView("inspection")}
            disabled={inspectionPreviews.length === 0}
          >
            <CheckIcon size={14} />
            <span>检查结果</span>
            <b>{inspectionPreviews.length}</b>
          </button>
        </div>

        {activeView === "slides" ? (
          <div className="mirror-view-summary">
            <div className="mirror-view-summary-copy">
              <strong title={selectedSlide?.title}>{selectedSlide?.title ?? "暂无页面"}</strong>
              <span>
                {slides.length > 0
                  ? `第 ${Math.max(0, selectedSlideIndex) + 1} 页 / 共 ${slides.length} 页`
                  : "等待生成演示文稿"}
              </span>
            </div>
            <div className="mirror-page-navigation" aria-label="页面导航">
              <button
                type="button"
                onClick={() => selectRelativeSlide(-1)}
                disabled={selectedSlideIndex <= 0}
                aria-label="选择上一页"
              >
                ‹
              </button>
              <button
                type="button"
                onClick={() => selectRelativeSlide(1)}
                disabled={
                  slides.length === 0 ||
                  selectedSlideIndex < 0 ||
                  selectedSlideIndex >= slides.length - 1
                }
                aria-label="选择下一页"
              >
                ›
              </button>
            </div>
          </div>
        ) : (
          <div className="mirror-view-summary mirror-inspection-summary">
            <div className="mirror-view-summary-copy">
              <strong>本轮页面检查</strong>
              <span>
                {slides.length > 0
                  ? `覆盖 ${reviewedSlideCount} / ${slides.length} 页`
                  : `${inspectionPreviews.length} 页`}
              </span>
            </div>
            <div
              className="mirror-inspection-progress"
              role="progressbar"
              aria-label="页面检查覆盖率"
              aria-valuemin={0}
              aria-valuemax={Math.max(1, slides.length)}
              aria-valuenow={reviewedSlideCount}
            >
              <span
                style={{
                  width: `${
                    slides.length > 0
                      ? Math.min(100, (reviewedSlideCount / slides.length) * 100)
                      : 0
                  }%`,
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* 幻灯片导航与页面检查共用右侧工作台 */}
      <div
        id="mirror-preview-content"
        className={`sections-container flex-1 overflow-y-auto mirror-workbench-content mirror-workbench-content--${activeView}`}
        ref={scrollContainerRef}
        role="tabpanel"
        aria-labelledby={activeView === "slides" ? "mirror-slides-tab" : "mirror-inspection-tab"}
      >
        {activeView === "inspection" ? (
          <SlidePreviewGallery
            previews={orderedInspectionPreviews}
            selectedSlideId={selectedSlideId}
            onSelectSlide={selectInspectedSlide}
            renderSlide={renderInspectedSlide}
            variant="panel"
          />
        ) : (
          <div className="mirror-slides-workspace">
            {selectedSlide ? (
              <section className="mirror-focus-preview" aria-label="当前页面预览">
                <div className="mirror-focus-preview-label">
                  <span>当前页面</span>
                  <span>
                    {Math.max(0, selectedSlideIndex) + 1} / {slides.length}
                  </span>
                </div>
                <button
                  type="button"
                  className="mirror-focus-canvas"
                  onClick={handleFullscreenOpen}
                  aria-label={`放大查看第 ${Math.max(0, selectedSlideIndex) + 1} 页：${selectedSlide.title}`}
                >
                  <MirrorSlideFrame slide={selectedSlide} className="mirror-focus-frame" />
                  <span className="mirror-focus-canvas-action">点击放大查看</span>
                </button>
              </section>
            ) : null}

            <div className="mirror-slide-list" aria-label="幻灯片导航">
              {slides.map((slide, index) => {
                const isSelected = selectedSlideId === slide.id;
                const isHighlighted = highlightSlideId === slide.id;

                return (
                  <button
                    type="button"
                    key={slide.id}
                    ref={(element) => {
                      cardRefs.current[slide.id] = element;
                    }}
                    className={`mirror-slide-card-container ${
                      isSelected ? "selected" : ""
                    } ${isHighlighted ? "highlighted-pulse" : ""}`}
                    onClick={() => onSelectSlide(slide.id)}
                    aria-label={`选择第 ${index + 1} 页：${slide.title}`}
                    aria-current={isSelected ? "page" : undefined}
                  >
                    <MirrorSlideFrame slide={slide} className="mirror-slide-wrapper" />
                    <span className="mirror-card-meta">
                      <span className="mirror-card-identity">
                        <span className="slide-number">
                          {(index + 1).toString().padStart(2, "0")}
                        </span>
                        <span className="mirror-card-title" title={slide.title}>
                          {slide.title}
                        </span>
                      </span>
                      {isSelected && <span className="selected-tag">已选中</span>}
                    </span>
                  </button>
                );
              })}
            </div>

            {slides.length === 0 && (
              <div className="mirror-empty-state">
                <p className="mirror-empty-title">还没有幻灯片</p>
                <p className="mirror-empty-hint">在下方对话框描述你的需求，AI 会帮你生成第一页。</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 4. 全屏放映灯箱模态窗口 */}
      {isFullscreen &&
        createPortal(
          <div className="slideshow-lightbox-overlay" onClick={() => setIsFullscreen(false)}>
            <div className="slideshow-lightbox-content" onClick={(e) => e.stopPropagation()}>
              {/* 顶栏控制 */}
              <div className="slideshow-top-bar">
                <span className="slideshow-title">{presentation.title}</span>
                <span className="slideshow-progress">
                  第 {fullscreenIndex + 1} 页 / 共 {slides.length} 页
                </span>
                <button className="slideshow-close" onClick={() => setIsFullscreen(false)}>
                  ✕ 关闭放映
                </button>
              </div>

              {/* 主幻灯片预览区 */}
              <div
                className="slideshow-viewport-container"
                ref={fullscreenViewportRef}
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const clickX = e.clientX - rect.left;
                  if (clickX > rect.width / 2) {
                    setFullscreenIndex((prev) => Math.min(slides.length - 1, prev + 1));
                  } else {
                    setFullscreenIndex((prev) => Math.max(0, prev - 1));
                  }
                }}
                style={{ cursor: "pointer", minWidth: 0, minHeight: 0 }}
              >
                {slides[fullscreenIndex] ? (
                  <div
                    className="slide-viewport slideshow-slide-viewport"
                    style={{ width: fullscreenWidth }}
                  >
                    {slides[fullscreenIndex].visualSource?.kind === "svg" ? (
                      <SvgSlideSurface slide={slides[fullscreenIndex]} />
                    ) : (
                      <NonSvgSlidePlaceholder slide={slides[fullscreenIndex]} />
                    )}
                  </div>
                ) : (
                  <div className="text-white">无页面</div>
                )}
              </div>

              {/* 左右翻页控制器 */}
              <button
                className="slideshow-nav-arrow left"
                disabled={fullscreenIndex === 0}
                onClick={(e) => {
                  e.stopPropagation();
                  setFullscreenIndex((i) => Math.max(0, i - 1));
                }}
              >
                ‹
              </button>
              <button
                className="slideshow-nav-arrow right"
                disabled={fullscreenIndex === slides.length - 1}
                onClick={(e) => {
                  e.stopPropagation();
                  setFullscreenIndex((i) => Math.min(slides.length - 1, i + 1));
                }}
              >
                ›
              </button>
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
};
