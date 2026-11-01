import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopLogs,
  type DesktopLogs,
  LogSettingsPersistenceError,
} from "../app/main/logging/desktop-logs";
import { withLogContext } from "../app/main/logging/log-context";
import * as logHistory from "../app/main/logging/log-history";
import { inventoryHistory, localDateKey } from "../app/main/logging/log-history";
import { requestSummary } from "../app/main/logging/request-summary";

const roots: string[] = [];
const hosts: DesktopLogs[] = [];
const children: ChildProcess[] = [];
const environment = { NODE_ENV: "test", AGENT_LOG_LEVEL: "error", AGENT_LOG_FILE: "true" };

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  await Promise.all(hosts.splice(0).map((host) => host.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function rootDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "desktop-logs-"));
  roots.push(root);
  return root;
}

async function hostAt(directory: string, env = environment): Promise<DesktopLogs> {
  const host = await createDesktopLogs({ directory, environment: env });
  hosts.push(host);
  return host;
}

const childOwnerProgram = `
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';
import { createNodeLogs } from '@agent-harness/logs/node-logs';
const lockfile = createRequire(import.meta.url)('proper-lockfile');
const root = process.argv[1];
const ownerId = randomUUID();
const directory = join(root, 'desktop', ownerId);
await mkdir(directory, { recursive: true });
const release = await lockfile.lock(directory, { realpath: false, stale: Number.MAX_SAFE_INTEGER, update: 1000, retries: 0 });
const logs = await createNodeLogs({ directory, terminal: { enabled: false }, file: { enabled: true }, recent: { capacity: 300 } });
const instanceId = basename((await logs.getFileStatus()).directory);
await writeFile(join(directory, 'owner.json'), JSON.stringify({ schemaVersion: 1, kind: 'desktop-diagnostic-owner', ownerId, instanceId }));
logs.getLogger('child').error('child.alive');
process.on('message', async () => { await logs.close(); await release(); process.exit(0); });
process.send({ directory });
`;

async function activeChild(root: string): Promise<{ child: ChildProcess; directory: string }> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", childOwnerProgram, root], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const ready = await Promise.race([
    once(child, "message").then(([message]) => message as { directory: string }),
    once(child, "exit").then(([code]) => {
      throw new Error(`Log owner exited before ready (${code}): ${stderr}`);
    }),
  ]);
  return { child, directory: ready.directory };
}

describe("desktop logs host", () => {
  it("keeps bounded request summaries and explicit full-detail selection", () => {
    const request = `  ${"a".repeat(170)}\n next  `;
    const minimal = requestSummary(request, "minimal");
    expect(minimal.requestLength).toBe(request.length);
    expect(minimal.requestPreview).toHaveLength(160);
    expect(minimal.requestPreview.endsWith("...")).toBe(true);
    expect(minimal.requestPreview).not.toContain("\n");
    expect(minimal.requestFull).toBeUndefined();
    expect(requestSummary(request, "full").requestFull).toBe(request);
  });

  it("reads prior launches and deduplicates disk/recent identities without collapsing equal events", async () => {
    const root = await rootDirectory();
    const first = await hostAt(root);
    first.getLogger("first").error("same.event", { value: "first" });
    expect(await first.getRecentEntries()).toHaveLength(1);
    await first.close();
    const second = await hostAt(root);
    second.getLogger("second").error("same.event", { value: "second" });
    const entries = await second.getRecentEntries();
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
    expect(entries.map((entry) => entry.value).sort()).toEqual(["first", "second"]);
    expect((await second.getStatus()).fileCount).toBe(2);
  });

  it("uses authoritative async context and reserves display fields", async () => {
    const host = await hostAt(await rootDirectory());
    const logger = host.getLogger("module-name");
    await Promise.all([
      withLogContext({ runId: "run-a" }, async () => {
        await Promise.resolve();
        logger.error("context.a", {
          runId: "spoofed",
          module: "spoofed",
          timestamp: "bad",
          level: "debug",
          scope: "spoofed",
          event: "spoofed",
        });
      }),
      withLogContext({ runId: "run-b" }, async () => {
        await Promise.resolve();
        logger.error("context.b");
      }),
    ]);
    const entries = await host.getRecentEntries();
    expect(entries.find((entry) => entry.event === "context.a")).toMatchObject({
      runId: "run-a",
      module: "module-name",
      level: "error",
      scope: "agent",
    });
    expect(entries.find((entry) => entry.event === "context.b")).toMatchObject({ runId: "run-b" });
    expect(entries.every((entry) => Number.isFinite(Date.parse(entry.timestamp)))).toBe(true);
  });

  it("safely rereads legacy tails, tolerates corruption, and filters after the recent capacity", async () => {
    const root = await rootDirectory();
    const filename = join(root, `agent-${localDateKey(new Date())}.log`);
    const timestamp = new Date().toISOString();
    const rows = [JSON.stringify({ timestamp, level: "error", event: "outside.capacity" })];
    for (let index = 0; index < 300; index++)
      rows.push(
        JSON.stringify({
          timestamp,
          level: "info",
          event: "legacy.same",
          index,
          apiKey: "sk-super-secret-value",
          url: "https://user:password@example.com/path?token=hidden",
        }),
      );
    await writeFile(filename, `${"x".repeat(512 * 1024)}\n${rows.join("\n")}\n{broken-tail`);
    const host = await hostAt(root);
    expect(await host.getRecentEntries(300, "error")).toEqual([]);
    const entries = await host.getRecentEntries(300);
    expect(entries).toHaveLength(300);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(300);
    expect(JSON.stringify(entries)).not.toContain("super-secret-value");
    expect(JSON.stringify(entries)).not.toContain("password");
    expect(JSON.stringify(entries)).not.toContain("token=hidden");
  });

  it("clears current, prior, legacy and Gateway files then keeps existing loggers writable", async () => {
    const root = await rootDirectory();
    const previous = await hostAt(root);
    previous.getLogger("previous").error("previous.event");
    await previous.close();
    const host = await hostAt(root);
    const logger = host.getLogger("current");
    logger.error("before.clear");
    await writeFile(join(root, "agent.log.txt"), "legacy");
    const day = localDateKey(new Date());
    await mkdir(join(root, "gateway", day), { recursive: true });
    await writeFile(join(root, "gateway", day, `${randomUUID()}.json`), "{}");
    const result = await host.clear();
    expect(result).toEqual({ removedFiles: 4, skipped: [] });
    expect(await host.getRecentEntries()).toEqual([]);
    logger.error("after.clear");
    expect(await host.getRecentEntries()).toMatchObject([
      { event: "after.clear", module: "current" },
    ]);
  });

  it("retains only proven inactive dated artifacts across launches", async () => {
    const root = await rootDirectory();
    const previous = await hostAt(root);
    previous.getLogger("previous").error("previous.event");
    await previous.close();
    const inventory = await inventoryHistory(root);
    const file = inventory.files.find((item) => !item.legacy)!;
    const old = join(file.owner!, file.instanceId!, "diagnostic-2000-01-01.jsonl");
    await writeFile(old, "{}\n");
    await writeFile(join(root, "agent-2000-01-01.log"), "{}\n");
    const host = await hostAt(root);
    expect((await inventoryHistory(root)).files.map((item) => item.filename)).not.toContain(old);
    expect((await inventoryHistory(root)).files.some((item) => item.day === "2000-01-01")).toBe(
      false,
    );
    expect((await host.getRecentEntries()).some((entry) => entry.event === "previous.event")).toBe(
      true,
    );
  });

  it("governs previous instances on the first write after a UTC day switch without opening the panel", async () => {
    const start = new Date("2026-08-10T12:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const root = await rootDirectory();
    const previous = await hostAt(root);
    previous.getLogger("previous").error("previous.event");
    await previous.close();
    const file = (await inventoryHistory(root)).files.find((item) => !item.legacy)!;
    const boundary = join(file.owner!, file.instanceId!, "diagnostic-2026-08-04.jsonl");
    await writeFile(boundary, "{}\n");
    const host = await hostAt(root);
    expect((await inventoryHistory(root)).files.some((item) => item.filename === boundary)).toBe(
      true,
    );
    const logger = host.getLogger("current").child({ runId: "day-switch" });
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
    logger.error("next.day");
    await host.close();
    expect((await inventoryHistory(root)).files.some((item) => item.filename === boundary)).toBe(
      false,
    );
    expect(logger.isEnabled("error")).toBe(false);
    logger.error("after.close");
    await expect(host.clear()).rejects.toThrow("closing");
    const contents = await Promise.all(
      (await inventoryHistory(root)).files.map((item) => readFile(item.filename, "utf8")),
    );
    expect(contents.join("")).toContain("next.day");
    expect(contents.join("")).not.toContain("after.close");
  });

  it("preserves unknown artifacts, unproven owners, links and external sentinels", async () => {
    const root = await rootDirectory();
    const outside = await rootDirectory();
    const sentinel = join(outside, "sentinel.log");
    await writeFile(sentinel, "never delete");
    const host = await hostAt(root);
    await writeFile(join(root, "unknown.log"), "keep");
    const unproven = join(root, "desktop", randomUUID());
    await mkdir(unproven);
    await writeFile(join(unproven, "diagnostic-2000-01-01.jsonl"), "keep");
    await symlink(
      outside,
      join(root, "desktop", randomUUID()),
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await host.clear();
    expect(result.skipped.some((entry) => entry.includes("unknown.log"))).toBe(true);
    expect(result.skipped.some((entry) => entry.includes("ownership cannot be verified"))).toBe(
      true,
    );
    expect(await readFile(sentinel, "utf8")).toBe("never delete");
    expect(await readFile(join(root, "unknown.log"), "utf8")).toBe("keep");
    expect(await readdir(unproven)).toContain("diagnostic-2000-01-01.jsonl");
  });

  it("falls back field by field when historical settings contain invalid values", async () => {
    const root = await rootDirectory();
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify({ level: "verbose", fileEnabled: true, retentionDays: "old" }),
    );
    const host = await hostAt(root, {
      NODE_ENV: "test",
      AGENT_LOG_LEVEL: "warn",
      AGENT_LOG_FILE: "false",
    });
    expect(await host.getStatus()).toMatchObject({
      level: "warn",
      fileEnabled: true,
      retentionDays: 7,
    });
  });

  it("replaces malformed persisted settings after falling back to effective defaults", async () => {
    const root = await rootDirectory();
    await writeFile(join(root, "settings.json"), "{malformed");
    const host = await hostAt(root);
    expect(await host.getStatus()).toMatchObject({ level: "error", retentionDays: 7 });
    await expect(host.updateSettings({ level: "warn", retentionDays: 3 })).resolves.toEqual({
      level: "warn",
      fileEnabled: true,
      retentionDays: 3,
    });
    expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toEqual({
      level: "warn",
      fileEnabled: true,
      retentionDays: 3,
    });
    expect((await host.getStatus()).settingsPersistenceError).toBe(false);
  });

  it("rolls back its owned files, marker, containers and lock when initial retention fails", async () => {
    const root = await rootDirectory();
    vi.spyOn(logHistory, "inventoryHistory").mockRejectedValueOnce(
      new Error("initial retention failed"),
    );
    await expect(createDesktopLogs({ directory: root, environment })).rejects.toThrow(
      "initial retention failed",
    );
    expect(await readdir(join(root, "desktop"))).toEqual([]);
  });

  it("keeps ownership locked through failed-startup cleanup and preserves unknown files", async () => {
    const root = await rootDirectory();
    let failedOwner = "";
    const removeMarker = logHistory.removeDesktopOwnerMarker;
    vi.spyOn(logHistory, "inventoryHistory").mockImplementationOnce(async () => {
      const [owner] = (await readdir(join(root, "desktop"))).filter(
        (name) => !name.endsWith(".lock"),
      );
      failedOwner = join(root, "desktop", owner);
      await writeFile(join(failedOwner, "unknown.txt"), "preserve");
      throw new Error("initial retention failed");
    });
    vi.spyOn(logHistory, "removeDesktopOwnerMarker").mockImplementationOnce(async (owner) => {
      await expect(fs.promises.lstat(`${owner.directory}.lock`)).resolves.toBeDefined();
      await removeMarker(owner);
    });
    await expect(createDesktopLogs({ directory: root, environment })).rejects.toThrow(
      "initial retention failed",
    );
    expect(await readdir(failedOwner)).toEqual(["unknown.txt"]);
    expect(await readdir(join(root, "desktop"))).toEqual([basename(failedOwner)]);
  });

  it("skips a managed file removed between enumeration and lstat", async () => {
    const root = await rootDirectory();
    const filename = join(root, `agent-${localDateKey(new Date())}.log`);
    await writeFile(filename, "{}\n");
    const original = fs.promises.lstat;
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (target, options) => {
      if (target === filename) await fs.promises.unlink(filename);
      return original(target, options);
    }) as typeof fs.promises.lstat);
    syncBuiltinESMExports();
    const host = await hostAt(root);
    expect(await host.getRecentEntries()).toEqual([]);
    expect(fs.existsSync(filename)).toBe(false);
  });

  it("reports non-ENOENT inspection failures instead of treating them as absent history", async () => {
    const root = await rootDirectory();
    const filename = join(root, `agent-${localDateKey(new Date())}.log`);
    await writeFile(filename, "{}\n");
    const original = fs.promises.lstat;
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (target, options) => {
      if (target === filename)
        throw Object.assign(new Error("history inspection denied"), { code: "EACCES" });
      return original(target, options);
    }) as typeof fs.promises.lstat);
    syncBuiltinESMExports();
    await expect(createDesktopLogs({ directory: root, environment })).rejects.toThrow(
      "history inspection denied",
    );
    expect(await readdir(join(root, "desktop"))).toEqual([]);
  });

  it("loads valid persisted values over environment defaults and serializes snapshotted patches", async () => {
    const root = await rootDirectory();
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify({ level: "warn", fileEnabled: false, retentionDays: 900 }),
    );
    const host = await hostAt(root, {
      NODE_ENV: "test",
      AGENT_LOG_LEVEL: "debug",
      AGENT_LOG_FILE: "true",
    });
    expect(await host.getStatus()).toMatchObject({
      level: "warn",
      fileEnabled: false,
      retentionDays: 90,
    });
    const patch = { level: "info" as const };
    const first = host.updateSettings(patch);
    Object.assign(patch, { level: "error" });
    const second = host.updateSettings({ retentionDays: 3 });
    await Promise.all([first, second]);
    expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toEqual({
      level: "info",
      fileEnabled: false,
      retentionDays: 3,
    });
    await host.close();
    expect(await (await hostAt(root)).getStatus()).toMatchObject({
      level: "info",
      fileEnabled: false,
      retentionDays: 3,
      maintenanceSkipped: [],
    });
  });

  it("rejects invalid updates without mutation and reports effective settings after persistence fails", async () => {
    const root = await rootDirectory();
    const host = await hostAt(root);
    await expect(host.updateSettings({ level: "invalid" as "error" })).rejects.toThrow(
      "Invalid log level",
    );
    await mkdir(join(root, "settings.json"));
    await expect(host.updateSettings({ level: "warn", fileEnabled: false })).rejects.toBeInstanceOf(
      LogSettingsPersistenceError,
    );
    expect(await host.getStatus()).toMatchObject({
      level: "warn",
      fileEnabled: false,
      settingsPersistenceError: true,
    });
    await rm(join(root, "settings.json"), { recursive: true });
    await host.updateSettings({ retentionDays: 2 });
    expect(await host.getStatus()).toMatchObject({
      level: "warn",
      fileEnabled: false,
      retentionDays: 2,
      settingsPersistenceError: false,
    });
  });

  it("does not take over a live cross-process owner", async () => {
    const root = await rootDirectory();
    const active = await activeChild(root);
    const host = await hostAt(root);
    expect(
      (await host.getStatus()).maintenanceSkipped?.some((entry) =>
        entry.includes(active.directory),
      ),
    ).toBe(true);
    const result = await host.clear();
    expect(
      result.skipped.some(
        (entry) => entry.includes(active.directory) && entry.includes("active owner"),
      ),
    ).toBe(true);
    expect((await host.getStatus()).maintenanceSkipped).toEqual(result.skipped);
    expect((await host.getRecentEntries()).some((entry) => entry.event === "child.alive")).toBe(
      true,
    );
    const exited = once(active.child, "exit");
    active.child.send("close");
    await exited;
    expect((await host.clear()).skipped.some((entry) => entry.includes(active.directory))).toBe(
      false,
    );
    expect((await host.getStatus()).maintenanceSkipped).toEqual([]);
    expect(await host.getRecentEntries()).toEqual([]);
  });

  it("conservatively skips an abruptly abandoned ownership lock", async () => {
    const root = await rootDirectory();
    const active = await activeChild(root);
    const exited = once(active.child, "exit");
    active.child.kill("SIGKILL");
    await exited;
    const old = new Date("2000-01-01T00:00:00Z");
    await utimes(`${active.directory}.lock`, old, old);
    const host = await hostAt(root);
    const result = await host.clear();
    expect(result.skipped.some((entry) => entry.includes(active.directory))).toBe(true);
    expect((await host.getRecentEntries()).some((entry) => entry.event === "child.alive")).toBe(
      true,
    );
  });
});
