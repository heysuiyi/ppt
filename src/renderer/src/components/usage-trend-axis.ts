export interface UsageTrendTick {
  index: number;
  left: number;
  width: number;
}

export interface UsageTrendAxisLayout {
  ticks: UsageTrendTick[];
  showRange: boolean;
}

/** Keep both endpoints before admitting any interior labels, in date order. */
export function selectTrendTicks(
  labelWidths: readonly number[],
  containerWidth: number,
  minimumGap = 8,
): UsageTrendAxisLayout {
  if (labelWidths.length === 0) return { ticks: [], showRange: false };
  if (
    containerWidth <= 0 ||
    labelWidths[0]! > containerWidth ||
    labelWidths[labelWidths.length - 1]! > containerWidth
  ) {
    return { ticks: [], showRange: true };
  }

  const tickAt = (index: number): UsageTrendTick => {
    const width = labelWidths[index]!;
    const center = ((index + 0.5) / labelWidths.length) * containerWidth;
    return {
      index,
      left: Math.max(0, Math.min(center - width / 2, containerWidth - width)),
      width,
    };
  };
  const first = tickAt(0);
  if (labelWidths.length === 1) return { ticks: [first], showRange: false };
  const last = tickAt(labelWidths.length - 1);
  if (first.left + first.width + minimumGap > last.left) {
    return { ticks: [], showRange: true };
  }

  const ticks = [first];
  let previousRight = first.left + first.width;
  for (let index = 1; index < labelWidths.length - 1; index += 1) {
    const tick = tickAt(index);
    if (
      tick.left >= previousRight + minimumGap &&
      tick.left + tick.width + minimumGap <= last.left
    ) {
      ticks.push(tick);
      previousRight = tick.left + tick.width;
    }
  }
  ticks.push(last);
  return { ticks, showRange: false };
}

export function sameTrendAxisLayout(
  previous: UsageTrendAxisLayout,
  next: UsageTrendAxisLayout,
): boolean {
  return (
    previous.showRange === next.showRange &&
    previous.ticks.length === next.ticks.length &&
    previous.ticks.every((tick, index) => {
      const other = next.ticks[index]!;
      return tick.index === other.index && tick.left === other.left && tick.width === other.width;
    })
  );
}
