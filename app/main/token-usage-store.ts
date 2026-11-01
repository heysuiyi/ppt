import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ProviderTokenUsage,
  TokenTaskOutcome,
  TokenUsageDay,
  TokenUsageModel,
  TokenUsageStats,
} from "@shared/token-usage";
import { z } from "zod";
import { writeJsonFileAtomic, writeTextFileAtomic } from "@agent-harness/tools/atomic-files";

const usageTotalsSchema = {
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  cacheCreationInputTokens: z.number().int().nonnegative().default(0),
};

const tokenUsageModelSchema = z.object({
  configurationId: z.string().optional(),
  provider: z.string(),
  model: z.string(),
  ...usageTotalsSchema,
  requestCount: z.number().int().nonnegative().default(0),
});

const legacyTokenUsageDaySchema = z.object({
  date: z.string(),
  ...usageTotalsSchema,
  requestCount: z.number().int().nonnegative().default(0),
  taskCount: z.number().int().nonnegative().default(0),
  longestTaskDurationMs: z.number().int().nonnegative().default(0),
});

const tokenUsageDaySchema = legacyTokenUsageDaySchema.extend({
  completedTaskCount: z.number().int().nonnegative().default(0),
  failedTaskCount: z.number().int().nonnegative().default(0),
  interruptedTaskCount: z.number().int().nonnegative().default(0),
  totalTaskDurationMs: z.number().int().nonnegative().default(0),
  durationSampleCount: z.number().int().nonnegative().default(0),
  models: z.array(tokenUsageModelSchema).default([]),
});

const legacyTokenUsageFileSchema = z.object({
  version: z.literal(1),
  firstRecordedAt: z.string().optional(),
  lastRecordedAt: z.string().optional(),
  days: z.array(legacyTokenUsageDaySchema),
});

const legacyVersionTwoTokenUsageFileSchema = z.object({
  version: z.literal(2),
  firstRecordedAt: z.string().optional(),
  lastRecordedAt: z.string().optional(),
  days: z.array(tokenUsageDaySchema),
});

const tokenUsageFileSchema = legacyVersionTwoTokenUsageFileSchema.extend({
  version: z.literal(3),
});

type TokenUsageFile = z.infer<typeof tokenUsageFileSchema>;

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateKeyDistance(from: string, to: string): number {
  const [fromYear, fromMonth, fromDay] = from.split("-").map(Number);
  const [toYear, toMonth, toDay] = to.split("-").map(Number);
  return Math.round(
    (Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) /
      86_400_000,
  );
}

function emptyDay(date: string): TokenUsageDay {
  return {
    date,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    requestCount: 0,
    taskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    interruptedTaskCount: 0,
    totalTaskDurationMs: 0,
    durationSampleCount: 0,
    longestTaskDurationMs: 0,
    models: [],
  };
}

function computeStreaks(
  activeDateKeys: string[],
  todayKey: string,
): {
  currentStreakDays: number;
  longestStreakDays: number;
} {
  if (activeDateKeys.length === 0) {
    return { currentStreakDays: 0, longestStreakDays: 0 };
  }

  let longestStreakDays = 1;
  let running = 1;
  for (let index = 1; index < activeDateKeys.length; index += 1) {
    if (dateKeyDistance(activeDateKeys[index - 1], activeDateKeys[index]) === 1) {
      running += 1;
      longestStreakDays = Math.max(longestStreakDays, running);
    } else {
      running = 1;
    }
  }

  const latest = activeDateKeys[activeDateKeys.length - 1];
  const latestDistance = dateKeyDistance(latest, todayKey);
  if (latestDistance < 0 || latestDistance > 1) {
    return { currentStreakDays: 0, longestStreakDays };
  }

  let currentStreakDays = 1;
  for (let index = activeDateKeys.length - 1; index > 0; index -= 1) {
    if (dateKeyDistance(activeDateKeys[index - 1], activeDateKeys[index]) !== 1) break;
    currentStreakDays += 1;
  }
  return { currentStreakDays, longestStreakDays };
}

function migrateLegacyFile(value: unknown): TokenUsageFile {
  const current = tokenUsageFileSchema.safeParse(value);
  if (current.success) return current.data;

  const versionTwo = legacyVersionTwoTokenUsageFileSchema.safeParse(value);
  if (versionTwo.success) {
    return { ...versionTwo.data, version: 3 };
  }

  const legacy = legacyTokenUsageFileSchema.parse(value);
  return {
    version: 3,
    firstRecordedAt: legacy.firstRecordedAt,
    lastRecordedAt: legacy.lastRecordedAt,
    days: legacy.days.map((day) => ({
      ...day,
      completedTaskCount: 0,
      failedTaskCount: 0,
      interruptedTaskCount: 0,
      totalTaskDurationMs: 0,
      durationSampleCount: 0,
      models: [],
    })),
  };
}

export interface ModelUsageRecord extends ProviderTokenUsage {
  configurationId?: string;
  provider: string;
  model: string;
  recordedAt?: Date;
}

export class TokenUsageStore {
  private data: TokenUsageFile = { version: 3, days: [] };
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const stored = JSON.parse(await readFile(this.filePath, "utf8"));
      this.data = migrateLegacyFile(stored);
      if (stored.version !== 3) await this.persist();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !(error instanceof SyntaxError) && !(error instanceof z.ZodError)) {
        throw error;
      }
      if (code !== "ENOENT") {
        try {
          this.data = migrateLegacyFile(JSON.parse(await readFile(`${this.filePath}.bak`, "utf8")));
          await writeTextFileAtomic(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`);
          return;
        } catch {
          // Both copies are unusable. Optional statistics must not block startup.
        }
      }
      this.data = { version: 3, days: [] };
      await writeTextFileAtomic(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`);
    }
  }

  async recordModelUsage(record: ModelUsageRecord): Promise<void> {
    const recordedAt = record.recordedAt ?? new Date();
    const timestamp = recordedAt.toISOString();
    await this.mutate(() => {
      const day = this.getOrCreateDay(localDateKey(recordedAt));
      addUsage(day, record);
      let model = day.models.find((entry) =>
        record.configurationId
          ? entry.configurationId === record.configurationId &&
            entry.provider === record.provider &&
            entry.model === record.model
          : !entry.configurationId &&
            entry.provider === record.provider &&
            entry.model === record.model,
      );
      if (!model) {
        model = emptyModel(record.provider, record.model, record.configurationId);
        day.models.push(model);
      }
      addUsage(model, record);
      this.data.firstRecordedAt ??= timestamp;
      this.data.lastRecordedAt = timestamp;
    });
  }

  async recordTask(
    durationMs: number,
    recordedAt = new Date(),
    outcome: TokenTaskOutcome = "completed",
  ): Promise<void> {
    const safeDuration = Math.max(0, Math.round(durationMs));
    await this.mutate(() => {
      const day = this.getOrCreateDay(localDateKey(recordedAt));
      day.taskCount += 1;
      day.totalTaskDurationMs += safeDuration;
      day.durationSampleCount += 1;
      day.longestTaskDurationMs = Math.max(day.longestTaskDurationMs, safeDuration);
      if (outcome === "completed") day.completedTaskCount += 1;
      else if (outcome === "failed") day.failedTaskCount += 1;
      else day.interruptedTaskCount += 1;
    });
  }

  getStats(now = new Date()): TokenUsageStats {
    const sortedDays = [...this.data.days].sort((a, b) => a.date.localeCompare(b.date));
    const activeDateKeys = sortedDays.filter((day) => day.totalTokens > 0).map((day) => day.date);
    const streaks = computeStreaks(activeDateKeys, localDateKey(now));
    const durationSampleCount = sumDays(sortedDays, "durationSampleCount");
    const models = new Map<string, TokenUsageModel>();
    for (const day of sortedDays) {
      for (const entry of day.models) {
        const key = entry.configurationId
          ? `configuration\0${entry.configurationId}\0${entry.provider}\0${entry.model}`
          : `legacy\0${entry.provider}\0${entry.model}`;
        const aggregate =
          models.get(key) ?? emptyModel(entry.provider, entry.model, entry.configurationId);
        addUsage(aggregate, entry, entry.requestCount);
        models.set(key, aggregate);
      }
    }

    return {
      totalTokens: sumDays(sortedDays, "totalTokens"),
      peakTokens: sortedDays.reduce((peak, day) => Math.max(peak, day.totalTokens), 0),
      requestCount: sumDays(sortedDays, "requestCount"),
      taskCount: sumDays(sortedDays, "taskCount"),
      completedTaskCount: sumDays(sortedDays, "completedTaskCount"),
      failedTaskCount: sumDays(sortedDays, "failedTaskCount"),
      interruptedTaskCount: sumDays(sortedDays, "interruptedTaskCount"),
      averageTaskDurationMs:
        durationSampleCount > 0
          ? Math.round(sumDays(sortedDays, "totalTaskDurationMs") / durationSampleCount)
          : 0,
      longestTaskDurationMs: sortedDays.reduce(
        (peak, day) => Math.max(peak, day.longestTaskDurationMs),
        0,
      ),
      ...streaks,
      firstRecordedAt: this.data.firstRecordedAt,
      lastRecordedAt: this.data.lastRecordedAt,
      models: [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens),
      days: sortedDays.map((day) => ({
        ...day,
        models: day.models.map((model) => ({ ...model })),
      })),
    };
  }

  private getOrCreateDay(date: string): TokenUsageDay {
    let day = this.data.days.find((entry) => entry.date === date);
    if (!day) {
      day = emptyDay(date);
      this.data.days.push(day);
    }
    return day;
  }

  private async mutate(change: () => void): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      change();
      await this.persist();
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  private async persist(): Promise<void> {
    await writeJsonFileAtomic(this.filePath, this.data);
  }
}

function emptyModel(provider: string, model: string, configurationId?: string): TokenUsageModel {
  return {
    ...(configurationId ? { configurationId } : {}),
    provider,
    model,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    requestCount: 0,
  };
}

function addUsage(
  target:
    | Omit<
        TokenUsageDay,
        | "date"
        | "taskCount"
        | "completedTaskCount"
        | "failedTaskCount"
        | "interruptedTaskCount"
        | "totalTaskDurationMs"
        | "durationSampleCount"
        | "longestTaskDurationMs"
        | "models"
      >
    | TokenUsageModel,
  usage: ProviderTokenUsage,
  requestCount = 1,
): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.totalTokens += usage.totalTokens;
  target.cachedInputTokens += usage.cachedInputTokens ?? 0;
  target.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
  target.requestCount += requestCount;
}

function sumDays(
  days: TokenUsageDay[],
  key:
    | "totalTokens"
    | "requestCount"
    | "taskCount"
    | "completedTaskCount"
    | "failedTaskCount"
    | "interruptedTaskCount"
    | "totalTaskDurationMs"
    | "durationSampleCount",
): number {
  return days.reduce((sum, day) => sum + day[key], 0);
}

export { computeStreaks, localDateKey };
