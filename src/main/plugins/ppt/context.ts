import type { PptCapability } from "@shared/presentation-lifecycle";
import type { ToolContext } from "../../agent/tools/tool-definition";

export function requirePresentation(context: ToolContext) {
  if (!context.presentation) throw new Error("PPT tools require a Presentation snapshot.");
  return context.presentation;
}

export function requirePptCapability<TArgs>(
  allowedCapabilities: readonly PptCapability[],
  isRequired?: (args: TArgs) => boolean,
): (args: TArgs, context: ToolContext) => void {
  return (args, context) => {
    if (context.presentationLifecycle && (!isRequired || isRequired(args))) {
      context.presentationLifecycle.requireActiveCapability(allowedCapabilities);
    }
  };
}
