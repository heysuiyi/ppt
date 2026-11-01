import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MessageBus } from "../app/main/agent/teammate/message-bus";
import { TeammateManager } from "../app/main/agent/teammate/spawn-teammate";

describe("teammate cold-start recovery", () => {
  it("turns a previous process teammate into a durable interruption message", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "teammate-recovery-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const statePath = bus.getTeammateStatePath();
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        teammates: [
          {
            name: "designer",
            role: "layout designer",
            status: "running",
            startedAt: Date.now() - 1_000,
            lastActiveAt: Date.now() - 500,
            prompt: "Design the deck",
          },
        ],
      }),
      "utf8",
    );

    const manager = new TeammateManager(bus);
    await manager.reconcileInterrupted();
    const inbox = await bus.readInbox("lead");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      from: "designer",
      type: "error",
      payload: { recoverable: true },
    });

    await new TeammateManager(bus).reconcileInterrupted();
    expect(await bus.readInbox("lead")).toHaveLength(0);
  });
});
