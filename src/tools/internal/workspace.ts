import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { ToolResult } from "@agent-ppt/harness/tools/tool-contract";
import type { EditInput, EditOutput } from "../edit";
import type { GlobInput, GlobOutput } from "../glob";
import type { GrepInput, GrepOutput } from "../grep";
import type { ReadInput, ReadOutput } from "../read";
import type { WriteInput, WriteOutput } from "../write";
import { writeTextFileAtomic } from "./atomic";
import { failedResult, safeToolsError, type ToolsEffects, ToolsError } from "./errors";
import { createAtomicCommitGuard, withFileMutationLock } from "./workspace-file-mutation";
import {
  assertSameSnapshot,
  assertValidUtf8Text,
  readSnapshotIfPresent,
  readStableSnapshot,
  type SnapshotReadBudget,
} from "./workspace-file-snapshot";
import type { StableFileSnapshot } from "./workspace-file-types";
import {
  assertSafeDirectory,
  captureWorkspacePathGuard,
  resolveContainedWorkspacePath,
  sameFileIdentity,
} from "./workspace-path-guard";
import {
  mergeCoverageRanges,
  splitsSurrogatePair,
  unicodeSafeEndOffset,
} from "./workspace-read-window";
import { assertRelativeToolPath, scanWorkspace, workspacePattern } from "./workspace-scan";
import { countOccurrences, replaceFirst } from "./workspace-text-edit";

export interface WorkspaceOptions {
  workspaceRoot: string;
  maxFileBytes?: number;
  maxScanEntries?: number;
  maxSearchBytes?: number;
}

interface Observation {
  snapshot: StableFileSnapshot;
  totalCharacters: number;
  ranges: Array<{ start: number; end: number }>;
}

interface MutationState {
  effects: ToolsEffects;
}

export async function prepareWorkspaceRoot(root: string): Promise<string> {
  if (typeof root !== "string" || !root.trim() || root.includes("\0")) {
    throw new ToolsError("INVALID_OPTIONS");
  }
  try {
    const path = resolve(root);
    const before = await lstat(path);
    assertSafeDirectory(before, path, ".");
    const canonical = await realpath(path);
    const after = await lstat(path);
    assertSafeDirectory(after, path, ".");
    if (!sameFileIdentity(before, after)) throw new ToolsError("STALE_FILE");
    return canonical;
  } catch {
    throw new ToolsError("INVALID_WORKSPACE");
  }
}

export class Workspace {
  readonly workspaceRoot: string;
  private readonly maxFileBytes: number;
  private readonly maxScanEntries: number;
  private readonly maxSearchBytes: number;
  private readonly observations = new Map<string, Observation>();

  constructor(options: WorkspaceOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.maxFileBytes = boundedOption(options.maxFileBytes, 65_536, 16 * 1024 * 1024);
    this.maxScanEntries = boundedOption(options.maxScanEntries, 10_000, 100_000);
    this.maxSearchBytes = boundedOption(options.maxSearchBytes, 8 * 1024 * 1024, 128 * 1024 * 1024);
  }

  clear(): void {
    this.observations.clear();
  }

  async read(input: ReadInput, signal: AbortSignal): Promise<ToolResult<ReadOutput>> {
    try {
      signal.throwIfAborted();
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 4000;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 2 ||
        limit > 4000
      )
        throw new ToolsError("INVALID_READ_RANGE");
      if (offset > 0 && !input.expectedVersion) throw new ToolsError("INVALID_EXPECTED_VERSION");
      const snapshot = await this.snapshot(input.path, signal);
      if (input.expectedVersion !== undefined && input.expectedVersion !== snapshot.version)
        throw new ToolsError("STALE_FILE");
      if (offset > snapshot.content.length || splitsSurrogatePair(snapshot.content, offset))
        throw new ToolsError("INVALID_READ_RANGE");
      const end = unicodeSafeEndOffset(snapshot.content, offset, limit);
      signal.throwIfAborted();
      this.observe(snapshot, offset, end);
      const hasMore = end < snapshot.content.length;
      return {
        status: "succeeded",
        effects: "none",
        output: {
          path: this.relativePath(snapshot.absolutePath),
          version: snapshot.version,
          size: snapshot.size,
          content: snapshot.content.slice(offset, end),
          startOffset: offset,
          endOffset: end,
          totalCharacters: snapshot.content.length,
          hasMore,
          ...(hasMore ? { nextOffset: end } : {}),
        },
      };
    } catch (error) {
      return failedResult(signal.aborted ? new ToolsError("CANCELLED") : error);
    }
  }

  async write(input: WriteInput, signal: AbortSignal): Promise<ToolResult<WriteOutput>> {
    const state: MutationState = { effects: "none" };
    try {
      signal.throwIfAborted();
      this.assertContent(input.content, input.path);
      const absolute = await this.resolvePath(input.path);
      return await withFileMutationLock<ToolResult<WriteOutput>>(absolute, async () => {
        signal.throwIfAborted();
        let current: StableFileSnapshot | undefined;
        if (input.mode === "create") {
          try {
            await lstat(absolute);
            throw new ToolsError("ALREADY_EXISTS");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        } else {
          current = await this.snapshot(input.path, signal);
          this.assertObserved(current, input.expectedVersion);
        }
        await this.ensureParents(absolute, input.path, signal, state);
        const committed = await this.commit(
          input.path,
          absolute,
          current,
          input.content,
          signal,
          state,
        );
        return {
          status: "succeeded",
          effects: "applied",
          output: {
            path: this.relativePath(committed.absolutePath),
            version: committed.version,
            size: committed.size,
            operation: input.mode === "create" ? "created" : "replaced",
          },
        };
      });
    } catch (error) {
      return failedResult(
        signal.aborted ? new ToolsError("CANCELLED", state.effects) : error,
        state.effects,
      );
    }
  }

  async edit(input: EditInput, signal: AbortSignal): Promise<ToolResult<EditOutput>> {
    const state: MutationState = { effects: "none" };
    try {
      signal.throwIfAborted();
      if (!input.oldText || input.oldText === input.newText) throw new ToolsError("INVALID_EDIT");
      assertValidUtf8Text(input.oldText, input.path);
      this.assertContent(input.newText, input.path);
      const absolute = await this.resolvePath(input.path);
      return await withFileMutationLock<ToolResult<EditOutput>>(absolute, async () => {
        signal.throwIfAborted();
        const current = await this.snapshot(input.path, signal);
        this.assertObserved(current, input.expectedVersion);
        const count = countOccurrences(current.content, input.oldText);
        if (count === 0) throw new ToolsError("OLD_STRING_NOT_FOUND");
        if (count > 1 && !input.replaceAll) throw new ToolsError("AMBIGUOUS_EDIT");
        const replacements = input.replaceAll ? count : 1;
        // Check expansion before building a potentially much larger replacement string.
        const size =
          current.size +
          replacements * (Buffer.byteLength(input.newText) - Buffer.byteLength(input.oldText));
        if (!Number.isSafeInteger(size) || size > this.maxFileBytes)
          throw new ToolsError("FILE_TOO_LARGE");
        const updated = input.replaceAll
          ? current.content.replaceAll(input.oldText, () => input.newText)
          : replaceFirst(current.content, input.oldText, input.newText);
        const committed = await this.commit(input.path, absolute, current, updated, signal, state);
        return {
          status: "succeeded",
          effects: "applied",
          output: {
            path: this.relativePath(committed.absolutePath),
            version: committed.version,
            size: committed.size,
            replacements,
          },
        };
      });
    } catch (error) {
      return failedResult(
        signal.aborted ? new ToolsError("CANCELLED", state.effects) : error,
        state.effects,
      );
    }
  }

  async glob(input: GlobInput, signal: AbortSignal): Promise<ToolResult<GlobOutput>> {
    try {
      signal.throwIfAborted();
      const limit = resultLimit(input.limit);
      const scan = await scanWorkspace(
        this.workspaceRoot,
        workspacePattern(input.pattern),
        this.maxScanEntries,
        signal,
      );
      signal.throwIfAborted();
      return {
        status: "succeeded",
        effects: "none",
        output: {
          matches: scan.paths.slice(0, limit),
          truncated: scan.truncated || scan.paths.length > limit,
        },
      };
    } catch (error) {
      return failedResult(signal.aborted ? new ToolsError("CANCELLED") : error);
    }
  }

  async grep(input: GrepInput, signal: AbortSignal): Promise<ToolResult<GrepOutput>> {
    try {
      signal.throwIfAborted();
      if (!input.pattern || input.pattern.length > 4000) throw new ToolsError("INVALID_INPUT");
      const limit = resultLimit(input.limit);
      const scan = await scanWorkspace(
        this.workspaceRoot,
        workspacePattern(input.glob ?? "**/*"),
        this.maxScanEntries,
        signal,
      );
      const output: GrepOutput = { matches: [], skipped: [], truncated: scan.truncated };
      const needle = input.caseSensitive === false ? input.pattern.toLowerCase() : input.pattern;
      const budget: SnapshotReadBudget = { remaining: this.maxSearchBytes };
      for (const path of scan.paths) {
        signal.throwIfAborted();
        if (
          output.matches.length >= limit ||
          output.skipped.length >= limit ||
          budget.remaining <= 0
        ) {
          output.truncated = true;
          break;
        }
        let snapshot: StableFileSnapshot;
        try {
          snapshot = await this.snapshot(
            path,
            signal,
            Math.min(this.maxFileBytes, budget.remaining),
            budget,
          );
        } catch (error) {
          const safe = safeToolsError(error);
          if (
            safe.code === "BINARY_FILE" ||
            safe.code === "INVALID_UTF8" ||
            safe.code === "FILE_TOO_LARGE"
          ) {
            output.skipped.push({
              path,
              reason: safe.code === "FILE_TOO_LARGE" ? "too-large" : "binary",
            });
            if (safe.code === "FILE_TOO_LARGE" && budget.remaining < this.maxFileBytes)
              output.truncated = true;
            continue;
          }
          throw error;
        }
        let start = 0;
        let line = 1;
        while (start < snapshot.content.length) {
          signal.throwIfAborted();
          const newline = snapshot.content.indexOf("\n", start);
          const end = newline < 0 ? snapshot.content.length : newline;
          const textEnd =
            end > start && snapshot.content.charCodeAt(end - 1) === 13 ? end - 1 : end;
          const text = snapshot.content.slice(start, textEnd);
          if ((input.caseSensitive === false ? text.toLowerCase() : text).includes(needle)) {
            if (output.matches.length >= limit) {
              output.truncated = true;
              break;
            }
            const visibleEnd = unicodeSafeEndOffset(text, 0, 4000);
            if (visibleEnd < text.length) output.truncated = true;
            output.matches.push({
              path,
              version: snapshot.version,
              line,
              text: text.slice(0, visibleEnd),
              truncated: visibleEnd < text.length,
            });
          }
          if (newline < 0) break;
          start = newline + 1;
          line += 1;
        }
      }
      signal.throwIfAborted();
      return { status: "succeeded", effects: "none", output };
    } catch (error) {
      return failedResult(signal.aborted ? new ToolsError("CANCELLED") : error);
    }
  }

  private async resolvePath(path: string): Promise<string> {
    assertRelativeToolPath(path);
    return await resolveContainedWorkspacePath(this.workspaceRoot, path);
  }

  private async snapshot(
    path: string,
    signal: AbortSignal,
    maxBytes = this.maxFileBytes,
    budget?: SnapshotReadBudget,
  ): Promise<StableFileSnapshot> {
    signal.throwIfAborted();
    const absolute = await this.resolvePath(path);
    const guard = await captureWorkspacePathGuard(this.workspaceRoot, absolute, path);
    const snapshot = await readStableSnapshot(absolute, maxBytes, signal, budget);
    await guard.validate();
    if ((await this.resolvePath(path)) !== absolute) throw new ToolsError("STALE_FILE");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(snapshot.content))
      throw new ToolsError("BINARY_FILE");
    signal.throwIfAborted();
    return snapshot;
  }

  private assertContent(content: string, path: string): void {
    if (Buffer.byteLength(content) > this.maxFileBytes) throw new ToolsError("FILE_TOO_LARGE");
    assertValidUtf8Text(content, path);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content))
      throw new ToolsError("BINARY_FILE");
  }

  private observe(snapshot: StableFileSnapshot, start: number, end: number): void {
    const key = snapshot.absolutePath;
    let observed = this.observations.get(key);
    if (observed) {
      try {
        assertSameSnapshot(observed.snapshot, snapshot, ".");
      } catch {
        observed = undefined;
      }
    }
    if (!observed)
      observed = {
        snapshot: { ...snapshot, content: "" },
        totalCharacters: snapshot.content.length,
        ranges: [],
      };
    observed.ranges = mergeCoverageRanges([...observed.ranges, { start, end }]);
    if (!this.observations.has(key) && this.observations.size >= this.maxScanEntries) {
      const oldest = this.observations.keys().next().value;
      if (oldest !== undefined) this.observations.delete(oldest);
    }
    this.observations.set(key, observed);
  }

  private assertObserved(current: StableFileSnapshot, version: string): void {
    const observed = this.observations.get(current.absolutePath);
    if (
      observed?.ranges.length !== 1 ||
      observed.ranges[0]!.start !== 0 ||
      observed.ranges[0]!.end !== observed.totalCharacters
    )
      throw new ToolsError("READ_REQUIRED");
    if (version !== observed.snapshot.version) throw new ToolsError("INVALID_EXPECTED_VERSION");
    assertSameSnapshot(observed.snapshot, current, ".");
  }

  private async ensureParents(
    absolute: string,
    path: string,
    signal: AbortSignal,
    state: MutationState,
  ): Promise<void> {
    const parts = relative(this.workspaceRoot, dirname(absolute))
      .split(/[\\/]+/)
      .filter(Boolean);
    let directory = this.workspaceRoot;
    for (const part of parts) {
      signal.throwIfAborted();
      directory = resolve(directory, part);
      const guard = await captureWorkspacePathGuard(this.workspaceRoot, directory, path);
      await guard.validate();
      try {
        const stats = await lstat(directory);
        assertSafeDirectory(stats, directory, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        signal.throwIfAborted();
        // A failing mkdir may still have changed the filesystem.
        state.effects = "unknown";
        await mkdir(directory);
        state.effects = "applied";
        await guard.validate();
        assertSafeDirectory(await lstat(directory), directory, path);
      }
    }
  }

  private async commit(
    path: string,
    absolute: string,
    current: StableFileSnapshot | undefined,
    content: string,
    signal: AbortSignal,
    state: MutationState,
  ): Promise<StableFileSnapshot> {
    signal.throwIfAborted();
    if ((await this.resolvePath(path)) !== absolute) throw new ToolsError("STALE_FILE");
    const guard = await captureWorkspacePathGuard(this.workspaceRoot, absolute, path);
    const latest = await readSnapshotIfPresent(absolute, this.maxFileBytes, signal);
    if (current && latest) assertSameSnapshot(current, latest, ".");
    else if (current || latest) throw new ToolsError("STALE_FILE");
    await guard.validate();
    signal.throwIfAborted();
    let committed: StableFileSnapshot | undefined;
    const priorEffects = state.effects;
    state.effects = priorEffects === "none" ? "unknown" : priorEffects;
    try {
      await writeTextFileAtomic(absolute, content, {
        mode: current ? current.mode & 0o777 : undefined,
        ioLimits: {
          maxFileBytes: Math.max(this.maxFileBytes, 65_536),
          maxScanEntries: this.maxScanEntries,
        },
        temporaryDirectory: guard.canonicalRoot,
        commitGuard: createAtomicCommitGuard({
          path,
          pathGuard: guard,
          current,
          expectedContent: content,
          maxBytes: this.maxFileBytes,
          signal,
          onPublished: () => {
            state.effects = "applied";
          },
          onCommitted: (snapshot) => {
            committed = snapshot;
          },
        }),
      });
    } catch (error) {
      // Known conflicts without destination effects still created atomic metadata/locks.
      throw safeToolsError(error, state.effects);
    }
    if (!committed) throw new ToolsError("IO_ERROR", state.effects);
    // A mutation result is not a model-visible observation of the new contents.
    this.observations.delete(absolute);
    return committed;
  }

  private relativePath(absolute: string): string {
    return relative(this.workspaceRoot, absolute).replace(/\\/g, "/");
  }
}

function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum)
    throw new ToolsError("INVALID_OPTIONS");
  return resolved;
}

function resultLimit(value: number | undefined): number {
  const limit = value ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new ToolsError("INVALID_INPUT");
  return limit;
}
