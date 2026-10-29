import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "@main/session-store";
import { expect, it } from "vitest";

it("preserves a committed presentation when its workspace mirror fails and accepts the next write", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppt-storage-mirror-"));
  const store = new FileSessionStore(join(root, "app.sqlite"), join(root, "projects"));
  try {
    await store.initialize();
    const created = await store.createSession({ title: "Before commit" });
    const snapshot = created.activeSession!;
    const sessionId = snapshot.session.id;
    const mirrorPath = join(snapshot.project!.rootPath, "deck", "snapshot.json");
    await rm(mirrorPath, { force: true });
    await mkdir(mirrorPath);

    const first = {
      ...snapshot.presentation,
      title: "Committed despite mirror failure",
      revision: snapshot.presentation.revision + 1,
    };
    await store.commitPresentationTransaction({
      sessionId,
      presentation: first,
      commitLifecycle: () => {
        store.conversationDatabase.beginRun({ runId: "committed-run", sessionId });
      },
    });

    expect(store.getSession(sessionId).presentation).toEqual(first);
    expect(
      store.conversationDatabase.loadState().sessions.find((item) => item.session.id === sessionId)
        ?.presentation,
    ).toEqual(first);
    expect(store.conversationDatabase.storage.runs.findById("committed-run")).toMatchObject({
      sessionId,
      status: "running",
    });

    await rm(mirrorPath, { recursive: true });
    const second = { ...first, title: "Next write committed", revision: first.revision + 1 };
    await store.commitPresentationTransaction({
      sessionId,
      presentation: second,
      commitLifecycle: () => {
        store.conversationDatabase.finishRun({ runId: "committed-run", status: "completed" });
      },
    });

    expect(store.getSession(sessionId).presentation).toEqual(second);
    expect(
      store.conversationDatabase.loadState().sessions.find((item) => item.session.id === sessionId)
        ?.presentation,
    ).toEqual(second);
    expect(JSON.parse(await readFile(mirrorPath, "utf8"))).toEqual(second);
    expect(store.conversationDatabase.storage.runs.findById("committed-run")).toMatchObject({
      status: "completed",
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
