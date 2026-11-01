import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync, type Stats } from "node:fs";
import { link, lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { AtomicWriteConflictError } from "./atomic-errors.js";

const REPLACEMENT_MANIFEST_SUFFIX = ".atomic-replace.json";
const REPLACEMENT_BACKUP_MARKER = ".atomic-old.";

export interface AtomicIoLimits {
  maxFileBytes: number;
  maxScanEntries: number;
}

const atomicIoLimits = new AsyncLocalStorage<AtomicIoLimits | undefined>();

type LockRelease = () => Promise<void>;
type ProperLockfile = {
  lock(
    file: string,
    options?: {
      realpath?: boolean;
      stale?: number;
      retries?:
        | number
        | {
            retries?: number;
            factor?: number;
            minTimeout?: number;
            maxTimeout?: number;
          };
    },
  ): Promise<LockRelease>;
};
const lockfile = createRequire(import.meta.url)("proper-lockfile") as ProperLockfile;

export interface AtomicFileIdentity {
  dev: number;
  ino: number;
}

interface AtomicFileFingerprint extends AtomicFileIdentity {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  sha256: string;
}

interface ReplacementManifest {
  version: 1;
  targetPath: string;
  targetName: string;
  backupName: string;
  oldFingerprint: AtomicFileFingerprint | null;
  newFingerprint: AtomicFileFingerprint;
}

interface ReplacementTransaction {
  manifestPath: string;
  backupPath: string;
  manifest: ReplacementManifest;
}

interface StableBinaryFile {
  bytes: Buffer;
  stats: Stats;
}

/**
 * Optional compare-and-commit boundary used by workspace file mutations.
 * The current destination is displaced first, then validated as the exact
 * snapshot the caller read before the new inode is linked into place.
 */
export interface AtomicCommitGuard {
  expectedTargetExists: boolean;
  validatePath: () => Promise<void>;
  validateDisplaced: (displacedPath: string | undefined) => Promise<void>;
  validateCommitted?: (committedPath: string) => Promise<void>;
  beforePublish?: () => void;
  onPublished?: () => void;
}

export interface AtomicTextWriteOptions {
  mode?: number;
  /**
   * A stable directory for temporary data. Workspace callers use their
   * canonical root so swapping a nested parent cannot redirect temp creation.
   */
  temporaryDirectory?: string;
  commitGuard?: AtomicCommitGuard;
  ioLimits?: AtomicIoLimits;
}

type LockedRecovery = (validatePath?: () => Promise<void>) => Promise<boolean>;

/**
 * Serialize recovery and the caller's complete read/replace transaction across
 * processes. The callback receives the only unlocked recovery entry point, so
 * callers cannot accidentally release the lease between recovery and I/O.
 */
export async function withAtomicFileTransaction<T>(
  filePath: string,
  transactionDirectory: string,
  operation: (recover: LockedRecovery) => Promise<T>,
  ioLimits?: AtomicIoLimits,
): Promise<T> {
  await mkdir(transactionDirectory, { recursive: true });
  const lockTarget = replacementManifestPath(filePath, transactionDirectory);
  const release = await lockfile.lock(lockTarget, {
    realpath: false,
    stale: 30_000,
    retries: {
      retries: 600,
      factor: 1,
      minTimeout: 10,
      maxTimeout: 100,
    },
  });
  try {
    return await atomicIoLimits.run(
      ioLimits ?? atomicIoLimits.getStore(),
      async () =>
        await operation(
          async (validatePath) =>
            await recoverInterruptedReplacementUnlocked(
              filePath,
              transactionDirectory,
              validatePath,
            ),
        ),
    );
  } finally {
    await release();
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  return await withAtomicFileTransaction(filePath, dirname(filePath), async (recover) => {
    await recover();
    let primaryText: string;
    try {
      primaryText = (await readRegularFile(filePath)).bytes.toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    try {
      return JSON.parse(primaryText) as T;
    } catch (parseError) {
      try {
        const backup = (await readRegularFile(`${filePath}.bak`)).bytes.toString("utf8");
        const parsed = JSON.parse(backup) as T;
        await writeTextFileAtomicLocked(filePath, backup, dirname(filePath), {});
        return parsed;
      } catch {
        throw parseError;
      }
    }
  });
}

/**
 * Crash-safe single-file replacement. The temporary file is flushed before it
 * is committed, and the containing directory is flushed where the platform
 * supports directory handles.
 */
export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  try {
    const current = (await readRegularFile(filePath)).bytes.toString("utf8");
    JSON.parse(current);
    await writeTextFileAtomic(`${filePath}.bak`, current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextFileAtomic(
  filePath: string,
  payload: string,
  options: AtomicTextWriteOptions = {},
): Promise<void> {
  const targetDirectory = dirname(filePath);
  await mkdir(targetDirectory, { recursive: true });
  const temporaryDirectory = options.temporaryDirectory ?? targetDirectory;
  await mkdir(temporaryDirectory, { recursive: true });
  await withAtomicFileTransaction(
    filePath,
    temporaryDirectory,
    async (recover) => {
      const recoveredInterruptedCommit = await recover(options.commitGuard?.validatePath);
      if (options.commitGuard && recoveredInterruptedCommit) {
        throw new AtomicWriteConflictError(
          "Recovered an interrupted replacement before this guarded write; re-read before retrying.",
          undefined,
          "uncertain",
        );
      }
      await writeTextFileAtomicLocked(filePath, payload, temporaryDirectory, options);
    },
    options.ioLimits,
  );
}

async function writeTextFileAtomicLocked(
  filePath: string,
  payload: string,
  temporaryDirectory: string,
  options: AtomicTextWriteOptions,
): Promise<void> {
  const temporaryPath = join(
    temporaryDirectory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(payload, "utf8");
    if (options.mode !== undefined) {
      await handle.chmod(options.mode);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (options.commitGuard) {
      await guardedReplace(temporaryPath, filePath, temporaryDirectory, options.commitGuard);
    } else {
      await renameReplacingExisting(temporaryPath, filePath, temporaryDirectory);
    }
    await syncDirectory(dirname(filePath));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Recover only when the durable manifest proves which inode is old and which
 * inode is the prepared replacement. An unknown target is an external winner
 * or corruption: keep the backup and surface an explicit uncertain outcome.
 */
export async function recoverInterruptedReplacement(
  filePath: string,
  transactionDirectory = dirname(filePath),
  validatePath?: () => Promise<void>,
): Promise<boolean> {
  return await withAtomicFileTransaction(
    filePath,
    transactionDirectory,
    async (recover) => await recover(validatePath),
  );
}

async function recoverInterruptedReplacementUnlocked(
  filePath: string,
  transactionDirectory: string,
  validatePath?: () => Promise<void>,
): Promise<boolean> {
  const manifestPath = replacementManifestPath(filePath, transactionDirectory);
  if (!(await pathExists(manifestPath))) {
    const orphans = await findOrphanedBackups(filePath, transactionDirectory);
    if (orphans.length > 0) {
      throw recoveryAmbiguity(
        `Found replacement backup(s) without a durable manifest for ${filePath}: ` +
          `${orphans.join(", ")}`,
      );
    }
    return false;
  }

  const transaction = await readReplacementTransaction(
    filePath,
    transactionDirectory,
    manifestPath,
  );
  await validatePath?.();
  const { manifest, backupPath } = transaction;
  const targetFingerprint = await fingerprintIfPresent(filePath);
  const backupFingerprint = await fingerprintIfPresent(backupPath);

  if (backupFingerprint) {
    if (
      !manifest.oldFingerprint ||
      !fingerprintsMatch(manifest.oldFingerprint, backupFingerprint)
    ) {
      throw recoveryAmbiguity(
        `Replacement backup identity does not match its manifest for ${filePath}.`,
      );
    }

    if (!targetFingerprint) {
      await validatePath?.();
      try {
        await link(backupPath, filePath);
      } catch (error) {
        throw recoveryAmbiguity(
          `Could not exclusively restore the displaced file for ${filePath}.`,
          error,
        );
      }
      const restored = await fingerprintPath(filePath);
      if (!fingerprintsMatch(manifest.oldFingerprint, restored)) {
        throw recoveryAmbiguity(`Restored file identity could not be verified for ${filePath}.`);
      }
      if (validatePath) {
        try {
          await validatePath();
        } catch (error) {
          const current = await fingerprintIfPresent(filePath).catch(() => undefined);
          if (current && fingerprintsMatch(manifest.oldFingerprint, current)) {
            await unlink(filePath).catch(() => undefined);
          }
          throw recoveryAmbiguity(
            `Workspace path changed while restoring ${filePath}; recovery materials were preserved.`,
            error,
          );
        }
      }
      await removeRecoveredTransaction(transaction, true);
      return true;
    }

    if (fingerprintsMatch(manifest.newFingerprint, targetFingerprint)) {
      await validatePath?.();
      await removeRecoveredTransaction(transaction, true);
      return true;
    }
    if (manifest.oldFingerprint && fingerprintsMatch(manifest.oldFingerprint, targetFingerprint)) {
      await validatePath?.();
      await removeRecoveredTransaction(transaction, true);
      return true;
    }
    throw recoveryAmbiguity(
      `Target was replaced by an unknown inode while recovering ${filePath}; ` +
        "the original backup was preserved.",
    );
  }

  if (!targetFingerprint) {
    if (!manifest.oldFingerprint) {
      await validatePath?.();
      await removeRecoveredTransaction(transaction, false);
      return true;
    }
    throw recoveryAmbiguity(`Both the original backup and target are missing for ${filePath}.`);
  }

  if (
    fingerprintsMatch(manifest.newFingerprint, targetFingerprint) ||
    (manifest.oldFingerprint && fingerprintsMatch(manifest.oldFingerprint, targetFingerprint))
  ) {
    await validatePath?.();
    await removeRecoveredTransaction(transaction, false);
    return true;
  }

  throw recoveryAmbiguity(
    `Target identity is ambiguous while recovering ${filePath}; recovery metadata was preserved.`,
  );
}

async function guardedReplace(
  sourcePath: string,
  targetPath: string,
  transactionDirectory: string,
  guard: AtomicCommitGuard,
): Promise<void> {
  let transaction: ReplacementTransaction | undefined;
  let displaced = false;
  let installed = false;
  let commitFinalized = false;

  await guard.validatePath();
  const oldFingerprint = await fingerprintIfPresent(targetPath);
  if (guard.expectedTargetExists !== Boolean(oldFingerprint)) {
    throw new AtomicWriteConflictError(
      oldFingerprint
        ? "Destination was created before guarded replacement."
        : "Destination disappeared before guarded replacement.",
    );
  }
  const newFingerprint = await fingerprintPath(sourcePath);
  transaction = await createReplacementTransaction(
    targetPath,
    transactionDirectory,
    oldFingerprint,
    newFingerprint,
  );

  try {
    await guard.validatePath();
    guard.beforePublish?.();
    if (guard.expectedTargetExists) {
      await rename(targetPath, transaction.backupPath);
      displaced = true;
      await syncReplacementDirectories(transaction);
    } else if (await pathExists(targetPath)) {
      throw new AtomicWriteConflictError("Destination was created before guarded replacement.");
    }

    await guard.validateDisplaced(displaced ? transaction.backupPath : undefined);
    await guard.validatePath();
    guard.beforePublish?.();
    await link(sourcePath, targetPath);
    installed = true;
    guard.onPublished?.();
    const committedFingerprint = await fingerprintPath(targetPath);
    if (!fingerprintsMatch(newFingerprint, committedFingerprint)) {
      throw new AtomicWriteConflictError(
        "Committed destination identity differs from the prepared inode.",
      );
    }
    await unlink(sourcePath);
    // The prepared file and destination are hard links to the same inode.
    // Removing the preparation link can update ctime/link metadata on Windows,
    // so capture the reusable post-write receipt only after that unlink.
    await guard.validateCommitted?.(targetPath);
    await syncReplacementDirectories(transaction);

    if (displaced) {
      await unlink(transaction.backupPath);
      commitFinalized = true;
      await syncReplacementDirectories(transaction);
    } else {
      commitFinalized = true;
    }
    await unlink(transaction.manifestPath);
    await syncReplacementDirectories(transaction);
  } catch (error) {
    // New tools retain a published effect even if receipt verification or cleanup fails.
    if (installed && guard.onPublished) {
      throw new AtomicWriteConflictError(
        "Replacement was published but completion could not be verified.",
        error,
        "uncertain",
      );
    }
    if (commitFinalized) {
      throw new AtomicWriteConflictError(
        "Replacement committed, but durable cleanup could not be verified.",
        error,
        "uncertain",
      );
    }

    let rollbackComplete = false;
    try {
      rollbackComplete = await rollbackReplacement(
        targetPath,
        transaction,
        { displaced, installed },
        guard.validatePath,
      );
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Guarded replacement failed and could not be rolled back safely.",
      );
    }
    if (!rollbackComplete) {
      throw new AtomicWriteConflictError(
        "Destination changed during guarded replacement and rollback could not be completed.",
        error,
        "uncertain",
      );
    }
    if (
      error instanceof AtomicWriteConflictError ||
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw new AtomicWriteConflictError("Destination changed during guarded replacement.", error);
    }
    throw error;
  }
}

async function rollbackReplacement(
  targetPath: string,
  transaction: ReplacementTransaction,
  state: { displaced: boolean; installed: boolean },
  validatePath?: () => Promise<void>,
): Promise<boolean> {
  if (!state.displaced && !state.installed) {
    await unlink(transaction.manifestPath);
    await syncReplacementDirectories(transaction);
    return true;
  }

  const targetFingerprint = await fingerprintIfPresent(targetPath);
  if (state.installed && targetFingerprint) {
    if (fingerprintsMatch(transaction.manifest.newFingerprint, targetFingerprint)) {
      await unlink(targetPath);
    } else if (sameIdentity(transaction.manifest.newFingerprint, targetFingerprint)) {
      // An external writer changed the inode installed by this operation.
      // Preserve it and the old backup for explicit reconciliation.
      return false;
    } else if (state.displaced) {
      // An external writer installed another inode while the old inode was
      // displaced. Never overwrite or unlink that external winner.
      return false;
    }
  } else if (state.displaced && targetFingerprint) {
    return false;
  }

  if (validatePath) {
    try {
      await validatePath();
    } catch {
      // The newly linked inode has already been removed when it was ours.
      // Do not restore the displaced inode through a parent that may now point
      // outside the workspace; preserve backup + manifest for reconciliation.
      return false;
    }
  }

  if (state.displaced) {
    const backupFingerprint = await fingerprintIfPresent(transaction.backupPath);
    if (!backupFingerprint || (await pathExists(targetPath))) {
      return false;
    }
    try {
      await link(transaction.backupPath, targetPath);
    } catch {
      return false;
    }
    const restored = await fingerprintPath(targetPath);
    if (!fingerprintsMatch(backupFingerprint, restored)) return false;
    await unlink(transaction.backupPath);
  }

  await unlink(transaction.manifestPath);
  await syncReplacementDirectories(transaction);
  return true;
}

async function renameReplacingExisting(
  sourcePath: string,
  targetPath: string,
  transactionDirectory: string,
): Promise<void> {
  try {
    await rename(sourcePath, targetPath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
  }

  // Windows rename does not replace an existing destination. Record both
  // fingerprints durably before displacement so every crash point is
  // distinguishable from an external writer winning the destination.
  const oldFingerprint = await fingerprintIfPresent(targetPath);
  if (!oldFingerprint) {
    await rename(sourcePath, targetPath);
    return;
  }
  const transaction = await createReplacementTransaction(
    targetPath,
    transactionDirectory,
    oldFingerprint,
    await fingerprintPath(sourcePath),
  );
  let displaced = false;
  let installed = false;
  let commitFinalized = false;
  try {
    await rename(targetPath, transaction.backupPath);
    displaced = true;
    await syncReplacementDirectories(transaction);
    await link(sourcePath, targetPath);
    installed = true;
    const committed = await fingerprintPath(targetPath);
    if (!fingerprintsMatch(transaction.manifest.newFingerprint, committed)) {
      throw new AtomicWriteConflictError("Windows replacement inode could not be verified.");
    }
    await unlink(sourcePath);
    await syncReplacementDirectories(transaction);
    await unlink(transaction.backupPath);
    commitFinalized = true;
    await syncReplacementDirectories(transaction);
    await unlink(transaction.manifestPath);
    await syncReplacementDirectories(transaction);
  } catch (error) {
    if (commitFinalized) {
      throw new AtomicWriteConflictError(
        "Replacement committed, but Windows cleanup could not be verified.",
        error,
        "uncertain",
      );
    }
    let rollbackComplete = false;
    try {
      rollbackComplete = await rollbackReplacement(targetPath, transaction, {
        displaced,
        installed,
      });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Windows replacement failed and rollback could not be completed safely.",
      );
    }
    if (!rollbackComplete) {
      throw new AtomicWriteConflictError(
        "Windows replacement failed and rollback is incomplete.",
        error,
        "uncertain",
      );
    }
    throw error;
  }
}

async function createReplacementTransaction(
  targetPath: string,
  transactionDirectory: string,
  oldFingerprint: AtomicFileFingerprint | undefined,
  newFingerprint: AtomicFileFingerprint,
): Promise<ReplacementTransaction> {
  const canonicalTarget = canonicalizeAbsolutePath(targetPath);
  const targetKey = replacementTargetKey(targetPath);
  const backupName = `${basename(canonicalTarget)}.${targetKey}${REPLACEMENT_BACKUP_MARKER}${randomUUID()}`;
  const manifest: ReplacementManifest = {
    version: 1,
    targetPath: canonicalTarget,
    targetName: basename(canonicalTarget),
    backupName,
    oldFingerprint: oldFingerprint ?? null,
    newFingerprint,
  };
  const manifestPath = replacementManifestPath(targetPath, transactionDirectory);
  const handle = await open(manifestPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(transactionDirectory);
  return {
    manifestPath,
    backupPath: join(transactionDirectory, backupName),
    manifest,
  };
}

async function readReplacementTransaction(
  targetPath: string,
  transactionDirectory: string,
  manifestPath: string,
): Promise<ReplacementTransaction> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readRegularFile(manifestPath)).bytes.toString("utf8"));
  } catch (error) {
    throw recoveryAmbiguity(
      `Replacement manifest is invalid for ${targetPath}; it was preserved.`,
      error,
    );
  }
  if (!isReplacementManifest(parsed, targetPath)) {
    throw recoveryAmbiguity(`Replacement manifest does not match ${targetPath}; it was preserved.`);
  }
  return {
    manifestPath,
    backupPath: join(transactionDirectory, parsed.backupName),
    manifest: parsed,
  };
}

async function removeRecoveredTransaction(
  transaction: ReplacementTransaction,
  removeBackup: boolean,
): Promise<void> {
  const directoryPath = dirname(transaction.manifestPath);
  if (removeBackup) {
    await unlink(transaction.backupPath);
    await syncDirectory(directoryPath);
  }
  await unlink(transaction.manifestPath);
  await syncReplacementDirectories(transaction);
}

async function syncReplacementDirectories(transaction: ReplacementTransaction): Promise<void> {
  const targetDirectory = dirname(transaction.manifest.targetPath);
  const metadataDirectory = dirname(transaction.manifestPath);
  await syncDirectory(targetDirectory);
  if (metadataDirectory !== targetDirectory) {
    await syncDirectory(metadataDirectory);
  }
}

async function findOrphanedBackups(
  filePath: string,
  transactionDirectory: string,
): Promise<string[]> {
  const prefix = `${basename(canonicalizeAbsolutePath(filePath))}.${replacementTargetKey(filePath)}${REPLACEMENT_BACKUP_MARKER}`;
  try {
    const entries: string[] = [];
    const directory = await opendir(transactionDirectory);
    let scanned = 0;
    try {
      while (true) {
        const entry = await directory.read();
        if (!entry) break;
        if (++scanned > (atomicIoLimits.getStore()?.maxScanEntries ?? Infinity)) {
          throw recoveryAmbiguity("Atomic recovery directory exceeds its scan limit.");
        }
        if (entry.name.startsWith(prefix)) entries.push(entry.name);
      }
    } finally {
      await directory.close();
    }
    return entries.sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function replacementManifestPath(filePath: string, transactionDirectory: string): string {
  const canonicalPath = canonicalizeAbsolutePath(filePath);
  return join(
    transactionDirectory,
    `.${basename(canonicalPath)}.${replacementTargetKey(filePath)}${REPLACEMENT_MANIFEST_SUFFIX}`,
  );
}

/**
 * Hash the realpath form so Windows 8.3 short names and expanded long paths
 * address the same interrupted-replacement manifest / backup family.
 */
function replacementTargetKey(filePath: string): string {
  return createHash("sha256")
    .update(canonicalizeAbsolutePath(filePath), "utf8")
    .digest("hex")
    .slice(0, 20);
}

function canonicalizeAbsolutePath(filePath: string): string {
  const resolved = resolve(filePath);
  try {
    return realpathSync.native(resolved);
  } catch {
    try {
      return join(realpathSync.native(dirname(resolved)), basename(resolved));
    } catch {
      return resolved;
    }
  }
}

async function fingerprintIfPresent(filePath: string): Promise<AtomicFileFingerprint | undefined> {
  try {
    return await fingerprintPath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function fingerprintPath(filePath: string): Promise<AtomicFileFingerprint> {
  const { bytes, stats } = await readRegularFile(filePath);
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function readRegularFile(filePath: string): Promise<StableBinaryFile> {
  const lexical = await lstat(filePath);
  if (!lexical.isFile() || lexical.isSymbolicLink()) {
    throw new Error(`Atomic replacement supports regular files only: ${filePath}`);
  }
  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW),
    );
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error(`Atomic replacement supports regular files only: ${filePath}`);
    }
    const maxBytes = atomicIoLimits.getStore()?.maxFileBytes;
    if (maxBytes !== undefined && before.size > maxBytes) {
      throw new AtomicWriteConflictError("Atomic file exceeds its byte limit.");
    }
    const storage = Buffer.allocUnsafe(before.size + 1);
    let length = 0;
    while (length < storage.length) {
      const { bytesRead } = await handle.read(storage, length, storage.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const bytes = storage.subarray(0, length);
    const after = await handle.stat();
    const pathAfter = await lstat(filePath);
    if (
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      !sameIdentity(lexical, before) ||
      !sameIdentity(before, after) ||
      !sameIdentity(after, pathAfter) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.length !== after.size
    ) {
      throw new AtomicWriteConflictError(
        `File changed while computing an atomic fingerprint: ${filePath}`,
      );
    }
    return { bytes, stats: after };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function fingerprintsMatch(
  expected: AtomicFileFingerprint,
  actual: AtomicFileFingerprint,
): boolean {
  if (expected.size !== actual.size || expected.sha256 !== actual.sha256) {
    return false;
  }
  if (hasStableIdentity(expected) && hasStableIdentity(actual)) {
    return sameIdentity(expected, actual);
  }
  return expected.mtimeMs === actual.mtimeMs && expected.ctimeMs === actual.ctimeMs;
}

function hasStableIdentity(value: AtomicFileIdentity): boolean {
  return Number.isFinite(value.dev) && Number.isFinite(value.ino) && value.ino !== 0;
}

function sameIdentity(expected: AtomicFileIdentity, actual: AtomicFileIdentity): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino;
}

function isReplacementManifest(value: unknown, targetPath: string): value is ReplacementManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReplacementManifest>;
  const canonicalTarget = canonicalizeAbsolutePath(targetPath);
  const expectedPrefix = `${basename(canonicalTarget)}.${replacementTargetKey(targetPath)}${REPLACEMENT_BACKUP_MARKER}`;
  return (
    candidate.version === 1 &&
    typeof candidate.targetPath === "string" &&
    canonicalizeAbsolutePath(candidate.targetPath) === canonicalTarget &&
    candidate.targetName === basename(canonicalTarget) &&
    typeof candidate.backupName === "string" &&
    candidate.backupName.startsWith(expectedPrefix) &&
    !candidate.backupName.includes("/") &&
    !candidate.backupName.includes("\\") &&
    isFingerprint(candidate.newFingerprint) &&
    (candidate.oldFingerprint === null || isFingerprint(candidate.oldFingerprint))
  );
}

function isFingerprint(value: unknown): value is AtomicFileFingerprint {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AtomicFileFingerprint>;
  return (
    [candidate.dev, candidate.ino, candidate.size, candidate.mtimeMs, candidate.ctimeMs].every(
      (entry) => typeof entry === "number" && Number.isFinite(entry),
    ) &&
    typeof candidate.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(candidate.sha256)
  );
}

function recoveryAmbiguity(message: string, cause?: unknown): AtomicWriteConflictError {
  return new AtomicWriteConflictError(message, cause, "uncertain");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let directory;
  try {
    directory = await open(directoryPath, "r");
    await directory.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== "win32" &&
      code !== "EINVAL" &&
      code !== "ENOTSUP" &&
      code !== "EISDIR"
    ) {
      throw error;
    }
    // Windows and some filesystems do not support directory fsync handles.
  } finally {
    await directory?.close().catch(() => undefined);
  }
}
