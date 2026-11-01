import { describe, expect, it } from "vitest";
import { selectTrendTicks } from "../app/renderer/src/components/usage-trend-axis";

function expectNonOverlappingLayout(widths: number[], containerWidth: number, minimumGap = 8) {
  const layout = selectTrendTicks(widths, containerWidth, minimumGap);
  expect(layout.showRange).toBe(false);
  expect(layout.ticks[0]?.index).toBe(0);
  expect(layout.ticks.at(-1)?.index).toBe(widths.length - 1);
  for (const [position, tick] of layout.ticks.entries()) {
    expect(tick.left).toBeGreaterThanOrEqual(0);
    expect(tick.left + tick.width).toBeLessThanOrEqual(containerWidth);
    expect(tick.width).toBe(widths[tick.index]);
    const previous = layout.ticks[position - 1];
    if (previous) {
      expect(tick.index).toBeGreaterThan(previous.index);
      expect(tick.left).toBeGreaterThanOrEqual(previous.left + previous.width + minimumGap);
    }
  }
  expect(selectTrendTicks(widths, containerWidth, minimumGap)).toEqual(layout);
  return layout;
}

describe("usage trend measured date axis", () => {
  it.each([240, 360, 600])(
    "keeps endpoints, stable date order and measured gaps at width %i",
    (width) => {
      // Synthetic measured widths, not a claim about browser font metrics.
      const widths = Array.from({ length: 30 }, (_, index) => (index % 3 === 0 ? 42 : 31));
      const layout = expectNonOverlappingLayout(widths, width);
      expect(layout.ticks[0]?.left).toBe(0);
      const last = layout.ticks.at(-1)!;
      expect(last.left + last.width).toBe(width);
    },
  );

  it("reselects labels when measured glyph widths change, without dropping the endpoints", () => {
    const small = expectNonOverlappingLayout(Array<number>(30).fill(22), 360);
    const large = expectNonOverlappingLayout(Array<number>(30).fill(80), 360);
    expect(large.ticks.length).toBeLessThan(small.ticks.length);
    expect(large.ticks.map((tick) => tick.index)).not.toEqual(
      small.ticks.map((tick) => tick.index),
    );
  });

  it("reserves the endpoint space before considering an oversized interior date", () => {
    const widths = Array<number>(30).fill(32);
    widths[15] = 500;
    const layout = expectNonOverlappingLayout(widths, 240);
    expect(layout.ticks.some((tick) => tick.index === 15)).toBe(false);
  });

  it("fits both clamped endpoints exactly at the minimum measured gap", () => {
    const layout = expectNonOverlappingLayout(Array<number>(30).fill(40), 88);
    expect(layout.ticks).toEqual([
      { index: 0, left: 0, width: 40 },
      { index: 29, left: 48, width: 40 },
    ]);
  });

  it.each([0, 1, 39, 79, 87])(
    "uses a complete-range fallback rather than losing an endpoint at width %i",
    (width) => {
      const layout = selectTrendTicks(Array<number>(30).fill(40), width);
      expect(layout).toEqual({ ticks: [], showRange: true });
      // A range represents every day; never substitute just the first or last tick.
      expect(layout.ticks.some((tick) => tick.index === 0 || tick.index === 29)).toBe(false);
    },
  );

  it("handles an empty range and a single date without duplicate endpoints", () => {
    expect(selectTrendTicks([], 240)).toEqual({ ticks: [], showRange: false });
    expect(selectTrendTicks([40], 40)).toEqual({
      ticks: [{ index: 0, left: 0, width: 40 }],
      showRange: false,
    });
    expect(selectTrendTicks([40], 39)).toEqual({ ticks: [], showRange: true });
  });
});
