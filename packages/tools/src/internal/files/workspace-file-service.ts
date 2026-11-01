import { lstatSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { withAtomicFileTransaction, writeTextFileAtomic } from "./atomic.js";
import { AtomicWriteConflictError } from "./atomic-errors.js";
import {
  type WorkspaceFileEditOptions,
  type WorkspaceFileEditResult,
  WorkspaceFileError,
  type WorkspaceFileReadOptions,
  type WorkspaceFileReadResult,
  type WorkspaceFileReceipt,
  type WorkspaceFileWindowReadOptions,
  type WorkspaceFileWindowReadResult,
  type WorkspaceFileWriteOptions,
  type WorkspaceFileWriteResult,
} from "./workspace-file-contract.js";
import {
  classifyWorkspaceErrorsAfterSideEffect,
  createAtomicCommitGuard,
  ensureSafeParentDirectory,
  withFileMutationLock,
} from "./workspace-file-mutation.js";
import {
  assertSameSnapshot,
  assertValidUtf8Text,
  detectNewlineStyle,
  readSnapshotIfPresent,
  readStableSnapshot,
} from "./workspace-file-snapshot.js";
import {
  type ObservedFileCoverage,
  type StableFileSnapshot,
  stalePathError,
} from "./workspace-file-types.js";
import {
  captureWorkspacePathGuard,
  resolveContainedWorkspacePath,
} from "./workspace-path-guard.js";
import {
  assertReadWindowNumber,
  mergeCoverageRanges,
  splitsSurrogatePair,
  unicodeSafeEndOffset,
} from "./workspace-read-window.js";
import { countOccurrences, replaceFirst } from "./workspace-text-edit.js";

/**
 * Runtime-scoped text-file service shared by main agents and teammates.
 *
 * Existing files may only be mutated after this service instance has read the
 * same canonical file. The read receipt and the current on-disk snapshot are
 * compared immediately before every atomic replacement.
 */
/**
 * Prefer the realpath form so Windows 8.3 short names (e.g. GHA TEMP
 * `RUNNER~1`) match paths returned by resolveContainedWorkspacePath.
 * Use realpathSync.native: plain realpathSync does not expand 8.3 names on
 * Windows, while fs.promises.realpath / realpathSync.native do.
 * Leave symlink/junction roots unresolved so the path guard can reject them.
 */
export function canonicalizeWorkspaceRoot(workspaceRoot: string): string {
  if (!workspaceRoot.trim()) {
    throw new Error("Workspace root is required.");
  }
  const resolved = resolve(workspaceRoot);
  try {
    const stats = lstatSync(resolved);
    if (!stats.isSymbolicLink() && stats.isDirectory()) {
      return realpathSync.native(resolved);
    }
  } catch {
    // Missing or inaccessible roots fail on first file operation.
  }
  return resolved;
}

export class WorkspaceFileService {
  readonly workspaceRoot: string;

  private readonly receipts = new Map<string, WorkspaceFileReceipt>();
  private readonly receiptSnapshots = new Map<string, StableFileSnapshot>();
  private readonly observedCoverage = new Map<string, ObservedFileCoverage>();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = canonicalizeWorkspaceRoot(workspaceRoot);
  }

  async read(
    path: string,
    options: WorkspaceFileReadOptions = {},
  ): Promise<WorkspaceFileReadResult> {
    const snapshot = await this.readSnapshot(path, options);
    const receipt = this.recordReceipt(snapshot);
    return {
      ...receipt,
      content: snapshot.content,
    };
  }

  /** Read a complete stable snapshot without granting mutation authority. */
  async inspect(
    path: string,
    options: WorkspaceFileReadOptions = {},
  ): Promise<WorkspaceFileReadResult> {
    const snapshot = await this.readSnapshot(path, options);
    return {
      ...this.createReceipt(snapshot),
      content: snapshot.content,
    };
  }

  /**
   * Return a bounded model-visible window. Mutation authority is granted only
   * after this service has observed every character of the same file version.
   */
  async readWindow(
    path: string,
    options: WorkspaceFileWindowReadOptions = {},
  ): Promise<WorkspaceFileWindowReadResult> {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 4_000;
    assertReadWindowNumber("offset", offset, { min: 0 });
    assertReadWindowNumber("limit", limit, { min: 2, max: 4_000 });
    if (offset > 0 && !options.expectedVersion) {
      throw new WorkspaceFileError(
        "INVALID_EXPECTED_VERSION",
        "expected_version is required when continuing a paged ReadFile call.",
      );
    }

    const snapshot = await this.readSnapshot(path, options);
    if (options.expectedVersion !== undefined && options.expectedVersion !== snapshot.version) {
      throw new WorkspaceFileError(
        "STALE_FILE",
        `File changed between paged reads: ${this.relativePath(snapshot.absolutePath)}. ` +
          "Restart from offset 0.",
      );
    }

    const totalCharacters = snapshot.content.length;
    if (offset > totalCharacters || (offset === totalCharacters && totalCharacters > 0)) {
      throw new WorkspaceFileError(
        "INVALID_READ_RANGE",
        `ReadFile offset ${offset} is outside ${this.relativePath(snapshot.absolutePath)} ` +
          `(${totalCharacters} UTF-16 units).`,
      );
    }
    if (splitsSurrogatePair(snapshot.content, offset)) {
      throw new WorkspaceFileError(
        "INVALID_READ_RANGE",
        `ReadFile offset ${offset} splits a Unicode surrogate pair in ` +
          `${this.relativePath(snapshot.absolutePath)}. Use nextOffset from the previous result.`,
      );
    }

    const endOffset = unicodeSafeEndOffset(snapshot.content, offset, limit);
    const content = snapshot.content.slice(offset, endOffset);
    this.recordObservedWindow(snapshot, offset, endOffset);
    const hasMore = endOffset < totalCharacters;
    return {
      ...this.createReceipt(snapshot),
      content,
      startOffset: offset,
      endOffset,
      totalCharacters,
      hasMore,
      ...(hasMore ? { nextOffset: endOffset } : {}),
    };
  }

  private async readSnapshot(
    path: string,
    options: WorkspaceFileReadOptions,
  ): Promise<StableFileSnapshot> {
    if (
      options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    ) {
      throw new Error("maxBytes must be a non-negative safe integer.");
    }
    const absolutePath = await this.resolveContainedPath(path);
    let pathGuard = await captureWorkspacePathGuard(this.workspaceRoot, absolutePath, path);
    return await withAtomicFileTransaction(
      absolutePath,
      pathGuard.canonicalRoot,
      async (recover) => {
        const recovered = await recover(pathGuard.validate);
        if (recovered) {
          try {
            const recoveredPath = await this.resolveContainedPath(path);
            if (recoveredPath !== absolutePath) {
              throw stalePathError(
                path,
                "File path identity changed while an interrupted replacement was recovered.",
              );
            }
            pathGuard = await captureWorkspacePathGuard(this.workspaceRoot, absolutePath, path);
            await pathGuard.validate();
          } catch (error) {
            throw new Error(
              `Interrupted replacement recovery changed state before path verification failed: ${path}`,
              { cause: error },
            );
          }
        }
        let snapshot: StableFileSnapshot;
        try {
          snapshot = await readStableSnapshot(absolutePath, options.maxBytes);
          await pathGuard.validate();
        } catch (error) {
          if (recovered && error instanceof WorkspaceFileError) {
            throw new Error(
              `Interrupted replacement was recovered, but the resulting file could not be verified: ${path}`,
              { cause: error },
            );
          }
          throw error;
        }
        return snapshot;
      },
    );
  }

  async write(
    path: string,
    content: string,
    options: WorkspaceFileWriteOptions = {},
  ): Promise<WorkspaceFileWriteResult> {
    assertValidUtf8Text(content, path);
    const absolutePath = await this.resolveContainedPath(path);
    return await withFileMutationLock(absolutePath, async () => {
      const parentCreated = await ensureSafeParentDirectory(this.workspaceRoot, absolutePath, path);
      return await classifyWorkspaceErrorsAfterSideEffect(parentCreated, path, async () => {
        const guardedPath = await this.resolveContainedPath(path);
        if (guardedPath !== absolutePath) {
          throw stalePathError(path, "File path identity changed before write preparation.");
        }
        const pathGuard = await captureWorkspacePathGuard(this.workspaceRoot, absolutePath, path);
        const current = await readSnapshotIfPresent(absolutePath);
        this.assertMutationAllowed(absolutePath, current, options.expectedVersion);

        const latest = await readSnapshotIfPresent(absolutePath);
        if (current && latest) {
          assertSameSnapshot(current, latest, path);
        } else if (current || latest) {
          throw new WorkspaceFileError(
            "STALE_FILE",
            `File existence changed while the write was being prepared: ${path}. ` +
              "Read it and retry.",
          );
        }

        await pathGuard.validate();
        let committedSnapshot: StableFileSnapshot | undefined;
        try {
          await writeTextFileAtomic(absolutePath, content, {
            mode: current ? current.mode & 0o777 : undefined,
            temporaryDirectory: pathGuard.canonicalRoot,
            commitGuard: createAtomicCommitGuard({
              path,
              pathGuard,
              current,
              expectedContent: content,
              onCommitted: (snapshot) => {
                committedSnapshot = snapshot;
              },
            }),
          });
        } catch (error) {
          if (error instanceof AtomicWriteConflictError && error.sideEffects === "none") {
            throw stalePathError(path, error.message);
          }
          throw error;
        }
        if (!committedSnapshot) {
          throw new Error(`Atomic write committed without a verified receipt snapshot: ${path}`);
        }
        const receipt = this.recordReceipt(committedSnapshot);
        return {
          ...receipt,
          created: current === undefined,
          characterCount: content.length,
        };
      });
    });
  }

  async edit(
    path: string,
    oldString: string,
    newString: string,
    options: WorkspaceFileEditOptions = {},
  ): Promise<WorkspaceFileEditResult> {
    if (!oldString) {
      throw new WorkspaceFileError("INVALID_EDIT", "old_string must not be empty.");
    }
    if (oldString === newString) {
      throw new WorkspaceFileError("INVALID_EDIT", "old_string and new_string must be different.");
    }

    assertValidUtf8Text(newString, path);
    const absolutePath = await this.resolveContainedPath(path);
    return await withFileMutationLock(absolutePath, async () => {
      const guardedPath = await this.resolveContainedPath(path);
      if (guardedPath !== absolutePath) {
        throw stalePathError(path, "File path identity changed before edit preparation.");
      }
      const current = await readSnapshotIfPresent(absolutePath);
      if (!current) {
        throw new WorkspaceFileError("OLD_STRING_NOT_FOUND", `Cannot edit missing file: ${path}`);
      }
      const pathGuard = await captureWorkspacePathGuard(this.workspaceRoot, absolutePath, path);
      this.assertMutationAllowed(absolutePath, current, options.expectedVersion);

      const replacements = countOccurrences(current.content, oldString);
      if (replacements === 0) {
        throw new WorkspaceFileError("OLD_STRING_NOT_FOUND", `old_string not found in ${path}`);
      }
      if (!options.replaceAll && replacements > 1) {
        throw new WorkspaceFileError(
          "AMBIGUOUS_EDIT",
          `old_string matches ${replacements} locations in ${path}; ` +
            "provide more context or set replace_all=true.",
        );
      }

      const updated = options.replaceAll
        ? current.content.split(oldString).join(newString)
        : replaceFirst(current.content, oldString, newString);

      // Re-read after edit calculation so an external writer cannot silently
      // invalidate the receipt while this operation is preparing the payload.
      const latest = await readStableSnapshot(absolutePath);
      assertSameSnapshot(current, latest, path);

      await pathGuard.validate();
      let committedSnapshot: StableFileSnapshot | undefined;
      try {
        await writeTextFileAtomic(absolutePath, updated, {
          mode: current.mode & 0o777,
          temporaryDirectory: pathGuard.canonicalRoot,
          commitGuard: createAtomicCommitGuard({
            path,
            pathGuard,
            current,
            expectedContent: updated,
            onCommitted: (snapshot) => {
              committedSnapshot = snapshot;
            },
          }),
        });
      } catch (error) {
        if (error instanceof AtomicWriteConflictError && error.sideEffects === "none") {
          throw stalePathError(path, error.message);
        }
        throw error;
      }
      if (!committedSnapshot) {
        throw new Error(`Atomic edit committed without a verified receipt snapshot: ${path}`);
      }
      const receipt = this.recordReceipt(committedSnapshot);
      return {
        ...receipt,
        created: false,
        characterCount: updated.length,
        replacements: options.replaceAll ? replacements : 1,
      };
    });
  }

  clear(): void {
    this.receipts.clear();
    this.receiptSnapshots.clear();
    this.observedCoverage.clear();
  }

  private async resolveContainedPath(path: string): Promise<string> {
    return await resolveContainedWorkspacePath(this.workspaceRoot, path);
  }

  private assertMutationAllowed(
    absolutePath: string,
    current: StableFileSnapshot | undefined,
    expectedVersion: string | undefined,
  ): void {
    if (!current) {
      if (expectedVersion !== undefined) {
        throw new WorkspaceFileError(
          "INVALID_EXPECTED_VERSION",
          `File does not exist, but expected_version was provided: ` +
            `${this.relativePath(absolutePath)}`,
        );
      }
      return;
    }

    const receipt = this.receipts.get(absolutePath);
    const receiptSnapshot = this.receiptSnapshots.get(absolutePath);
    if (!receipt || !receiptSnapshot) {
      throw new WorkspaceFileError(
        "READ_REQUIRED",
        `Read ${this.relativePath(absolutePath)} in this session before overwriting or editing it.`,
      );
    }
    if (expectedVersion !== undefined && expectedVersion !== receipt.version) {
      throw new WorkspaceFileError(
        "INVALID_EXPECTED_VERSION",
        `expected_version does not match this session's read receipt for ` +
          `${this.relativePath(absolutePath)}.`,
      );
    }
    assertSameSnapshot(
      receiptSnapshot,
      current,
      this.relativePath(absolutePath),
      "File changed after it was read",
    );
  }

  private recordReceipt(snapshot: StableFileSnapshot): WorkspaceFileReceipt {
    const receipt = this.createReceipt(snapshot);
    this.receipts.set(snapshot.absolutePath, receipt);
    this.receiptSnapshots.set(snapshot.absolutePath, structuredClone(snapshot));
    return receipt;
  }

  private createReceipt(snapshot: StableFileSnapshot): WorkspaceFileReceipt {
    return {
      path: this.relativePath(snapshot.absolutePath),
      version: snapshot.version,
      mtimeMs: snapshot.mtimeMs,
      size: snapshot.size,
      encoding: "utf8" as const,
      newline: detectNewlineStyle(snapshot.content),
    };
  }

  private recordObservedWindow(snapshot: StableFileSnapshot, start: number, end: number): void {
    const existing = this.observedCoverage.get(snapshot.absolutePath);
    const coverage =
      existing?.version === snapshot.version ? existing : { version: snapshot.version, ranges: [] };
    if (existing?.version !== snapshot.version) {
      this.receipts.delete(snapshot.absolutePath);
      this.receiptSnapshots.delete(snapshot.absolutePath);
    }
    coverage.ranges = mergeCoverageRanges([...coverage.ranges, { start, end }]);
    this.observedCoverage.set(snapshot.absolutePath, coverage);
    if (
      coverage.ranges.length === 1 &&
      coverage.ranges[0]!.start === 0 &&
      coverage.ranges[0]!.end === snapshot.content.length
    ) {
      this.recordReceipt(snapshot);
    }
  }

  private relativePath(absolutePath: string): string {
    return relative(this.workspaceRoot, absolutePath).replace(/\\/g, "/") || ".";
  }
}
