export {
  type WorkspaceFileEditOptions,
  type WorkspaceFileEditResult,
  WorkspaceFileError,
  type WorkspaceFileErrorCode,
  type WorkspaceFileReadOptions,
  type WorkspaceFileReadResult,
  type WorkspaceFileReceipt,
  type WorkspaceFileWindowReadOptions,
  type WorkspaceFileWindowReadResult,
  type WorkspaceFileWriteOptions,
  type WorkspaceFileWriteResult,
} from "./internal/files/workspace-file-contract.js";
export {
  canonicalizeWorkspaceRoot,
  WorkspaceFileService,
} from "./internal/files/workspace-file-service.js";
export { globWorkspaceFiles } from "./internal/files/workspace-glob.js";
export { countOccurrences } from "./internal/files/workspace-text-edit.js";
