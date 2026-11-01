// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenUsageOverview } from "../app/renderer/src/components/TokenUsageOverview";
import type { ManagedModel } from "../app/renderer/src/modelCatalog";
import type { TokenUsageDay } from "../src/shared/token-usage";

const models: ManagedModel[] = [
  {
    id: "cny-model",
    vendorId: "cny-vendor",
    vendorKind: "custom",
    vendorLabel: "CNY",
    name: "CNY Model",
    provider: "openai",
    model: "same-model",
    baseURL: "https://cn.example.com/v1",
    openaiApiMode: "responses",
    pricing: {
      currency: "CNY",
      inputPerMillion: 1,
      cachedInputPerMillion: 0.1,
      outputPerMillion: 2,
      updatedAt: "2026-08-01",
    },
  },
  {
    id: "usd-model",
    vendorId: "usd-vendor",
    vendorKind: "custom",
    vendorLabel: "USD",
    name: "USD Model",
    provider: "openai",
    model: "same-model",
    baseURL: "https://us.example.com/v1",
    openaiApiMode: "responses",
    pricing: {
      currency: "USD",
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 10,
      updatedAt: "2026-08-01",
    },
  },
];

const usageModels = models.map((model) => ({
  configurationId: model.id,
  provider: model.provider,
  model: model.model,
  inputTokens: 1_000_000,
  outputTokens: 0,
  totalTokens: 1_000_000,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  requestCount: 1,
}));

const recordedDate = "2026-10-29";

function installUsageStats(dayOverrides: Partial<TokenUsageDay>[] = [{ date: recordedDate }]) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getTokenUsageStats: vi.fn().mockResolvedValue({
        totalTokens: 2_000_000,
        peakTokens: 2_000_000,
        requestCount: 2,
        taskCount: 3,
        completedTaskCount: 2,
        failedTaskCount: 1,
        interruptedTaskCount: 0,
        averageTaskDurationMs: 1_000,
        longestTaskDurationMs: 1_000,
        currentStreakDays: 1,
        longestStreakDays: 1,
        models: usageModels,
        days: dayOverrides.map((overrides) => ({
          date: recordedDate,
          inputTokens: 2_000_000,
          outputTokens: 0,
          totalTokens: 2_000_000,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          requestCount: 2,
          taskCount: 3,
          completedTaskCount: 2,
          failedTaskCount: 1,
          interruptedTaskCount: 0,
          totalTaskDurationMs: 3_000,
          durationSampleCount: 3,
          longestTaskDurationMs: 1_000,
          models: usageModels,
          ...overrides,
        })),
      }),
    },
  });
}

describe("TokenUsageOverview pricing", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 29, 12));
    installUsageStats();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("filters cost by currency without changing the metric or losing the selection", async () => {
    render(<TokenUsageOverview models={models} selectedModelId="usd-model" />);
    await waitFor(() => expect(screen.getByText("¥1.00 · $5.00")).toBeTruthy());

    fireEvent.click(screen.getByRole("tab", { name: "预估费用" }));
    const currencyGroup = screen.getByRole("group", { name: "费用币种" });
    expect(
      within(currencyGroup).getByRole("button", { name: "美元" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByTitle(`${recordedDate} · $5.00`)).toBeTruthy();
    fireEvent.click(screen.getByText("逐日数据"));
    const table = screen.getByRole("table", { name: "最近 30 天预估费用逐日数据" });
    expect(within(table).getByRole("columnheader", { name: "预估费用" })).toBeTruthy();
    expect(within(table).getByRole("row", { name: `${recordedDate} $5.00` })).toBeTruthy();
    fireEvent.click(within(currencyGroup).getByRole("button", { name: "人民币" }));
    expect(screen.getByRole("tab", { name: "预估费用" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByTitle(`${recordedDate} · ¥1.00`)).toBeTruthy();
    expect(within(table).getByRole("row", { name: `${recordedDate} ¥1.00` })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "任务数" }));
    expect(screen.queryByRole("group", { name: "费用币种" })).toBeNull();
    expect(screen.getByTitle(`${recordedDate} · 3 个任务`)).toBeTruthy();
    fireEvent.click(screen.getByText("逐日数据"));
    const tasksTable = screen.getByRole("table", { name: "最近 30 天任务数逐日数据" });
    expect(within(tasksTable).getByRole("columnheader", { name: "任务数" })).toBeTruthy();
    expect(within(tasksTable).getByRole("row", { name: `${recordedDate} 3 个任务` })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "预估费用" }));
    expect(screen.getByRole("button", { name: "人民币" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByTitle(`${recordedDate} · ¥1.00`)).toBeTruthy();
  });

  it("falls back to the remaining configured currency while keeping the cost view", async () => {
    const { rerender } = render(<TokenUsageOverview models={models} selectedModelId="usd-model" />);
    await waitFor(() => expect(screen.getByText("¥1.00 · $5.00")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "预估费用" }));
    expect(screen.getByTitle(`${recordedDate} · $5.00`)).toBeTruthy();

    rerender(<TokenUsageOverview models={[models[0]!]} selectedModelId="cny-model" />);
    expect(screen.queryByRole("group", { name: "费用币种" })).toBeNull();
    expect(screen.getByRole("tab", { name: "预估费用" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByTitle(`${recordedDate} · ¥1.00`)).toBeTruthy();
  });

  it("keeps all thirty daily values in the chart and expandable table across a month boundary", async () => {
    render(<TokenUsageOverview models={models} selectedModelId="usd-model" />);
    await waitFor(() => expect(screen.getByTitle(`${recordedDate} · 200万 Token`)).toBeTruthy());
    // Before a measurable width is available, retain the complete date range.
    const chart = screen.getByRole("img", { name: "最近 30 天Token柱状图" });
    expect(within(chart).getByText("2026-09-30")).toBeTruthy();
    expect(within(chart).getByText(recordedDate)).toBeTruthy();
    const summary = screen.getByText("逐日数据");
    expect(summary.tagName).toBe("SUMMARY");
    fireEvent.click(summary);
    const table = screen.getByRole("table", { name: "最近 30 天Token逐日数据" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(30);
    const dates = rows.map((row) => within(row).getByRole("rowheader").textContent);
    expect(dates[0]).toBe("2026-09-30");
    expect(dates.at(-1)).toBe(recordedDate);
    expect(new Set(dates).size).toBe(30);
    for (const row of rows) {
      const date = within(row).getByRole("rowheader").textContent;
      const value = within(row).getByRole("cell").textContent;
      expect(screen.getByTitle(`${date} · ${value}`)).toBeTruthy();
    }
    expect(within(table).getByRole("row", { name: "2026-09-30 0 Token" })).toBeTruthy();
    expect(within(table).getByRole("row", { name: `${recordedDate} 200万 Token` })).toBeTruthy();
  });

  it("preserves December and January dates, zero days and the peak without including older data", async () => {
    vi.setSystemTime(new Date(2026, 0, 10, 12));
    installUsageStats([
      { date: "2025-12-11", totalTokens: 8_000_000 },
      { date: "2025-12-31", totalTokens: 4_000_000 },
      { date: "2026-01-01", totalTokens: 1_200 },
    ]);
    render(<TokenUsageOverview models={models} selectedModelId="usd-model" />);
    await waitFor(() => expect(screen.getByTitle("2025-12-31 · 400万 Token")).toBeTruthy());
    fireEvent.click(screen.getByText("逐日数据"));
    const table = screen.getByRole("table", { name: "最近 30 天Token逐日数据" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(30);
    expect(within(rows[0]!).getByRole("rowheader").textContent).toBe("2025-12-12");
    expect(within(rows.at(-1)!).getByRole("rowheader").textContent).toBe("2026-01-10");
    expect(within(table).getByRole("row", { name: "2025-12-31 400万 Token" })).toBeTruthy();
    expect(within(table).getByRole("row", { name: "2026-01-01 1200 Token" })).toBeTruthy();
    expect(within(table).getByRole("row", { name: "2026-01-10 0 Token" })).toBeTruthy();
    expect(screen.queryByTitle("2025-12-11 · 800万 Token")).toBeNull();
    expect(within(table).queryByRole("rowheader", { name: "2025-12-11" })).toBeNull();
  });
});
