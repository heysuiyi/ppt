import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TokenUsageStore } from "../app/main/token-usage-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createStore(): Promise<{ store: TokenUsageStore; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "agent-ppt-token-usage-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "token-usage.json");
  const store = new TokenUsageStore(filePath);
  await store.initialize();
  return { store, filePath };
}

describe("TokenUsageStore", () => {
  it("persists provider-reported usage and derives peak and streak statistics", async () => {
    const { store, filePath } = await createStore();
    await store.recordModelUsage({
      provider: "openai",
      model: "model-a",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      recordedAt: new Date(2026, 6, 8, 12),
    });
    await store.recordModelUsage({
      provider: "anthropic",
      model: "model-b",
      inputTokens: 200,
      outputTokens: 70,
      cachedInputTokens: 30,
      totalTokens: 300,
      recordedAt: new Date(2026, 6, 9, 12),
    });
    await store.recordModelUsage({
      provider: "openai",
      model: "model-a",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
      recordedAt: new Date(2026, 6, 10, 12),
    });
    await store.recordTask(7_200_000, new Date(2026, 6, 10, 13));
    await store.recordTask(2_000, new Date(2026, 6, 10, 14), "failed");

    const stats = store.getStats(new Date(2026, 6, 11, 12));
    expect(stats).toMatchObject({
      totalTokens: 550,
      peakTokens: 300,
      requestCount: 3,
      taskCount: 2,
      completedTaskCount: 1,
      failedTaskCount: 1,
      averageTaskDurationMs: 3_601_000,
      longestTaskDurationMs: 7_200_000,
      currentStreakDays: 3,
      longestStreakDays: 3,
    });
    expect(stats.days).toHaveLength(3);
    expect(stats.days[1]).toMatchObject({
      totalTokens: 300,
      cachedInputTokens: 30,
      requestCount: 1,
    });
    expect(stats.models).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        model: "model-b",
        totalTokens: 300,
      }),
      expect.objectContaining({
        provider: "openai",
        model: "model-a",
        totalTokens: 250,
      }),
    ]);

    const reloaded = new TokenUsageStore(filePath);
    await reloaded.initialize();
    expect(reloaded.getStats(new Date(2026, 6, 11, 12)).totalTokens).toBe(550);
  });

  it("returns a zero current streak when the latest activity is older than yesterday", async () => {
    const { store } = await createStore();
    await store.recordModelUsage({
      provider: "openai",
      model: "model-a",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      recordedAt: new Date(2026, 5, 1, 12),
    });

    expect(store.getStats(new Date(2026, 5, 4, 12))).toMatchObject({
      currentStreakDays: 0,
      longestStreakDays: 1,
    });
  });

  it("migrates version 1 totals without inventing model attribution or task outcomes", async () => {
    const { filePath } = await createStore();
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        firstRecordedAt: "2026-07-01T00:00:00.000Z",
        lastRecordedAt: "2026-07-01T00:00:01.000Z",
        days: [
          {
            date: "2026-07-01",
            inputTokens: 90,
            outputTokens: 10,
            totalTokens: 100,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0,
            requestCount: 1,
            taskCount: 1,
            longestTaskDurationMs: 500,
          },
        ],
      }),
    );

    const migrated = new TokenUsageStore(filePath);
    await migrated.initialize();
    expect(migrated.getStats(new Date(2026, 6, 1))).toMatchObject({
      totalTokens: 100,
      taskCount: 1,
      completedTaskCount: 0,
      failedTaskCount: 0,
      averageTaskDurationMs: 0,
      models: [],
    });
    expect(JSON.parse(await readFile(filePath, "utf8")).version).toBe(3);
  });

  it("keeps identical provider model names separate by configuration ID", async () => {
    const { store } = await createStore();
    await store.recordModelUsage({
      configurationId: "official-model",
      provider: "openai",
      model: "shared-name",
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      recordedAt: new Date(2026, 6, 10, 12),
    });
    await store.recordModelUsage({
      configurationId: "proxy-model",
      provider: "openai",
      model: "shared-name",
      inputTokens: 200,
      outputTokens: 20,
      totalTokens: 220,
      recordedAt: new Date(2026, 6, 10, 13),
    });

    expect(store.getStats(new Date(2026, 6, 10)).models).toEqual([
      expect.objectContaining({ configurationId: "proxy-model", totalTokens: 220 }),
      expect.objectContaining({ configurationId: "official-model", totalTokens: 110 }),
    ]);
  });

  it("migrates version 2 model usage without inventing configuration IDs", async () => {
    const { filePath } = await createStore();
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        days: [
          {
            date: "2026-07-01",
            inputTokens: 90,
            outputTokens: 10,
            totalTokens: 100,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0,
            requestCount: 1,
            taskCount: 0,
            completedTaskCount: 0,
            failedTaskCount: 0,
            interruptedTaskCount: 0,
            totalTaskDurationMs: 0,
            durationSampleCount: 0,
            longestTaskDurationMs: 0,
            models: [
              {
                provider: "openai",
                model: "legacy-model",
                inputTokens: 90,
                outputTokens: 10,
                totalTokens: 100,
                cachedInputTokens: 0,
                cacheCreationInputTokens: 0,
                requestCount: 1,
              },
            ],
          },
        ],
      }),
    );

    const migrated = new TokenUsageStore(filePath);
    await migrated.initialize();
    expect(migrated.getStats().models[0]).toMatchObject({
      provider: "openai",
      model: "legacy-model",
      totalTokens: 100,
    });
    expect(migrated.getStats().models[0]).not.toHaveProperty("configurationId");
    expect(JSON.parse(await readFile(filePath, "utf8")).version).toBe(3);
  });
});
