import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { prepareWorkspaceRoot } from "@agent-harness/tools/tools";
import type { HarnessWorkspace } from "../../shared/harness-ipc";

/** 目录只能由系统选择器写入；renderer 之后只提交这里签发的身份。 */
export function createRecentWorkspaces(dataRoot: string): RecentWorkspaces {
  const file = join(dataRoot, "workspaces.json");
  let entries: HarnessWorkspace[] = [];
  let writing: Promise<unknown> = Promise.resolve();
  const ready = readFile(file, "utf8")
    .then((text) => {
      const saved: unknown = JSON.parse(text);
      if (!Array.isArray(saved)) throw new Error("Invalid workspace directory.");
      entries = saved
        .filter(
          (entry): entry is HarnessWorkspace =>
            entry !== null &&
            typeof entry === "object" &&
            typeof entry.path === "string" &&
            typeof entry.id === "string" &&
            typeof entry.label === "string",
        )
        .slice(0, 20);
    })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  // 查询仍会观察原始拒绝；尚无窗口请求时不产生游离的 Promise 拒绝。
  void ready.catch(() => undefined);
  return {
    async list(): Promise<readonly HarnessWorkspace[]> {
      await ready;
      await writing;
      return entries.map((entry) => ({ ...entry }));
    },
    async remember(path: string, signal?: AbortSignal): Promise<HarnessWorkspace> {
      signal?.throwIfAborted();
      await ready;
      signal?.throwIfAborted();
      const canonical = await prepareWorkspaceRoot(path);
      signal?.throwIfAborted();
      const entry: HarnessWorkspace = {
        id: createHash("sha256").update(canonical).digest("hex"),
        path: canonical,
        label: basename(canonical) || canonical,
      };
      const operation = writing
        .catch(() => undefined)
        .then(async () => {
          signal?.throwIfAborted();
          const next = [entry, ...entries.filter((item) => item.id !== entry.id)].slice(0, 20);
          await mkdir(dataRoot, { recursive: true });
          signal?.throwIfAborted();
          const temporary = `${file}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, JSON.stringify(next), { encoding: "utf8", flag: "wx" });
            // rename 是最近记录的提交点；失效选择不能提交预写文件。
            signal?.throwIfAborted();
            await rename(temporary, file);
            entries = next;
          } finally {
            await unlink(temporary).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            });
          }
        });
      writing = operation.catch((error: unknown) => {
        if (!signal?.aborted) throw error;
      });
      void writing.catch(() => undefined);
      await operation;
      return entry;
    },
  };
}

export interface RecentWorkspaces {
  list(): Promise<readonly HarnessWorkspace[]>;
  remember(path: string, signal?: AbortSignal): Promise<HarnessWorkspace>;
}
