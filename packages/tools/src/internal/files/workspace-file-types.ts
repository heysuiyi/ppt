import { WorkspaceFileError } from "./workspace-file-contract.js";

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
