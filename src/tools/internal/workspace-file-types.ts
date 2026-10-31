export type WorkspaceFileErrorCode =
  | "OUTSIDE_WORKSPACE"
  | "READ_REQUIRED"
  | "STALE_FILE"
  | "INVALID_EXPECTED_VERSION"
  | "INVALID_EDIT"
  | "OLD_STRING_NOT_FOUND"
  | "AMBIGUOUS_EDIT"
  | "UNSAFE_FILE_TYPE"
  | "INVALID_UTF8"
  | "FILE_TOO_LARGE"
  | "INVALID_READ_RANGE"
  | "UNSAFE_COMMAND"
  | "LOCK_SCHEMA_INVALID";

export class WorkspaceFileError extends Error {
  constructor(
    readonly code: WorkspaceFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceFileError";
  }
}

export interface WorkspaceFileReceipt {
  /** Canonical workspace-relative path. */
  path: string;
  /** Content-addressed optimistic concurrency token. */
  version: string;
  /** Last-modified time observed with this exact content. */
  mtimeMs: number;
  /** UTF-8 byte length of the complete file. */
  size: number;
  encoding: "utf8";
  newline: "lf" | "crlf" | "mixed" | "none";
}

export interface WorkspaceFileReadResult extends WorkspaceFileReceipt {
  content: string;
}

export interface WorkspaceFileReadOptions {
  maxBytes?: number;
}

export interface WorkspaceFileWindowReadOptions extends WorkspaceFileReadOptions {
  offset?: number;
  limit?: number;
  expectedVersion?: string;
}

export interface WorkspaceFileWindowReadResult extends WorkspaceFileReceipt {
  content: string;
  startOffset: number;
  endOffset: number;
  totalCharacters: number;
  hasMore: boolean;
  nextOffset?: number;
}

export interface WorkspaceFileWriteOptions {
  expectedVersion?: string;
}

export interface WorkspaceFileWriteResult extends WorkspaceFileReceipt {
  created: boolean;
  characterCount: number;
}

export interface WorkspaceFileEditOptions extends WorkspaceFileWriteOptions {
  replaceAll?: boolean;
}

export interface WorkspaceFileEditResult extends WorkspaceFileWriteResult {
  replacements: number;
}

export interface StableFileSnapshot {
  absolutePath: string;
  content: string;
  version: string;
  mtimeMs: number;
  size: number;
  mode: number;
  dev: number;
  ino: number;
  ctimeMs: number;
}

export interface GuardedDirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

export interface WorkspacePathGuard {
  canonicalRoot: string;
  directories: GuardedDirectoryIdentity[];
  validate: () => Promise<void>;
}

export interface ObservedFileCoverage {
  version: string;
  ranges: Array<{ start: number; end: number }>;
}

export function stalePathError(path: string, detail: string): WorkspaceFileError {
  return new WorkspaceFileError("STALE_FILE", `${detail} ${path}. Read it again and retry.`);
}
