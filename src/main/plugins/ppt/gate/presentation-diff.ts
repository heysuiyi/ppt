import type { Presentation } from "@shared/presentation";

export interface PresentationDiff {
  titleChanged: boolean;
  oldTitle: string;
  newTitle: string;
  designSystemChanged: boolean;
  slidesAddedCount: number;
  slidesRemovedCount: number;
  affectedSlideIds: string[];
  elementChanges: {
    addedCount: number;
    removedCount: number;
    updatedCount: number;
  };
}

/**
 * Presentation 快照差异的结构化摘要生成器。
 *
 * SVG 页面以 visualSource sha/path 与叙事元数据为主；不再枚举 element-id 差异。
 */
export class PresentationDiffGenerator {
  static generate(before: Presentation, after: Presentation): PresentationDiff {
    const affectedSlideIds = new Set<string>();

    const titleChanged = before.title !== after.title;
    const designSystemChanged =
      JSON.stringify(before.designSystem) !== JSON.stringify(after.designSystem);

    const beforeSlideIds = new Set(before.slides.map((s) => s.id));
    const afterSlideIds = new Set(after.slides.map((s) => s.id));

    let slidesAddedCount = 0;
    let slidesRemovedCount = 0;
    let updatedCount = 0;

    for (const id of afterSlideIds) {
      if (!beforeSlideIds.has(id)) {
        slidesAddedCount++;
        affectedSlideIds.add(id);
      }
    }

    for (const id of beforeSlideIds) {
      if (!afterSlideIds.has(id)) {
        slidesRemovedCount++;
        affectedSlideIds.add(id);
      }
    }

    for (const afterSlide of after.slides) {
      const beforeSlide = before.slides.find((s) => s.id === afterSlide.id);
      if (!beforeSlide) continue;

      const pageSourceChanged =
        beforeSlide.visualSource?.sha256 !== afterSlide.visualSource?.sha256 ||
        beforeSlide.visualSource?.sourcePath !== afterSlide.visualSource?.sourcePath;
      const pageMetadataChanged =
        beforeSlide.title !== afterSlide.title ||
        beforeSlide.speakerNotes !== afterSlide.speakerNotes ||
        JSON.stringify(beforeSlide.narrative) !== JSON.stringify(afterSlide.narrative);

      if (pageSourceChanged || pageMetadataChanged) {
        updatedCount++;
        affectedSlideIds.add(afterSlide.id);
      }
    }

    if (designSystemChanged) {
      for (const slide of after.slides) affectedSlideIds.add(slide.id);
    }

    return {
      titleChanged,
      oldTitle: before.title,
      newTitle: after.title,
      designSystemChanged,
      slidesAddedCount,
      slidesRemovedCount,
      affectedSlideIds: Array.from(affectedSlideIds),
      elementChanges: {
        addedCount: 0,
        removedCount: 0,
        updatedCount,
      },
    };
  }
}
