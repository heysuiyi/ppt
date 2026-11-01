import type { Slide } from "@shared/presentation";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * PPT 画布几何常量与遗留 element-IR 辅助函数。
 *
 * SVG-native 页面不再走 element 布局校验；validateLayout 对 SVG 页 no-op，
 * 对非 SVG 页跳过 element 几何检查。
 */
export class LayoutPolicy {
  static readonly CANVAS_WIDTH = 1280;
  static readonly CANVAS_HEIGHT = 720;
  static readonly SAFE_MARGIN = 40;

  static isWithinSafeZone(box: BoundingBox): boolean {
    const minX = LayoutPolicy.SAFE_MARGIN;
    const maxX = LayoutPolicy.CANVAS_WIDTH - LayoutPolicy.SAFE_MARGIN;
    const minY = LayoutPolicy.SAFE_MARGIN;
    const maxY = LayoutPolicy.CANVAS_HEIGHT - LayoutPolicy.SAFE_MARGIN;

    return (
      box.x >= minX && box.x + box.width <= maxX && box.y >= minY && box.y + box.height <= maxY
    );
  }

  static isWithinCanvas(box: BoundingBox): boolean {
    return (
      box.x >= 0 &&
      box.x + box.width <= LayoutPolicy.CANVAS_WIDTH &&
      box.y >= 0 &&
      box.y + box.height <= LayoutPolicy.CANVAS_HEIGHT
    );
  }

  static isOverlapping(a: BoundingBox, b: BoundingBox): boolean {
    return (
      a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
    );
  }

  /** SVG slides pass through; legacy element-IR layout checks are disabled. */
  static validateLayout(slide: Slide): { valid: boolean; warnings: string[] } {
    if (slide.visualSource?.kind === "svg") {
      return { valid: true, warnings: [] };
    }
    return { valid: true, warnings: [] };
  }
}
