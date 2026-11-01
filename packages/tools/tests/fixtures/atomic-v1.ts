import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { basename, dirname as dirnamePath, join, resolve } from "node:path";

// Deliberately writes the pre-package v1 disk format without implementation helpers.
export async function createRecoveryFixture(
  targetPath: string,
  transactionDirectory: string,
  oldContent: string,
  newContent: string,
): Promise<{ backupPath: string; manifestPath: string }> {
  let canonicalTarget = resolve(targetPath);
  try {
    canonicalTarget = realpathSync.native(canonicalTarget);
  } catch {
    try {
      canonicalTarget = join(
        realpathSync.native(dirnamePath(canonicalTarget)),
        basename(targetPath),
      );
    } catch {
      // Keep resolve() form when the parent cannot be realpath'd.
    }
  }
  const targetKey = createHash("sha256").update(canonicalTarget, "utf8").digest("hex").slice(0, 20);
  const targetName = basename(canonicalTarget);
  const backupName = `${targetName}.${targetKey}.atomic-old.test`;
  const backupPath = join(transactionDirectory, backupName);
  const preparedPath = join(transactionDirectory, `.${targetName}.prepared.tmp`);
  const manifestPath = join(
    transactionDirectory,
    `.${targetName}.${targetKey}.atomic-replace.json`,
  );
  await writeFile(backupPath, oldContent, "utf8");
  await writeFile(preparedPath, newContent, "utf8");
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      version: 1,
      targetPath: canonicalTarget,
      targetName,
      backupName,
      oldFingerprint: await testFingerprint(backupPath),
      newFingerprint: await testFingerprint(preparedPath),
    })}\n`,
    "utf8",
  );
  return { backupPath, manifestPath };
}

async function testFingerprint(path: string): Promise<{
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  sha256: string;
}> {
  const [bytes, stats] = await Promise.all([readFile(path), lstat(path)]);
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
