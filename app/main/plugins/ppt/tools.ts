import { hostTools } from "../../agent/tools/host-tools";
import type { ToolDefinition } from "../../agent/tools/tool-definition";
import { ToolRegistry } from "../../agent/tools/tool-registry";
import { pptSkillGuidance } from "./skill-guidance";
import { beginPptCapabilityTool } from "./tools/begin-ppt-capability";
import { getDesignReferenceTool } from "./tools/get-design-reference";
import { getSelectionTool } from "./tools/get-selection";
import { listSlidesTool } from "./tools/list-slides";
import { previewSlideTool } from "./tools/preview-slide";
import { previewSvgPageTool } from "./tools/preview-svg-page";
import { readCurrentSlideTool } from "./tools/read-current-slide";
import { readPresentationSnapshotTool } from "./tools/read-presentation-snapshot";
import { resolveProjectTemplateTool } from "./tools/resolve-project-template";
import { searchSlideImagesTool } from "./tools/search-slide-images";
import { setPptTaskAssessmentTool } from "./tools/set-ppt-task-assessment";
import { submitPptReviewTool } from "./tools/submit-ppt-review";
import { submitSvgDeckTool } from "./tools/submit-svg-deck";
import { pptWorkspaceFileTools } from "./workspace-files";

export const pptTools: readonly ToolDefinition[] = [
  beginPptCapabilityTool,
  getDesignReferenceTool,
  getSelectionTool,
  listSlidesTool,
  previewSlideTool,
  previewSvgPageTool,
  readCurrentSlideTool,
  readPresentationSnapshotTool,
  resolveProjectTemplateTool,
  setPptTaskAssessmentTool,
  submitPptReviewTool,
  submitSvgDeckTool,
  searchSlideImagesTool,
];

export function createPptToolRegistry() {
  const registry = new ToolRegistry();
  for (const tool of [...hostTools, ...pptTools, ...pptWorkspaceFileTools]) {
    registry.register(
      tool.name === "LoadSkill"
        ? {
            ...tool,
            execute: (args, context) =>
              tool.execute(args, {
                ...context,
                skillGuidance: (entry) => pptSkillGuidance(context, entry),
              }),
          }
        : tool,
    );
  }
  return registry;
}
