export const MAX_FILE_READ_BYTES = 65_536;

export interface FileReadResult {
  readonly path: string;
  readonly version: string;
  readonly size: number;
  readonly content: string;
}

export interface FileReadPort {
  read(path: string, signal: AbortSignal): Promise<FileReadResult>;
}

const messages = {
  INVALID_WORKSPACE: "Workspace must be an existing, accessible directory without symbolic links.",
  INVALID_PATH: "A workspace-relative file path is required.",
  OUTSIDE_WORKSPACE: "File path must stay inside the workspace.",
  UNSAFE_FILE_TYPE: "Only regular files without symbolic links are supported.",
  INVALID_UTF8: "File must contain valid UTF-8 text.",
  BINARY_FILE: "Binary files are not supported.",
  FILE_TOO_LARGE: "File exceeds the 65536-byte read limit.",
  FILE_NOT_FOUND: "File was not found in the workspace.",
  FILE_ACCESS_DENIED: "File cannot be accessed.",
  STALE_FILE: "File or workspace changed during the read. Read it again.",
  FILE_READ_CANCELLED: "File read was cancelled.",
  FILE_READ_FAILED: "File could not be read safely.",
} as const;

export type FileReadErrorCode = keyof typeof messages;

/** 对外只提供固定诊断，不转发底层路径、异常原因或文件内容。 */
export class FileReadError extends Error {
  constructor(readonly code: FileReadErrorCode) {
    super(messages[code]);
    this.name = "FileReadError";
  }
}
