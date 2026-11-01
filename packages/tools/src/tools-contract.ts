import type { AgentPlugin } from "@agent-harness/core/extensions/plugin-contract";

export type ToolsMode = "read-only" | "read-write";

export interface ToolsOptions {
  workspaceRoot: string;
  mode?: ToolsMode;
  maxFileBytes?: number;
  maxScanEntries?: number;
  maxSearchBytes?: number;
}

export interface ToolsPlugin extends AgentPlugin {
  readonly workspaceRoot: string;
  readonly mode: ToolsMode;
  readonly toolNames: readonly string[];
}

export interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
  expectedVersion?: string;
}

export interface ReadOutput {
  path: string;
  version: string;
  size: number;
  content: string;
  startOffset: number;
  endOffset: number;
  totalCharacters: number;
  hasMore: boolean;
  nextOffset?: number;
}

export interface WriteCreateInput {
  path: string;
  content: string;
  mode: "create";
}

export interface WriteReplaceInput {
  path: string;
  content: string;
  mode: "replace";
  expectedVersion: string;
}

export type WriteInput = WriteCreateInput | WriteReplaceInput;

export interface WriteOutput {
  path: string;
  version: string;
  size: number;
  operation: "created" | "replaced";
}

export interface EditInput {
  path: string;
  oldText: string;
  newText: string;
  expectedVersion: string;
  replaceAll?: boolean;
}

export interface EditOutput {
  path: string;
  version: string;
  size: number;
  replacements: number;
}

export interface GlobInput {
  pattern: string;
  limit?: number;
}

export interface GlobOutput {
  matches: string[];
  truncated: boolean;
}

export interface GrepInput {
  pattern: string;
  glob?: string;
  caseSensitive?: boolean;
  limit?: number;
}

export interface GrepMatch {
  path: string;
  version: string;
  line: number;
  text: string;
  truncated: boolean;
}

export interface GrepSkippedFile {
  path: string;
  reason: "binary" | "too-large";
}

export interface GrepOutput {
  matches: GrepMatch[];
  truncated: boolean;
  skipped: GrepSkippedFile[];
}
