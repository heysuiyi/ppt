import { z } from "zod";
import type { ToolDefinition } from "../../../agent/tools/tool-definition";

export const getSelectionSchema = z.object({});

/**
 * Core Tool: 读取用户当前选中的页面。
 * 用于“这个”“选中的内容”等指代请求。
 * 只反映编辑器事实；无选择时返回空，不推断目标。
 * Element selection is not supported in the SVG-native authoring model.
 */
export const getSelectionTool: ToolDefinition<
  typeof getSelectionSchema,
  { currentSlideId?: string; selectedElementIds: string[] }
> = {
  name: "GetSelection",
  description:
    "获取用户当前在 PPT 编辑器中选中的页面 ID。元素级选择已移除，selectedElementIds 恒为空。",
  category: "core",
  loadPolicy: "core",
  inputSchema: getSelectionSchema,
  behavior: { concurrency: { mode: "parallel" } },
  risk: "low",
  execute: async (_, context) => {
    return {
      currentSlideId: context.currentSlideId,
      selectedElementIds: [],
    };
  },
};
