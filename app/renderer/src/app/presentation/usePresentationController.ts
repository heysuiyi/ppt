import type { Presentation } from "@shared/presentation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface PresentationSyncOptions {
  preferredSlideId?: string;
  selectLastSlide?: boolean;
  openMirror?: boolean;
  highlightSlide?: boolean;
}

interface LoadPresentationOptions {
  openMirror?: boolean;
}

export interface PresentationController {
  presentation: Presentation | undefined;
  selectedSlideId: string;
  setSelectedSlideId: (slideId: string) => void;
  highlightSlideId: string | null;
  isMirrorOpen: boolean;
  isMirrorVisible: boolean;
  isMirrorExpanded: boolean;
  isDeckPreviewOpen: boolean;
  loadPresentation: (presentation: Presentation, options?: LoadPresentationOptions) => void;
  resetPresentation: () => void;
  syncPresentation: (options?: PresentationSyncOptions) => Promise<Presentation | undefined>;
  openMirror: () => void;
  closeMirror: () => void;
  toggleMirrorExpanded: () => void;
  openDeckPreview: () => void;
  closeDeckPreview: () => void;
  /** Open mirror and highlight the first affected slide when a proposal needs review. */
  focusAffectedSlides: (slideIds: string[]) => void;
}

export function usePresentationController(
  notify: (message: string) => void,
): PresentationController {
  const [presentation, setPresentation] = useState<Presentation>();
  const [selectedSlideId, setSelectedSlideId] = useState("");
  const [highlightSlideId, setHighlightSlideId] = useState<string | null>(null);
  const [isMirrorOpen, setIsMirrorOpen] = useState(false);
  const [isMirrorExpanded, setIsMirrorExpanded] = useState(false);
  const [isDeckPreviewOpen, setIsDeckPreviewOpen] = useState(false);
  const highlightTimerRef = useRef<number | null>(null);

  const isMirrorVisible = Boolean(isMirrorOpen && presentation);

  const clearHighlightTimer = useCallback(() => {
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearHighlightTimer, [clearHighlightTimer]);

  const highlightSlide = useCallback(
    (slideId: string) => {
      clearHighlightTimer();
      setHighlightSlideId(slideId);
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightSlideId(null);
        highlightTimerRef.current = null;
      }, 2_500);
    },
    [clearHighlightTimer],
  );

  const selectSlideFromSnapshot = useCallback(
    (snapshot: Presentation, options: PresentationSyncOptions = {}) => {
      let nextSlideId = options.preferredSlideId;
      if (options.selectLastSlide && snapshot.slides.length > 0) {
        nextSlideId = snapshot.slides[snapshot.slides.length - 1].id;
      }
      if (!nextSlideId || !snapshot.slides.some((slide) => slide.id === nextSlideId)) {
        nextSlideId = snapshot.slides[0]?.id;
      }
      setSelectedSlideId(nextSlideId ?? "");

      if (options.highlightSlide && nextSlideId) {
        highlightSlide(nextSlideId);
      }
    },
    [highlightSlide],
  );

  const loadPresentation = useCallback(
    (snapshot: Presentation, options: LoadPresentationOptions = {}) => {
      setPresentation(snapshot);
      setSelectedSlideId(snapshot.slides[0]?.id ?? "");
      clearHighlightTimer();
      setHighlightSlideId(null);
      setIsDeckPreviewOpen(false);
      setIsMirrorExpanded(false);
      setIsMirrorOpen(options.openMirror ?? snapshot.revision > 0);
    },
    [clearHighlightTimer],
  );

  const resetPresentation = useCallback(() => {
    setPresentation(undefined);
    setSelectedSlideId("");
    clearHighlightTimer();
    setHighlightSlideId(null);
    setIsMirrorOpen(false);
    setIsMirrorExpanded(false);
    setIsDeckPreviewOpen(false);
  }, [clearHighlightTimer]);

  /**
   * 从 Main 的 CommandBus 回读已提交的权威 Presentation，并刷新当前选页和镜像视图。
   * 这是 query 生成应用内 PPT 后回到 Renderer 的链路终点。
   */
  const syncPresentation = useCallback(
    async (options: PresentationSyncOptions = {}) => {
      try {
        const snapshot = await window.desktopApi.getPresentation();
        setPresentation(snapshot);
        selectSlideFromSnapshot(snapshot, options);
        if (options.openMirror) setIsMirrorOpen(true);
        return snapshot;
      } catch (error) {
        console.error("同步演示文稿失败:", error);
        return undefined;
      }
    },
    [selectSlideFromSnapshot],
  );

  const openMirror = useCallback(() => {
    if (!presentation) {
      notify("暂无可预览的 PPT");
      return;
    }
    setIsMirrorOpen(true);
  }, [notify, presentation]);

  const closeMirror = useCallback(() => {
    setIsMirrorOpen(false);
    setIsMirrorExpanded(false);
  }, []);

  const openDeckPreview = useCallback(() => {
    setIsDeckPreviewOpen(true);
    setIsMirrorOpen(true);
  }, []);

  const focusAffectedSlides = useCallback(
    (slideIds: string[]) => {
      const targetId = slideIds.find((id) => id.trim().length > 0);
      if (!targetId) return;
      setIsMirrorOpen(true);
      setSelectedSlideId(targetId);
      highlightSlide(targetId);
    },
    [highlightSlide],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const pressedP = event.key.toLowerCase() === "p";
      const matches = isMac
        ? event.metaKey && event.altKey && pressedP
        : event.ctrlKey && event.altKey && pressedP;
      if (!matches) return;

      event.preventDefault();
      setIsMirrorOpen((open) => {
        const next = !open;
        notify(next ? "已打开右侧预览" : "已关闭右侧预览");
        return next;
      });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [notify]);

  return useMemo(
    () => ({
      presentation,
      selectedSlideId,
      setSelectedSlideId,
      highlightSlideId,
      isMirrorOpen,
      isMirrorVisible,
      isMirrorExpanded,
      isDeckPreviewOpen,
      loadPresentation,
      resetPresentation,
      syncPresentation,
      openMirror,
      closeMirror,
      toggleMirrorExpanded: () => setIsMirrorExpanded((expanded) => !expanded),
      openDeckPreview,
      closeDeckPreview: () => setIsDeckPreviewOpen(false),
      focusAffectedSlides,
    }),
    [
      closeMirror,
      focusAffectedSlides,
      highlightSlideId,
      isDeckPreviewOpen,
      isMirrorExpanded,
      isMirrorOpen,
      isMirrorVisible,
      loadPresentation,
      openDeckPreview,
      openMirror,
      presentation,
      resetPresentation,
      selectedSlideId,
      syncPresentation,
    ],
  );
}
