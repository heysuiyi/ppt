import React from "react";
import {
  sameTrendAxisLayout,
  selectTrendTicks,
  type UsageTrendAxisLayout,
} from "./usage-trend-axis";

export interface UsageTrendDay {
  date: string;
  dateLabel: string;
  value: number;
  formattedValue: string;
}

interface UsageTrendChartProps {
  days: readonly UsageTrendDay[];
  loading: boolean;
  label: string;
}

export function UsageTrendChart({ days, loading, label }: UsageTrendChartProps) {
  const axisRef = React.useRef<HTMLDivElement>(null);
  const labelsRef = React.useRef<HTMLDivElement>(null);
  const [axis, setAxis] = React.useState<UsageTrendAxisLayout>({
    ticks: [],
    showRange: true,
  });
  const maximum = days.reduce((peak, day) => Math.max(peak, day.value), 0);

  React.useLayoutEffect(() => {
    const container = axisRef.current;
    const labels = labelsRef.current;
    if (!container || !labels) return;
    let disposed = false;
    let frame: number | undefined;
    const measure = () => {
      if (disposed) return;
      const widths = days.map((_, index) => labels.children[index]!.getBoundingClientRect().width);
      const next = selectTrendTicks(widths, container.getBoundingClientRect().width);
      setAxis((previous) => (sameTrendAxisLayout(previous, next) ? previous : next));
    };
    const scheduleMeasure = () => {
      if (disposed || frame !== undefined) return;
      if (typeof window.requestAnimationFrame !== "function") {
        measure();
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        measure();
      });
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    observer?.observe(container);
    for (const element of labels.children) observer?.observe(element);
    window.addEventListener("resize", scheduleMeasure);
    // Font swaps can change glyph widths without changing the chart's width.
    const fonts = document.fonts;
    void fonts?.ready.then(scheduleMeasure);
    fonts?.addEventListener("loadingdone", scheduleMeasure);
    return () => {
      disposed = true;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      fonts?.removeEventListener("loadingdone", scheduleMeasure);
    };
  }, [days]);

  const first = days[0];
  const last = days[days.length - 1];
  return (
    <div className={`token-trend ${loading ? "is-loading" : ""}`} aria-busy={loading}>
      <div
        className="token-trend-chart"
        role="img"
        aria-label={`最近 ${days.length} 天${label}柱状图`}
      >
        <div
          className="token-trend-bars"
          style={{ gridTemplateColumns: `repeat(${Math.max(1, days.length)}, minmax(0, 1fr))` }}
        >
          {days.map((day) => (
            <div
              className="token-trend-column"
              key={day.date}
              title={`${day.date} · ${day.formattedValue}`}
            >
              <span
                className="token-trend-bar"
                style={{
                  height: `${maximum > 0 ? Math.max(3, (day.value / maximum) * 100) : 3}%`,
                }}
              />
            </div>
          ))}
        </div>
        <div className="token-trend-axis" ref={axisRef}>
          <div className="token-trend-measure" ref={labelsRef} aria-hidden="true">
            {days.map((day) => (
              <span key={day.date}>{day.dateLabel}</span>
            ))}
          </div>
          {axis.showRange && first && last ? (
            <span className="token-trend-range">
              <span>{first.date}</span>
              {first !== last ? (
                <>
                  {" "}
                  — <span>{last.date}</span>
                </>
              ) : null}
            </span>
          ) : (
            axis.ticks.map((tick) => (
              <span
                className="token-trend-tick"
                key={days[tick.index]!.date}
                style={{ left: tick.left }}
              >
                {days[tick.index]!.dateLabel}
              </span>
            ))
          )}
        </div>
      </div>
      <details className="token-trend-data">
        <summary>逐日数据</summary>
        <table>
          <caption>
            最近 {days.length} 天{label}逐日数据
          </caption>
          <thead>
            <tr>
              <th scope="col">日期</th>
              <th scope="col">{label}</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.date}>
                <th scope="row">{day.date}</th>
                <td>{day.formattedValue}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
