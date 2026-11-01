import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicWriteConflictError } from "@agent-harness/tools/atomic-files";
import { WorkspaceFileError } from "@agent-harness/tools/workspace-files";
import { afterEach, describe, expect, it } from "vitest";
import {
  recoverInterruptedReplacement,
  withAtomicFileTransaction,
  writeTextFileAtomic,
} from "../dist/internal/files/atomic.js";
import { createRecoveryFixture } from "./fixtures/atomic-v1";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-atomic-recovery-"));
  temporaryRoots.push(root);
  return root;
}

describe("private atomic replacement recovery windows", () => {
  it("restores a displaced old inode when the manifest proves target is missing", async () => {
    const root = await createWorkspace();
    const targetPath = join(root, "state.json");
    const transaction = await createRecoveryFixture(targetPath, root, "old state", "new state");

    await expect(recoverInterruptedReplacement(targetPath, root)).resolves.toBe(true);
    expect(await readFile(targetPath, "utf8")).toBe("old state");
    await expect(lstat(transaction.backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(transaction.manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves the original backup when an unknown external target wins", async () => {
    const root = await createWorkspace();
    const targetPath = join(root, "state.json");
    const transaction = await createRecoveryFixture(
      targetPath,
      root,
      "old state",
      "prepared state",
    );
    await writeFile(targetPath, "external winner", "utf8");

    const error = await recoverInterruptedReplacement(targetPath, root).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AtomicWriteConflictError);
    expect(error).toMatchObject({ sideEffects: "uncertain" });
    expect(await readFile(targetPath, "utf8")).toBe("external winner");
    expect(await readFile(transaction.backupPath, "utf8")).toBe("old state");
    expect(await lstat(transaction.manifestPath)).toBeDefined();
  });
  it("does not recover or delete a manifest owned by an active transaction", async () => {
    const root = await createWorkspace();
    const targetPath = join(root, "active.json");
    let releaseOwner!: () => void;
    const ownerGate = new Promise<void>((resolveGate) => {
      releaseOwner = resolveGate;
    });
    let ownerReady!: () => void;
    const ready = new Promise<void>((resolveReady) => {
      ownerReady = resolveReady;
    });
    let transaction!: { backupPath: string; manifestPath: string };
    const owner = withAtomicFileTransaction(targetPath, root, async () => {
      transaction = await createRecoveryFixture(
        targetPath,
        root,
        "owned old state",
        "owned new state",
      );
      ownerReady();
      await ownerGate;
    });
    await ready;

    let recoverySettled = false;
    const recovery = recoverInterruptedReplacement(targetPath, root).finally(() => {
      recoverySettled = true;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 75));
    expect(recoverySettled).toBe(false);
    expect(await readFile(transaction.backupPath, "utf8")).toBe("owned old state");
    expect(await lstat(transaction.manifestPath)).toBeDefined();

    releaseOwner();
    await owner;
    await expect(recovery).resolves.toBe(true);
    expect(await readFile(targetPath, "utf8")).toBe("owned old state");
  });
  it("removes a newly linked outside inode and reports uncertainty before rollback", async () => {
    const root = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const parent = join(root, "safe");
    const parked = join(root, "safe-parked");
    const targetPath = join(parent, "file.txt");
    await mkdir(parent);
    await writeFile(targetPath, "old state", "utf8");
    let pathValidation = 0;

    const error = await writeTextFileAtomic(targetPath, "new state", {
      temporaryDirectory: root,
      commitGuard: {
        expectedTargetExists: true,
        async validatePath() {
          pathValidation += 1;
          if (pathValidation === 3) {
            await rename(parent, parked);
            await symlink(outsideRoot, parent, process.platform === "win32" ? "junction" : "dir");
            return;
          }
          if (pathValidation >= 4) {
            throw new WorkspaceFileError("UNSAFE_FILE_TYPE", "test parent identity changed");
          }
        },
        async validateDisplaced(displacedPath) {
          expect(displacedPath).toBeDefined();
          expect(await readFile(displacedPath!, "utf8")).toBe("old state");
        },
        async validateCommitted() {
          throw new WorkspaceFileError("UNSAFE_FILE_TYPE", "test post-link path validation failed");
        },
      },
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AtomicWriteConflictError);
    expect(error).toMatchObject({ sideEffects: "uncertain" });
    await expect(lstat(join(outsideRoot, "file.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).some((name) => name.includes(".atomic-old."))).toBe(true);
  });
});
