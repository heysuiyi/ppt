import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AtomicCommitGuard } from "./atomic.js";
import { WorkspaceFileError } from "./workspace-file-contract.js";
import { assertWrittenContent, readStableSnapshot } from "./workspace-file-snapshot.js";
import {
  type StableFileSnapshot,
  stalePathError,
  type WorkspacePathGuard,
} from "./workspace-file-types.js";
import { assertContained, assertSafeDirectory } from "./workspace-path-guard.js";

const FILE_MUTATION_LOCKS = new Map<string, Promise<void>>();

export async function withFileMutationLock<T>(
  absolutePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = FILE_MUTATION_LOCKS.get(absolutePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const tail = previous.then(
    () => current,
    () => current,
  );
  FILE_MUTATION_LOCKS.set(absolutePath, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (FILE_MUTATION_LOCKS.get(absolutePath) === tail) {
      FILE_MUTATION_LOCKS.delete(absolutePath);
    }
  }
}

export function createAtomicCommitGuard(input: {
  path: string;
  pathGuard: WorkspacePathGuard;
  current: StableFileSnapshot | undefined;
  expectedContent: string;
  onCommitted: (snapshot: StableFileSnapshot) => void;
  maxBytes?: number;
  signal?: AbortSignal;
  onPublished?: () => void;
}): AtomicCommitGuard {
  return {
    expectedTargetExists: input.current !== undefined,
    beforePublish: () => input.signal?.throwIfAborted(),
    ...(input.onPublished ? { onPublished: input.onPublished } : {}),
    validatePath: input.pathGuard.validate,
    async validateDisplaced(displacedPath) {
      if (!input.current) {
        if (displacedPath) {
          throw stalePathError(
            input.path,
            "A destination appeared while a new file was being committed.",
          );
        }
        return;
      }
      if (!displacedPath) {
        throw stalePathError(
          input.path,
          "The destination disappeared while the write was being committed.",
        );
      }
      const displaced = await readStableSnapshot(displacedPath, input.maxBytes);
      assertSameDisplacedSnapshot(input.current, displaced, input.path);
    },
    async validateCommitted(committedPath) {
      await input.pathGuard.validate();
      const committed = await readStableSnapshot(committedPath, input.maxBytes);
      assertWrittenContent(committed, input.expectedContent, input.path);
      input.onCommitted(committed);
    },
  };
}

function assertSameDisplacedSnapshot(
  expected: StableFileSnapshot,
  actual: StableFileSnapshot,
  path: string,
): void {
  // Moving the inode to the transaction directory may legitimately update
  // ctime on Windows. Identity, content, mtime, size, and mode remain bound to
  // the caller's snapshot and still detect an external replacement or write.
  if (
    expected.version !== actual.version ||
    expected.mtimeMs !== actual.mtimeMs ||
    expected.size !== actual.size ||
    expected.mode !== actual.mode ||
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino
  ) {
    throw new WorkspaceFileError(
      "STALE_FILE",
      `File changed at the atomic commit boundary: ${path}. Read it again and retry.`,
    );
  }
}

export async function ensureSafeParentDirectory(
  workspaceRoot: string,
  absolutePath: string,
  originalPath: string,
): Promise<boolean> {
  const parentPath = dirname(absolutePath);
  const existedBefore = await workspacePathEntryExists(parentPath);
  await mkdir(parentPath, { recursive: true });
  try {
    const canonicalRoot = await realpath(resolve(workspaceRoot));
    const parentStats = await lstat(parentPath);
    assertSafeDirectory(parentStats, parentPath, originalPath);
    const canonicalParent = await realpath(parentPath);
    assertContained(canonicalRoot, canonicalParent, originalPath);
  } catch (error) {
    if (!existedBefore && error instanceof WorkspaceFileError) {
      throw new Error(
        `Parent directory creation may have changed the workspace before verification failed: ` +
          originalPath,
        { cause: error },
      );
    }
    throw error;
  }
  return !existedBefore;
}

export async function classifyWorkspaceErrorsAfterSideEffect<T>(
  sideEffectOccurred: boolean,
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (sideEffectOccurred && error instanceof WorkspaceFileError) {
      throw new Error(
        `Workspace directories were created before the file operation was rejected: ${path}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function workspacePathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
