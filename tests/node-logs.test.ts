import fs, { closeSync, openSync, writeSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeLogs,
  type LogRecord,
  type NodeLogs,
  type NodeLogsOptions,
  type NodeLogsSettingsPatch,
} from "@agent-ppt/logs/node-logs";
import { afterEach, describe, expect, it, vi } from "vitest";

const directories: string[] = [];
const services: NodeLogs[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.useRealTimers();
  await Promise.all(services.splice(0).map((logs) => logs.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "node-logs-"));
  directories.push(directory);
  return directory;
}

async function service(overrides: Partial<NodeLogsOptions> = {}): Promise<NodeLogs> {
  const logs = await createNodeLogs({
    directory: await temporary(),
    terminal: { enabled: false },
    file: { enabled: false },
    ...overrides,
  });
  services.push(logs);
  return logs;
}

async function records(path: string): Promise<LogRecord[]> {
  const text = await readFile(path, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogRecord);
}

function date(value: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(value));
}

describe("Node logs", () => {
  it("does no file work while disabled and enables explicit file output later", async () => {
    date("2026-05-01T12:00:00.000Z");
    const root = join(await temporary(), "not-created");
    const logs = await service({ directory: root });
    const before = await logs.getFileStatus();
    expect(before).toMatchObject({ enabled: false, fileCount: 0, totalBytes: 0, failureCount: 0 });
    await expect(readdir(root)).rejects.toMatchObject({ code: "ENOENT" });
    logs.getLogger("test").info("memory.only");
    await logs.updateSettings({ file: { enabled: true, minimumLevel: "debug" } });
    logs.getLogger("test").debug("file.ready", { count: 3 });
    const status = await logs.getFileStatus();
    const written = await records(join(status.directory, "diagnostic-2026-05-01.jsonl"));
    expect(written.map((record) => record.event)).toEqual(["file.ready"]);
    expect(written[0]).toMatchObject({ timestamp: "2026-05-01T12:00:00.000Z", data: { count: 3 } });
    expect(status).toMatchObject({
      enabled: true,
      fileCount: 1,
      lastWrittenAt: written[0].timestamp,
    });
    expect(status.totalBytes).toBe(
      Buffer.byteLength(
        await readFile(join(status.directory, "diagnostic-2026-05-01.jsonl"), "utf8"),
      ),
    );
    await logs.close();
    expect(await logs.getFileStatus()).toEqual(status);
  });

  it("writes actual terminal bytes to stderr with a threshold independent from files", async () => {
    date("2026-05-01T12:00:00.000Z");
    const capture = join(await temporary(), "stderr.jsonl");
    const descriptor = openSync(capture, "w");
    const original = writeSync;
    const spy = vi
      .spyOn(fs, "writeSync")
      .mockImplementation(((fd: number, buffer: Uint8Array, offset?: number, length?: number) =>
        original(fd === 2 ? descriptor : fd, buffer, offset, length)) as typeof writeSync);
    syncBuiltinESMExports();
    try {
      const logs = await service({
        terminal: { enabled: true, minimumLevel: "warn" },
        file: { enabled: true, minimumLevel: "debug" },
      });
      const logger = logs.getLogger("thresholds");
      logger.debug("file.debug");
      logger.info("file.info");
      logger.warn("terminal.warn");
      await logs.close();
      expect((await records(capture)).map((record) => record.event)).toEqual(["terminal.warn"]);
      const status = await logs.getFileStatus();
      expect(await records(join(status.directory, "diagnostic-2026-05-01.jsonl"))).toEqual(
        expect.arrayContaining([expect.objectContaining({ event: "file.debug" })]),
      );
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
      closeSync(descriptor);
    }
  });

  it("wraps and resizes the recent ring while preserving newest records and query filtering", async () => {
    const logs = await service({ recent: { capacity: 3, minimumLevel: "debug" } });
    const logger = logs.getLogger("recent");
    logger.info("one");
    logger.warn("two");
    logger.debug("three");
    logger.error("four");
    expect(logs.getRecentEntries().map((record) => record.event)).toEqual(["four", "three", "two"]);
    expect(
      logs.getRecentEntries({ minimumLevel: "warn", limit: 2 }).map((record) => record.event),
    ).toEqual(["four", "two"]);
    await logs.updateSettings({ recent: { capacity: 2 } });
    expect(logs.getRecentEntries().map((record) => record.event)).toEqual(["four", "three"]);
    await logs.updateSettings({ recent: { capacity: 4 } });
    logger.info("five");
    logger.info("six");
    logger.info("seven");
    expect(logs.getRecentEntries().map((record) => record.event)).toEqual([
      "seven",
      "six",
      "five",
      "four",
    ]);
  });

  it("rejects invalid creation, query and patch values without changing effective settings", async () => {
    const root = await temporary();
    const valid: NodeLogsOptions = {
      directory: root,
      terminal: { enabled: false },
      file: { enabled: false },
    };
    const invalid = [
      { directory: "" },
      { terminal: {} },
      { terminal: { enabled: "false" } },
      { file: { enabled: false, retentionDays: 0 } },
      { file: { enabled: false, retentionDays: 91 } },
      { file: { enabled: false, minimumLevel: null } },
      { recent: { capacity: 1.5 } },
      { recent: { capacity: 0 } },
      { recent: { minimumLevel: "trace" } },
      { recent: { enabled: false } },
      { unexpected: true },
    ];
    for (const entry of invalid) {
      await expect(createNodeLogs({ ...valid, ...entry } as NodeLogsOptions)).rejects.toThrow();
    }
    const logs = await service();
    const original = logs.getSettings();
    for (const patch of [
      { file: { retentionDays: Number.NaN } },
      { file: { retentionDays: 91 } },
      { recent: { capacity: -1 } },
      { recent: { enabled: false } },
      { terminal: { minimumLevel: "trace" } },
      { file: { enabled: undefined } },
      { recent: null },
      { unknown: {} },
      { file: { capacity: 5 } },
    ]) {
      await expect(logs.updateSettings(patch as NodeLogsSettingsPatch)).rejects.toThrow();
      expect(logs.getSettings()).toEqual(original);
    }
    for (const query of [
      { limit: 0 },
      { limit: 301 },
      { limit: 1.5 },
      { minimumLevel: "trace" },
      null,
    ]) {
      expect(() => logs.getRecentEntries(query as never)).toThrow();
    }
  });

  it("isolates real append failures and allows subsequent records to recover", async () => {
    date("2026-05-01T12:00:00.000Z");
    const logs = await service({ file: { enabled: true } });
    const status = await logs.getFileStatus();
    const path = join(status.directory, "diagnostic-2026-05-01.jsonl");
    await rm(path);
    await mkdir(path);
    expect(() => logs.getLogger("failures").info("file.failed")).not.toThrow();
    expect(logs.getRecentEntries()[0].event).toBe("file.failed");
    expect(logs.getStatus().outputs.find((output) => output.id === "file")?.failureCount).toBe(1);
    expect(await logs.getFileStatus()).toMatchObject({
      enabled: true,
      fileCount: 0,
      failureCount: 1,
    });
    await rm(path, { recursive: true });
    logs.getLogger("failures").info("file.recovered");
    expect((await records(path)).map((record) => record.event)).toEqual(["file.recovered"]);
    expect((await logs.getFileStatus()).failureCount).toBe(1);
  });

  it("rotates in UTC and retains only canonical old files of its own instance", async () => {
    date("2026-05-01T23:59:59.000Z");
    const root = await temporary();
    const logs = await service({ directory: root, file: { enabled: true, retentionDays: 2 } });
    const own = (await logs.getFileStatus()).directory;
    const foreign = join(root, "older-instance");
    await mkdir(foreign);
    await writeFile(join(foreign, "diagnostic-2000-01-01.jsonl"), "foreign");
    await writeFile(join(root, "diagnostic-2000-01-01.jsonl"), "legacy");
    await writeFile(join(own, "diagnostic-2026-04-29.jsonl"), "expired");
    await writeFile(join(own, "diagnostic-2026-04-30.jsonl"), "within retention");
    await writeFile(join(own, "diagnostic-2026-02-30.jsonl"), "not a calendar date");
    await writeFile(join(own, "notes.txt"), "unknown");
    const target = join(root, "symlink-target");
    await mkdir(target);
    await writeFile(join(target, "sentinel"), "protected");
    await symlink(
      target,
      join(own, "diagnostic-2000-01-01.jsonl"),
      process.platform === "win32" ? "junction" : "dir",
    );
    logs.getLogger("rotation").info("before.midnight");
    vi.setSystemTime(new Date("2026-05-02T00:00:00.000Z"));
    logs.getLogger("rotation").info("after.midnight");
    const names = await readdir(own);
    expect(names).toContain("diagnostic-2026-05-01.jsonl");
    expect(names).toContain("diagnostic-2026-05-02.jsonl");
    expect(names).not.toContain("diagnostic-2026-04-29.jsonl");
    expect(names).not.toContain("diagnostic-2026-04-30.jsonl");
    expect((await records(join(own, "diagnostic-2026-05-02.jsonl")))[0].timestamp).toBe(
      "2026-05-02T00:00:00.000Z",
    );
    expect(await logs.clearFiles()).toBe(1);
    expect(await readdir(own)).toEqual(
      expect.arrayContaining([
        "diagnostic-2026-05-02.jsonl",
        "notes.txt",
        "diagnostic-2026-02-30.jsonl",
        "diagnostic-2000-01-01.jsonl",
      ]),
    );
    expect(await readFile(join(foreign, "diagnostic-2000-01-01.jsonl"), "utf8")).toBe("foreign");
    expect(await readFile(join(root, "diagnostic-2000-01-01.jsonl"), "utf8")).toBe("legacy");
    expect(await readFile(join(target, "sentinel"), "utf8")).toBe("protected");
    expect(logs.getRecentEntries().map((record) => record.event)).toEqual([
      "after.midnight",
      "before.midnight",
    ]);
    expect((await logs.getFileStatus()).fileCount).toBe(1);
  });

  it("rejects active-file and instance-directory links without traversing their targets", async () => {
    date("2026-05-01T12:00:00.000Z");
    const logs = await service({ file: { enabled: true } });
    const own = (await logs.getFileStatus()).directory;
    const target = await temporary();
    await writeFile(join(target, "sentinel"), "safe");
    const active = join(own, "diagnostic-2026-05-01.jsonl");
    await rm(active);
    await symlink(target, active, process.platform === "win32" ? "junction" : "dir");
    logs.getLogger("links").warn("active.link.rejected");
    expect((await logs.getFileStatus()).failureCount).toBe(1);
    const moved = `${own}-saved`;
    await rename(own, moved);
    await symlink(target, own, process.platform === "win32" ? "junction" : "dir");
    await expect(logs.clearFiles()).rejects.toThrow();
    await expect(logs.getFileStatus()).rejects.toThrow();
    expect(await readdir(target)).toEqual(["sentinel"]);
  });

  it("keeps settings unchanged when file preparation or retention fails", async () => {
    date("2026-05-01T12:00:00.000Z");
    const root = await temporary();
    const blocked = join(root, "not-a-directory");
    await writeFile(blocked, "host data");
    const logs = await service({ directory: blocked });
    const before = logs.getSettings();
    await expect(
      logs.updateSettings({ file: { enabled: true }, recent: { capacity: 8 } }),
    ).rejects.toThrow();
    expect(logs.getSettings()).toEqual(before);
    expect(await readFile(blocked, "utf8")).toBe("host data");
    const enabled = await service({ file: { enabled: true } });
    const own = (await enabled.getFileStatus()).directory;
    await rm(join(own, "diagnostic-2026-05-01.jsonl"));
    await mkdir(join(own, "diagnostic-2026-05-01.jsonl"));
    const previous = enabled.getSettings();
    await expect(
      enabled.updateSettings({ file: { retentionDays: 1 }, recent: { capacity: 5 } }),
    ).rejects.toThrow();
    expect(enabled.getSettings()).toEqual(previous);
    await rm(join(own, "diagnostic-2026-05-01.jsonl"), { recursive: true });
    const old = join(own, "diagnostic-2026-04-01.jsonl");
    await writeFile(old, "old data");
    const originalUnlink = fs.unlinkSync;
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (path === old) throw Object.assign(new Error("retention denied"), { code: "EACCES" });
      originalUnlink(path);
    });
    syncBuiltinESMExports();
    try {
      await expect(
        enabled.updateSettings({ file: { retentionDays: 1 }, recent: { capacity: 5 } }),
      ).rejects.toThrow();
      expect(enabled.getSettings()).toEqual(previous);
      expect(await readFile(old, "utf8")).toBe("old data");
    } finally {
      unlink.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("serializes queued patches, stops records immediately, and drains before one stable close", async () => {
    date("2026-05-01T12:00:00.000Z");
    const logs = await service();
    const logger = logs.getLogger("lifecycle");
    const patch = { file: { enabled: true, minimumLevel: "debug" as const } };
    const first = logs.updateSettings(patch);
    patch.file.enabled = false;
    const second = logs.updateSettings({ recent: { enabled: false }, file: { retentionDays: 1 } });
    const clearing = logs.clearFiles();
    const closing = logs.close();
    expect(logs.close()).toBe(closing);
    expect(logs.getStatus().state).toBe("closing");
    logger.info("too.late");
    expect(logs.getRecentEntries()).toHaveLength(0);
    await expect(logs.updateSettings({ terminal: { enabled: true } })).rejects.toThrow();
    await expect(logs.clearFiles()).rejects.toThrow();
    expect((await first).file.enabled).toBe(true);
    expect((await second).file).toMatchObject({
      enabled: true,
      minimumLevel: "debug",
      retentionDays: 1,
    });
    expect(await clearing).toBe(0);
    await closing;
    expect(logs.close()).toBe(closing);
    expect(logs.getStatus()).toMatchObject({ state: "closed", lateWriteCount: 1 });
    expect((await logs.getFileStatus()).enabled).toBe(true);
  });

  it("rolls back startup failures without deleting the shared root or its existing files", async () => {
    const root = await temporary();
    const sentinel = join(root, "sentinel");
    await writeFile(sentinel, "untouched");
    // 根路径本身为文件时初始化失败，不能将其删除或回退到另一目录。
    await expect(
      createNodeLogs({
        directory: sentinel,
        terminal: { enabled: false },
        file: { enabled: true },
      }),
    ).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
    expect(await readdir(root)).toEqual(["sentinel"]);
    const originalClose = fs.closeSync;
    const close = vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
      originalClose(descriptor);
      throw new Error("initial file preparation failed after opening");
    });
    syncBuiltinESMExports();
    try {
      await expect(
        createNodeLogs({
          directory: root,
          terminal: { enabled: false },
          file: { enabled: true },
        }),
      ).rejects.toThrow();
    } finally {
      close.mockRestore();
      syncBuiltinESMExports();
    }
    expect(await readdir(root)).toEqual(["sentinel"]);
  });
});
