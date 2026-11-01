import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { WorkspaceFileError, type WorkspaceFileReceipt } from "./workspace-file-contract.js";
import type { StableFileSnapshot } from "./workspace-file-types.js";
import { sameFileIdentity } from "./workspace-path-guard.js";

export interface SnapshotReadBudget {
  remaining: number;
}

export async function readSnapshotIfPresent(
  absolutePath: string,
  maxBytes?: number,
  signal?: AbortSignal,
): Promise<StableFileSnapshot | undefined> {
  try {
    return await readStableSnapshot(absolutePath, maxBytes, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readStableSnapshot(
  absolutePath: string,
  maxBytes?: number,
  signal?: AbortSignal,
  budget?: SnapshotReadBudget,
): Promise<StableFileSnapshot> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal?.throwIfAborted();
    const lexicalStats = await lstat(absolutePath);
    assertRegularFile(lexicalStats, absolutePath);
    assertFileSizeWithinLimit(lexicalStats.size, maxBytes, absolutePath);

    let handle;
    try {
      handle = await open(
        absolutePath,
        constants.O_RDONLY |
          (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW),
      );
      const before = await handle.stat();
      assertRegularFile(before, absolutePath);
      assertFileSizeWithinLimit(before.size, maxBytes, absolutePath);
      assertFileSizeWithinLimit(before.size, budget?.remaining, absolutePath);
      // One sentinel byte detects growth without an unbounded readFile allocation.
      const capacity = Math.min(before.size, maxBytes ?? before.size) + 1;
      const storage = Buffer.allocUnsafe(capacity);
      let length = 0;
      while (length < capacity) {
        signal?.throwIfAborted();
        const available = Math.min(capacity - length, budget?.remaining ?? capacity);
        if (available === 0) break;
        const { bytesRead } = await handle.read(storage, length, available, null);
        if (budget) budget.remaining -= bytesRead;
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      assertFileSizeWithinLimit(length, maxBytes, absolutePath);
      const bytes = storage.subarray(0, length);
      const after = await handle.stat();
      const pathAfter = await lstat(absolutePath);
      assertRegularFile(pathAfter, absolutePath);
      if (
        sameFileIdentity(lexicalStats, before) &&
        sameFileIdentity(before, after) &&
        sameFileIdentity(after, pathAfter) &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        before.size === after.size &&
        bytes.length === after.size
      ) {
        const content = decodeUtf8(bytes, absolutePath);
        return {
          absolutePath,
          content,
          version: contentVersion(content),
          mtimeMs: after.mtimeMs,
          ctimeMs: after.ctimeMs,
          size: after.size,
          mode: after.mode,
          dev: after.dev,
          ino: after.ino,
        };
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  throw new WorkspaceFileError(
    "STALE_FILE",
    `File changed while it was being read: ${absolutePath}`,
  );
}

export function assertFileSizeWithinLimit(
  size: number,
  maxBytes: number | undefined,
  path: string,
): void {
  if (maxBytes === undefined || size <= maxBytes) return;
  throw new WorkspaceFileError(
    "FILE_TOO_LARGE",
    `File exceeds the ${maxBytes}-byte read limit (${size} bytes): ${path}`,
  );
}

export function assertRegularFile(
  stats: { isSymbolicLink(): boolean; isFile(): boolean },
  absolutePath: string,
): void {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new WorkspaceFileError(
      "UNSAFE_FILE_TYPE",
      `Only regular text files are supported: ${absolutePath}`,
    );
  }
}

export function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new WorkspaceFileError(
      "INVALID_UTF8",
      `File is not valid UTF-8 text: ${path}. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function assertValidUtf8Text(content: string, path: string): void {
  if (Buffer.from(content, "utf8").toString("utf8") !== content) {
    throw new WorkspaceFileError(
      "INVALID_UTF8",
      `Content contains an invalid Unicode surrogate and cannot be written as UTF-8: ${path}`,
    );
  }
}

export function assertWrittenContent(
  snapshot: StableFileSnapshot,
  expectedContent: string,
  path: string,
): void {
  if (snapshot.content !== expectedContent) {
    throw new WorkspaceFileError(
      "STALE_FILE",
      `File changed before the committed content could be verified. ${path}. Read it again and retry.`,
    );
  }
}

export function assertSameSnapshot(
  expected: StableFileSnapshot,
  actual: StableFileSnapshot,
  path: string,
  action = "File changed while the edit was being prepared",
): void {
  if (
    expected.version !== actual.version ||
    expected.mtimeMs !== actual.mtimeMs ||
    expected.ctimeMs !== actual.ctimeMs ||
    expected.size !== actual.size ||
    expected.mode !== actual.mode ||
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino
  ) {
    throw new WorkspaceFileError("STALE_FILE", `${action}: ${path}. Read it again and retry.`);
  }
}

export function contentVersion(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export function detectNewlineStyle(content: string): WorkspaceFileReceipt["newline"] {
  const crlfCount = content.match(/\r\n/g)?.length ?? 0;
  const lfCount = (content.match(/\n/g)?.length ?? 0) - crlfCount;
  if (crlfCount > 0 && lfCount > 0) return "mixed";
  if (crlfCount > 0) return "crlf";
  if (lfCount > 0) return "lf";
  return "none";
}
