import {
  editFileContract,
  globFilesContract,
  readFileContract,
  type WorkspaceFileToolContract,
  writeFileContract,
} from "../files/workspace-file-tool-contract";
import type { ToolDefinition } from "../tool-definition";

export {
  editFileOutputSchema,
  editFileSchema,
  fileReceiptSchema,
  globFilesOutputSchema,
  globFilesSchema,
  readFileOutputSchema,
  readFileSchema,
  writeFileOutputSchema,
  writeFileSchema,
} from "../files/workspace-file-tool-contract";

export function toMainAgentTool<TParams extends WorkspaceFileToolContract["inputSchema"], TResult>(
  contract: WorkspaceFileToolContract<TParams, TResult>,
): ToolDefinition<TParams, TResult> {
  return {
    ...contract,
    category: "core",
    loadPolicy: "core",
    ...(contract.formatResultForModel
      ? { mapResultToModelContent: contract.formatResultForModel }
      : {}),
  };
}

export const readFileTool = toMainAgentTool(readFileContract);
export const globFilesTool = toMainAgentTool(globFilesContract);
export const writeFileTool = toMainAgentTool(writeFileContract);
export const editFileTool = toMainAgentTool(editFileContract);

export const workspaceFileTools = [
  globFilesTool,
  readFileTool,
  writeFileTool,
  editFileTool,
] as const;
