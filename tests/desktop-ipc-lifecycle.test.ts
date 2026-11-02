import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentConfiguration } from "@agent-harness/configuration/configuration";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopHarnessHost } from "../app/main/agent-host/desktop-host";
import { registerDesktopHarnessIpc } from "../app/main/agent-host/ipc";
import { attachDesktopHarnessWindowLifecycle } from "../app/main/agent-host/window-lifecycle";
import { createRecentWorkspaces } from "../app/main/agent-host/workspaces";
import type { HarnessDesktopEvent, HarnessReply, HarnessSnapshot } from "../app/shared/harness-ipc";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function fixture(choose?: () => Promise<string | undefined>) {
  const root = await mkdtemp(join(tmpdir(), "desktop-ipc-lifecycle-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const configuration = createAgentConfiguration({
    applicationDataRoot: root,
    defaultTemplateId: "none",
    environment: {},
    credentialProtection: {
      scheme: "windows-dpapi-current-user",
      inspect: async () => ({ state: "secure", backend: "windows-dpapi-current-user" }),
      encrypt: async (value) => Buffer.from(value),
      decrypt: async (value) => ({ result: Buffer.from(value).toString(), shouldReEncrypt: false }),
    },
  });
  await configuration.management.initialize();
  const dataRoot = join(root, "harness");
  const handlers = new Map<string, (event: IpcMainInvokeEvent, argument?: unknown) => unknown>();
  const senders = new Map<number, object>();
  const failures: Array<{ stage: string; webContentsId: number }> = [];
  const registration = registerDesktopHarnessIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
    },
    configuration,
    dataRoot,
    assertTrusted: (event) => {
      if (
        senders.get(event.sender.id) !== event.sender ||
        event.senderFrame !== event.sender.mainFrame ||
        !event.senderFrame.url.startsWith("file:///trusted/index.html")
      )
        throw new Error("B_IPC_PRIVATE_CREDENTIAL_SENTINEL");
    },
    chooseDirectory: async (_sender, assertCurrentDocument) => {
      assertCurrentDocument();
      const selected = await (choose ? choose() : Promise.resolve(workspace));
      assertCurrentDocument();
      return selected;
    },
  });
  cleanup.push(() => registration.close().catch(() => undefined));
  function open(id: number, commit = true) {
    let destroyed = false;
    const events: HarnessDesktopEvent[] = [];
    const contents = Object.assign(new EventEmitter(), {
      id,
      mainFrame: { url: "file:///trusted/index.html" },
      isDestroyed: () => destroyed,
      send: (_channel: string, event: HarnessDesktopEvent) => {
        events.push(structuredClone(event));
      },
    });
    const window = Object.assign(new EventEmitter(), {
      webContents: contents,
      isDestroyed: () => destroyed,
      close(): void {
        let prevented = false;
        window.emit("close", {
          preventDefault: () => {
            prevented = true;
          },
        });
        if (prevented || destroyed) return;
        destroyed = true;
        senders.delete(id);
        window.emit("closed");
      },
    });
    senders.set(id, contents);
    attachDesktopHarnessWindowLifecycle(
      window as unknown as BrowserWindow,
      registration,
      (stage, webContentsId) => {
        failures.push({ stage, webContentsId });
      },
    );
    if (commit) contents.emit("did-navigate", {}, contents.mainFrame.url, 200, "OK");
    return {
      id,
      contents,
      events,
      event: () =>
        ({ sender: contents, senderFrame: contents.mainFrame }) as unknown as IpcMainInvokeEvent,
      invoke<T = HarnessSnapshot>(method: string, argument?: unknown): Promise<HarnessReply<T>> {
        return Promise.resolve(
          handlers.get(`harness:${method}`)!(this.event(), argument),
        ) as Promise<HarnessReply<T>>;
      },
      commit() {
        // A same-URL reload need not give Main a distinct WebFrameMain object.
        contents.emit("did-navigate", {}, contents.mainFrame.url, 200, "OK");
      },
      loseRenderer() {
        contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
      },
      requestClose() {
        window.close();
      },
      close() {
        destroyed = true;
        senders.delete(id);
        window.emit("closed");
      },
    };
  }
  return { registration, open, workspace, dataRoot, failures, handlers };
}

function value<T>(reply: HarnessReply<T>): T {
  if (!reply.ok) throw new Error(JSON.stringify(reply.error));
  return reply.value;
}

function holdNextSnapshot() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const snapshot = DesktopHarnessHost.prototype.snapshot;
  vi.spyOn(DesktopHarnessHost.prototype, "snapshot").mockImplementationOnce(async function (
    this: DesktopHarnessHost,
  ) {
    const captured = await snapshot.call(this);
    entered.resolve();
    await release.promise;
    return captured;
  });
  cleanup.push(async () => {
    release.resolve();
  });
  return { entered: entered.promise, release: release.resolve };
}

describe("desktop IPC document ownership", () => {
  it("requires a committed trusted main document and rejects child frames, foreign windows and URLs", async () => {
    const f = await fixture();
    const first = f.open(1, false);
    expect(await first.invoke("snapshot")).toMatchObject({
      ok: false,
      error: { code: "HOST_CLOSED" },
    });
    first.commit();
    const original = value(await first.invoke("snapshot"));
    const invoke = f.handlers.get("harness:snapshot")!;
    const child = { ...first.event(), senderFrame: { url: first.contents.mainFrame.url } };
    const foreign = { ...first.event(), sender: { ...first.contents, id: 99 } };
    for (const event of [child, foreign]) {
      const reply = await invoke(event as IpcMainInvokeEvent);
      expect(reply).toMatchObject({ ok: false });
      expect(JSON.stringify(reply)).not.toContain("B_IPC_PRIVATE_CREDENTIAL_SENTINEL");
    }
    first.contents.mainFrame.url = "https://untrusted.example/";
    expect(await first.invoke("snapshot")).toMatchObject({ ok: false });
    first.contents.mainFrame.url = "file:///trusted/index.html";
    expect(value(await first.invoke("snapshot")).scopeId).toBe(original.scopeId);
    const second = f.open(2);
    expect(value(await second.invoke("snapshot")).scopeId).not.toBe(original.scopeId);
  });

  it("does not retire ownership for blocked/cancelled navigation or same-document hash routing", async () => {
    const f = await fixture();
    const first = f.open(1);
    const original = value(await first.invoke("chooseWorkspace"));
    first.contents.emit("will-navigate", { preventDefault() {} }, "https://external.example/");
    first.contents.emit("did-start-navigation", {}, "https://external.example/", false, true);
    first.contents.emit(
      "did-fail-provisional-load",
      {},
      -3,
      "ERR_ABORTED",
      "https://external.example/",
      true,
    );
    first.contents.mainFrame.url = "file:///trusted/index.html#settings";
    first.contents.emit("did-navigate-in-page", {}, first.contents.mainFrame.url, true);
    expect(value(await first.invoke("snapshot"))).toMatchObject({
      scopeId: original.scopeId,
      workspace: original.workspace,
    });
  });

  it("drains a same-window reload before a fresh scope, rejects the old reply and leaves other windows usable", async () => {
    const f = await fixture();
    const first = f.open(1);
    const other = f.open(2);
    const original = value(await first.invoke("snapshot"));
    const otherScope = value(await other.invoke("snapshot")).scopeId;
    const held = holdNextSnapshot();
    const oldReply = first.invoke("snapshot");
    await held.entered;
    first.commit();
    let replacement: HarnessReply<HarnessSnapshot> | undefined;
    const freshReply = first.invoke("snapshot").then((reply) => {
      replacement = reply;
      return reply;
    });
    expect(value(await other.invoke("snapshot")).scopeId).toBe(otherScope);
    expect(replacement).toBeUndefined();
    held.release();
    expect(await oldReply).toMatchObject({ ok: false, error: { code: "HOST_CLOSED" } });
    const fresh = value(await freshReply);
    expect(fresh.scopeId).not.toBe(original.scopeId);
    expect(fresh).toMatchObject({ workspace: null, activeRun: null, status: "idle" });
  });

  it("does not emit an old workspace publication into the replacement document", async () => {
    const f = await fixture();
    const first = f.open(1);
    const oldScope = value(await first.invoke("snapshot")).scopeId;
    const held = holdNextSnapshot();
    const selecting = first.invoke("chooseWorkspace");
    await held.entered;
    first.commit();
    const freshReply = first.invoke("snapshot");
    held.release();
    expect(await selecting).toMatchObject({ ok: false });
    const fresh = value(await freshReply);
    expect(fresh.scopeId).not.toBe(oldScope);
    expect(
      first.events.some(
        (event) => event.type === "snapshot" && event.snapshot.scopeId === oldScope,
      ),
    ).toBe(false);
    await first.invoke("chooseWorkspace");
    expect(first.events).toContainEqual(
      expect.objectContaining({
        type: "snapshot",
        snapshot: expect.objectContaining({ scopeId: fresh.scopeId }),
      }),
    );
  });

  it("invalidates renderer loss immediately and allows a new committed document in the same webContents", async () => {
    const f = await fixture();
    const first = f.open(1);
    const original = value(await first.invoke("chooseWorkspace"));
    first.loseRenderer();
    expect(await first.invoke("snapshot")).toMatchObject({
      ok: false,
      error: { code: "HOST_CLOSED" },
    });
    first.commit();
    const fresh = value(await first.invoke("snapshot"));
    expect(fresh.scopeId).not.toBe(original.scopeId);
    expect(fresh).toMatchObject({ workspace: null, activeRun: null, status: "idle" });
    expect(fresh.recentWorkspaces).toEqual([original.workspace]);
  });

  it("discards a picker crossing a reload before remembering a directory or creating the replacement workspace", async () => {
    const entered = Promise.withResolvers<void>();
    const selection = Promise.withResolvers<string | undefined>();
    const f = await fixture(async () => {
      entered.resolve();
      return selection.promise;
    });
    cleanup.push(async () => {
      selection.resolve(undefined);
    });
    const first = f.open(1);
    const other = f.open(2);
    const original = value(await first.invoke("snapshot"));
    const selecting = first.invoke("chooseWorkspace");
    await entered.promise;
    first.commit();
    let replacement: HarnessReply<HarnessSnapshot> | undefined;
    const freshReply = first.invoke("snapshot").then((reply) => {
      replacement = reply;
      return reply;
    });
    await other.invoke("snapshot");
    expect(replacement).toBeUndefined();
    selection.resolve(f.workspace);
    expect(await selecting).toMatchObject({ ok: false, error: { code: "HOST_CLOSED" } });
    const fresh = value(await freshReply);
    expect(fresh.scopeId).not.toBe(original.scopeId);
    expect(fresh).toMatchObject({ workspace: null, recentWorkspaces: [], activeRun: null });
    expect(await createRecentWorkspaces(f.dataRoot).list()).toEqual([]);
  });

  it("retains failed drain barriers, blocks replacement hosts and reports only safe failure stages", async () => {
    const f = await fixture();
    const first = f.open(1);
    await first.invoke("chooseWorkspace");
    const close = DesktopHarnessHost.prototype.close;
    vi.spyOn(DesktopHarnessHost.prototype, "close").mockImplementation(function (
      this: DesktopHarnessHost,
    ) {
      return close.call(this).then(() => {
        throw new Error("private SDK key and close detail");
      });
    });
    first.commit();
    const rejected = await first.invoke("snapshot");
    expect(rejected).toMatchObject({ ok: false, error: { code: "HOST_CLOSE_FAILED" } });
    expect(JSON.stringify(rejected)).not.toContain("private");
    expect(f.failures).toContainEqual({ stage: "document", webContentsId: 1 });
    first.commit();
    expect(await first.invoke("chooseWorkspace")).toMatchObject({
      ok: false,
      error: { code: "HOST_CLOSE_FAILED" },
    });
    const closing = f.registration.closeWindow(1);
    expect(f.registration.closeWindow(1)).toBe(closing);
    await expect(closing).rejects.toMatchObject({ code: "HOST_CLOSE_FAILED" });
    const registryClosing = f.registration.close();
    expect(f.registration.close()).toBe(registryClosing);
    await expect(registryClosing).rejects.toMatchObject({ code: "HOST_CLOSE_FAILED" });
  });

  it("keeps a native picker's parent alive until its result is drained, then closes without adopting it", async () => {
    const entered = Promise.withResolvers<void>();
    const selection = Promise.withResolvers<string | undefined>();
    const f = await fixture(async () => {
      entered.resolve();
      return selection.promise;
    });
    cleanup.push(async () => {
      selection.resolve(undefined);
    });
    const first = f.open(1);
    const other = f.open(2);
    const selecting = first.invoke("chooseWorkspace");
    await entered.promise;
    first.requestClose();
    first.requestClose();
    expect(first.contents.isDestroyed()).toBe(false);
    expect(await first.invoke("snapshot")).toMatchObject({ ok: false });
    expect(await other.invoke("snapshot")).toMatchObject({ ok: true });
    selection.resolve(f.workspace);
    expect(await selecting).toMatchObject({ ok: false, error: { code: "HOST_CLOSED" } });
    await f.registration.closeWindow(first.id);
    expect(first.contents.isDestroyed()).toBe(true);
    expect(await createRecentWorkspaces(f.dataRoot).list()).toEqual([]);
    expect(await other.invoke("snapshot")).toMatchObject({ ok: true });
  });

  it("drains a pending native picker on duplicate window/registry close without recording its late selection", async () => {
    const entered = Promise.withResolvers<void>();
    const selection = Promise.withResolvers<string | undefined>();
    const f = await fixture(async () => {
      entered.resolve();
      return selection.promise;
    });
    cleanup.push(async () => {
      selection.resolve(undefined);
    });
    const first = f.open(1);
    const other = f.open(2);
    const selecting = first.invoke("chooseWorkspace");
    await entered.promise;
    let settled = false;
    first.close();
    const closing = f.registration.closeWindow(1);
    expect(f.registration.closeWindow(1)).toBe(closing);
    void closing.then(() => {
      settled = true;
    });
    expect(value(await other.invoke("snapshot")).status).toBe("idle");
    expect(settled).toBe(false);
    const registryClosing = f.registration.close();
    expect(f.registration.close()).toBe(registryClosing);
    expect(await other.invoke("snapshot")).toMatchObject({ ok: false });
    selection.resolve(f.workspace);
    expect(await selecting).toMatchObject({ ok: false, error: { code: "HOST_CLOSED" } });
    await Promise.all([closing, registryClosing]);
    expect(await createRecentWorkspaces(f.dataRoot).list()).toEqual([]);
  });

  it("waits for non-transition IPC reads on final close and keeps a cancelled picker in the same scope", async () => {
    let cancel = false;
    let selectedPath: string | undefined;
    const f = await fixture(async () => (cancel ? undefined : selectedPath));
    selectedPath = f.workspace;
    const first = f.open(1);
    const original = value(await first.invoke("chooseWorkspace"));
    cancel = true;
    expect(value(await first.invoke("chooseWorkspace"))).toMatchObject({
      scopeId: original.scopeId,
      workspace: original.workspace,
    });
    const other = f.open(2);
    const held = holdNextSnapshot();
    const reading = first.invoke("snapshot");
    await held.entered;
    let settled = false;
    const closing = f.registration.closeWindow(1);
    void closing.then(() => {
      settled = true;
    });
    await other.invoke("snapshot");
    expect(settled).toBe(false);
    held.release();
    expect(await reading).toMatchObject({ ok: false, error: { code: "HOST_CLOSED" } });
    await closing;
    first.commit();
    expect(await first.invoke("snapshot")).toMatchObject({ ok: false });
  });
});
