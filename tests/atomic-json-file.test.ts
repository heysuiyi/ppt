import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonFileAtomic } from "@agent-harness/tools/atomic-files";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("atomic JSON persistence", () => {
  it("replaces an existing JSON file on Windows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-ppt-atomic-json-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "state.json");

    await writeJsonFileAtomic(filePath, { status: "pending" });
    await writeJsonFileAtomic(filePath, { status: "in_progress" });

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      status: "in_progress",
    });
  });
});
