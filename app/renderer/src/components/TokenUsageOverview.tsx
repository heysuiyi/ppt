import type { TokenUsageDay, TokenUsageStats } from "@shared/token-usage";
import React from "react";
import type { ManagedModel } from "../modelCatalog";
import {
  buildPricingIndex,
  estimateModelCost,
  estimateModelsCost,
  type ModelPricingCurrency,
  resolveUsagePricing,
} from "../modelPricing";
import { Button, IconButton } from "./Button";
import { RefreshIcon } from "./Icons";
import { Tabs, TabsList, TabsPanel } from "./Tabs";
import { UsageTrendChart, type UsageTrendDay } from "./UsageTrendChart";

type UsageView = "tokens" | "cost" | "tasks";

interface TokenUsageOverviewProps {
  models: ManagedModel[];
  selectedModelId: string;
}

const USAGE_VIEWS: readonly { value: UsageView; label: string }[] = [
  { value: "tokens", label: "Token" },
  { value: "cost", label: "预估费用" },
  { value: "tasks", label: "任务数" },
];

const emptyStats: TokenUsageStats = {
  totalTokens: 0,
  peakTokens: 0,
  requestCount: 0,
  taskCount: 0,
  completedTaskCount: 0,
  failedTaskCount: 0,
  interruptedTaskCount: 0,
  averageTaskDurationMs: 0,
  longestTaskDurationMs: 0,
  currentStreakDays: 0,
  longestStreakDays: 0,
  models: [],
  days: [],
};

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatCost(value: number, currency: ModelPricingCurrency): string {
  const symbol = currency === "CNY" ? "¥" : "$";
  if (value === 0) return `${symbol}0.00`;
  if (value < 0.01) return `<${symbol}0.01`;
  return `${symbol}${value.toFixed(2)}`;
}

function formatDuration(durationMs: number): string {
  if (durationMs <= 0) return "—";
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes} 分 ${remainingSeconds} 秒`;
}

function modelKey(provider: string, model: string): string {
  return `${provider}\0${model}`;
}

function buildTrendDays(stats: TokenUsageStats): TokenUsageDay[] {
  const byDate = new Map(stats.days.map((day) => [day.date, day]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (29 - index));
    return (
      byDate.get(dateKey(date)) ?? {
        date: dateKey(date),
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
      }
    );
  });
}

export const TokenUsageOverview: React.FC<TokenUsageOverviewProps> = ({
  models,
  selectedModelId,
}) => {
  const [stats, setStats] = React.useState<TokenUsageStats>(emptyStats);
  const [view, setView] = React.useState<UsageView>("tokens");
  const [costCurrency, setCostCurrency] = React.useState<ModelPricingCurrency>(
    () =>
      models.find((model) => model.id === selectedModelId)?.pricing?.currency ??
      (["CNY", "USD"] as const).find((currency) =>
        models.some((model) => model.pricing?.currency === currency),
      ) ??
      "CNY",
  );
  const previousSelectedModelId = React.useRef(selectedModelId);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const loadStats = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStats(await window.desktopApi.getTokenUsageStats());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const pricing = React.useMemo(() => buildPricingIndex(models), [models]);
  const totalEstimate = React.useMemo(
    () => estimateModelsCost(stats.models, pricing),
    [pricing, stats.models],
  );
  const trendDays = React.useMemo(() => buildTrendDays(stats), [stats]);
  const trendData = React.useMemo<UsageTrendDay[]>(() => {
    const spansYears = trendDays[0]?.date.slice(0, 4) !== trendDays.at(-1)?.date.slice(0, 4);
    return trendDays.map((day) => {
      const value =
        view === "tokens"
          ? day.totalTokens
          : view === "tasks"
            ? day.taskCount
            : estimateModelsCost(day.models, pricing).costs[costCurrency];
      return {
        date: day.date,
        dateLabel: `${spansYears ? `${day.date.slice(0, 4)}/` : ""}${Number(day.date.slice(5, 7))}/${Number(day.date.slice(8, 10))}`,
        value,
        formattedValue:
          view === "cost"
            ? formatCost(value, costCurrency)
            : view === "tokens"
              ? `${formatTokens(value)} Token`
              : `${value} 个任务`,
      };
    });
  }, [costCurrency, pricing, trendDays, view]);
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const configuredCurrencies = React.useMemo(
    () =>
      (["CNY", "USD"] as const).filter((currency) =>
        models.some((model) => model.pricing?.currency === currency),
      ),
    [models],
  );
  React.useEffect(() => {
    const selectionChanged = previousSelectedModelId.current !== selectedModelId;
    previousSelectedModelId.current = selectedModelId;
    if (selectionChanged && selectedModel?.pricing) {
      setCostCurrency(selectedModel.pricing.currency);
      return;
    }
    if (!configuredCurrencies.includes(costCurrency)) {
      setCostCurrency(selectedModel?.pricing?.currency ?? configuredCurrencies[0] ?? "CNY");
    }
  }, [configuredCurrencies, costCurrency, selectedModel, selectedModelId]);
  const selectedModelEnabled = Boolean(selectedModel && selectedModel.enabled !== false);
  const measuredTasks = stats.completedTaskCount + stats.failedTaskCount;
  const successRate =
    measuredTasks > 0 ? (stats.completedTaskCount / measuredTasks) * 100 : undefined;
  const coverage =
    stats.totalTokens > 0 ? Math.round((totalEstimate.coveredTokens / stats.totalTokens) * 100) : 0;
  const totalCostLabel =
    configuredCurrencies.length > 0
      ? configuredCurrencies
          .map((currency) => formatCost(totalEstimate.costs[currency], currency))
          .join(" · ")
      : "—";

  const metrics = [
    {
      value: stats.totalTokens > 0 && totalEstimate.coveredTokens === 0 ? "—" : totalCostLabel,
      label: "预估 API 费用",
      detail: stats.totalTokens > 0 ? `覆盖 ${coverage}% Token` : "等待产生用量",
    },
    {
      value: stats.requestCount.toLocaleString("zh-CN"),
      label: "模型调用",
      detail: `${formatTokens(stats.totalTokens)} Token`,
    },
    {
      value: stats.taskCount.toLocaleString("zh-CN"),
      label: "Agent 任务",
      detail: stats.interruptedTaskCount > 0 ? `${stats.interruptedTaskCount} 次中断` : "本地累计",
    },
    {
      value: successRate === undefined ? "—" : `${successRate.toFixed(1)}%`,
      label: "任务成功率",
      detail: measuredTasks > 0 ? `${stats.failedTaskCount} 次失败` : "暂无完整样本",
    },
    {
      value: formatDuration(stats.averageTaskDurationMs),
      label: "平均任务耗时",
      detail: "按已记录任务计算",
    },
  ];

  const trendContent = error ? (
    <div className="token-usage-state is-error">
      <span>统计读取失败：{error}</span>
      <Button variant="quiet" size="sm" onClick={() => void loadStats()}>
        重试
      </Button>
    </div>
  ) : (
    <UsageTrendChart
      days={trendData}
      loading={loading}
      label={USAGE_VIEWS.find((option) => option.value === view)!.label}
    />
  );
  return (
    <div className="token-usage-shell">
      <section className="token-current-model" aria-label="当前主模型">
        <div>
          <span>当前主模型</span>
          <strong>{selectedModel?.name ?? "未选择模型"}</strong>
          <small>{selectedModel?.model ?? "请先配置可用模型"}</small>
        </div>
        <span className={`token-model-status ${selectedModelEnabled ? "is-online" : ""}`}>
          {selectedModel ? (selectedModelEnabled ? "已启用" : "已停用") : "未配置"}
        </span>
      </section>

      <section className="token-usage-metrics" aria-label="用量与费用概览">
        {metrics.map((metric) => (
          <div className="token-usage-metric" key={metric.label}>
            <strong>{loading ? "—" : metric.value}</strong>
            <span>{metric.label}</span>
            <small>{loading ? "" : metric.detail}</small>
          </div>
        ))}
      </section>

      <section className="token-activity-card settings-card">
        <Tabs value={view} onValueChange={setView} items={USAGE_VIEWS}>
          <div className="token-activity-header">
            <div>
              <h3>最近 30 天趋势</h3>
              <p>按实际模型响应记录，可切换业务与成本视角</p>
            </div>
            <div className="token-activity-actions">
              <TabsList label="用量趋势指标" variant="plain" />
              {view === "cost" && configuredCurrencies.length > 1 ? (
                <div className="token-currency-filter" role="group" aria-label="费用币种">
                  {configuredCurrencies.map((currency) => (
                    <Button
                      key={currency}
                      size="sm"
                      aria-pressed={costCurrency === currency}
                      onClick={() => setCostCurrency(currency)}
                    >
                      {currency === "CNY" ? "人民币" : "美元"}
                    </Button>
                  ))}
                </div>
              ) : null}
              <IconButton
                className="token-usage-refresh"
                onClick={() => void loadStats()}
                aria-label="刷新用量统计"
                title="刷新"
                disabled={loading}
              >
                <RefreshIcon size={14} />
              </IconButton>
            </div>
          </div>

          {USAGE_VIEWS.map((option) => (
            <TabsPanel key={option.value} value={option.value}>
              {trendContent}
            </TabsPanel>
          ))}
        </Tabs>
      </section>

      <section className="token-model-breakdown settings-card">
        <div className="token-activity-header">
          <div>
            <h3>按模型分摊</h3>
            <p>识别不同模型的 Token、调用次数与预估费用</p>
          </div>
        </div>
        {stats.models.length > 0 ? (
          <div className="token-model-list">
            {stats.models.map((usage) => {
              const estimate = estimateModelCost(usage, resolveUsagePricing(usage, pricing));
              const share =
                stats.totalTokens > 0 ? (usage.totalTokens / stats.totalTokens) * 100 : 0;
              return (
                <div
                  className="token-model-row"
                  key={usage.configurationId ?? modelKey(usage.provider, usage.model)}
                >
                  <div className="token-model-copy">
                    <strong>{usage.model}</strong>
                    <span>
                      {usage.provider} · {usage.requestCount} 次调用
                    </span>
                  </div>
                  <div className="token-model-bar-track">
                    <span style={{ width: `${share}%` }} />
                  </div>
                  <div className="token-model-values">
                    <strong>{formatTokens(usage.totalTokens)}</strong>
                    <span>
                      {estimate.currency
                        ? formatCost(estimate.cost, estimate.currency)
                        : "费用未知"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="token-usage-empty">完成下一次模型调用后，这里会开始记录模型用量。</p>
        )}
        <p className="token-pricing-note">
          费用按当前模型配置的单价估算，修改价格会重算历史用量；不包含折扣、税费与工具调用费用，实际账单以服务商为准。
        </p>
      </section>
    </div>
  );
};
