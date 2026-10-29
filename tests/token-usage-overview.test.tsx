// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenUsageOverview } from "../src/renderer/src/components/TokenUsageOverview";
import type { ManagedModel } from "../src/renderer/src/modelCatalog";

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

function installUsageStats() {
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
        days: [
          {
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
          },
        ],
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
    fireEvent.click(within(currencyGroup).getByRole("button", { name: "人民币" }));
    expect(screen.getByRole("tab", { name: "预估费用" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByTitle(`${recordedDate} · ¥1.00`)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "任务数" }));
    expect(screen.queryByRole("group", { name: "费用币种" })).toBeNull();
    expect(screen.getByTitle(`${recordedDate} · 3 个任务`)).toBeTruthy();
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
});
