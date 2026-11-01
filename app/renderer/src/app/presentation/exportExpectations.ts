import type { Presentation } from "@shared/presentation";
import { presentationUsesSvgPages } from "@shared/presentation-export";

export function confirmSvgExportExpectation(presentation: Presentation): boolean {
  if (!presentationUsesSvgPages(presentation)) return true;
  return window.confirm(
    "当前演示文稿以混合方式导出：装饰与图形仍为整页图片；标题与正文一般会提升为可编辑文字框。复杂字形、路径字或图表标签可能仍嵌在图中、不可单独修改。是否继续导出？",
  );
}
