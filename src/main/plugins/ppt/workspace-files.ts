import type { z } from "zod";
import { toMainAgentTool } from "../../agent/tools/core/workspace-files";
import {
  editFileContract as hostEdit,
  globFilesContract as hostGlob,
  readFileContract as hostRead,
  writeFileContract as hostWrite,
  type WorkspaceFileToolContext,
  type WorkspaceFileToolContract,
} from "../../agent/tools/files/workspace-file-tool-contract";
import type { ToolContext } from "../../agent/tools/tool-definition";
import { requirePptCapability } from "./context";
import { createPptFilePolicy, isPresentationOwnedWorkspacePath } from "./file-policy";

function withPptPolicy<TParams extends z.ZodObject<any>, TResult>(
  contract: WorkspaceFileToolContract<TParams, TResult>,
): WorkspaceFileToolContract<TParams, TResult> {
  return {
    ...contract,
    execute: (
      args,
      context: WorkspaceFileToolContext & Pick<ToolContext, "presentationLifecycle">,
    ) =>
      contract.execute(args, {
        ...context,
        filePolicy: createPptFilePolicy(context.presentationLifecycle),
      }),
  };
}

export const readFileContract = withPptPolicy(hostRead);
export const globFilesContract = withPptPolicy(hostGlob);
export const writeFileContract = withPptPolicy(hostWrite);
export const editFileContract = withPptPolicy(hostEdit);

const validateWrite = requirePptCapability<{ path: string }>(
  ["create", "edit", "restyle"],
  (args) => isPresentationOwnedWorkspacePath(args.path),
);
const lockGuidance =
  " PPT design/design-spec.json 和 slides/page-plan.json 必须满足 SVG deck 锁契约，非法内容不落盘。";

export const pptWorkspaceFileTools = [
  toMainAgentTool(globFilesContract),
  toMainAgentTool(readFileContract),
  {
    ...toMainAgentTool(writeFileContract),
    validateContext: validateWrite,
    description: hostWrite.description + lockGuidance,
  },
  {
    ...toMainAgentTool(editFileContract),
    validateContext: validateWrite,
    description: hostEdit.description + lockGuidance,
  },
];
