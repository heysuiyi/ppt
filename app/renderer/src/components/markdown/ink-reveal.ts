import { preserveSelection } from "./selection";

export interface GlyphInput {
  value: string;
  eligible: boolean;
}

export interface GlyphRecord {
  id: number;
  value: string;
  start: number | null;
  done: boolean;
}

interface RunningEffect {
  span: HTMLElement;
  animation: Animation;
}

function positions(
  values: readonly { value: string }[],
  start: number,
  end: number,
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (let i = start; i < end; i++) {
    const value = values[i]!.value;
    const entries = result.get(value);
    if (entries) entries.push(i);
    else result.set(value, [i]);
  }
  return result;
}

function nextPosition(entries: readonly number[] | undefined, after: number): number {
  if (!entries) return -1;
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle]! < after) low = middle + 1;
    else high = middle;
  }
  return entries[low] ?? -1;
}

export class InkReveal {
  private records: GlyphRecord[] = [];
  private sequence = 0;
  private readonly running = new Map<GlyphRecord, RunningEffect>();
  private readonly motion: MediaQueryList | undefined;
  private notified = false;
  private disposed = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly onChange?: (active: boolean) => void,
  ) {
    this.motion = root.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)");
    this.motion?.addEventListener("change", this.onMotionChange);
  }

  get active(): boolean {
    return this.running.size > 0;
  }

  private readonly onMotionChange = (): void => {
    if (this.motion?.matches) this.settle();
  };

  private timelineTime(): number | null {
    const time = this.root.ownerDocument.timeline?.currentTime;
    return typeof time === "number" ? time : null;
  }

  reconcile(values: readonly GlyphInput[], animate: boolean): GlyphRecord[] {
    const previous = this.records;
    const next = new Array<GlyphRecord>(values.length);
    const added: GlyphRecord[] = [];
    const time = this.timelineTime();
    const enabled =
      animate && !this.motion?.matches && typeof this.root.animate === "function" && time !== null;
    const create = (index: number): GlyphRecord => {
      const input = values[index]!;
      const record: GlyphRecord = {
        id: ++this.sequence,
        value: input.value,
        start: null,
        done: !enabled || !input.eligible,
      };
      if (!record.done) added.push(record);
      return record;
    };
    let prefix = 0;
    while (
      prefix < previous.length &&
      prefix < values.length &&
      previous[prefix]!.value === values[prefix]!.value
    ) {
      next[prefix] = previous[prefix]!;
      prefix++;
    }
    let suffix = 0;
    while (
      suffix < previous.length - prefix &&
      suffix < values.length - prefix &&
      previous[previous.length - suffix - 1]!.value === values[values.length - suffix - 1]!.value
    ) {
      next[values.length - suffix - 1] = previous[previous.length - suffix - 1]!;
      suffix++;
    }
    const oldEnd = previous.length - suffix;
    const newEnd = values.length - suffix;
    let old = prefix;
    let fresh = prefix;
    const oldPositions =
      old < oldEnd && fresh < newEnd ? positions(previous, old, oldEnd) : undefined;
    const newPositions = oldPositions ? positions(values, fresh, newEnd) : undefined;
    while (old < oldEnd && fresh < newEnd) {
      const record = previous[old]!;
      const value = values[fresh]!.value;
      if (
        record.value === value ||
        value.startsWith(record.value) ||
        record.value.startsWith(value)
      ) {
        // A combining mark or ZWJ continuation can extend the last released
        // grapheme. Its identity and absolute effect position remain unchanged.
        record.value = value;
        next[fresh++] = record;
        old++;
        continue;
      }
      const nextOld = nextPosition(oldPositions?.get(value), old + 1);
      const nextNew = nextPosition(newPositions?.get(record.value), fresh + 1);
      if (nextOld !== -1 && (nextNew === -1 || nextOld - old <= nextNew - fresh)) old = nextOld;
      else if (nextNew !== -1) {
        while (fresh < nextNew) {
          next[fresh] = create(fresh);
          fresh++;
        }
      } else {
        next[fresh] = create(fresh);
        fresh++;
        old++;
      }
    }
    while (fresh < newEnd) {
      next[fresh] = create(fresh);
      fresh++;
    }
    const stagger = Math.min(16, 80 / Math.max(1, added.length - 1));
    for (let i = 0; i < added.length; i++) added[i]!.start = time! + i * stagger;
    for (let i = 0; i < next.length; i++) {
      if (!values[i]!.eligible || !enabled) next[i]!.done = true;
    }
    this.records = next;
    return next;
  }

  shouldWrap(record: GlyphRecord): boolean {
    const time = this.timelineTime();
    if (!record.done && (time === null || record.start === null || time >= record.start + 180))
      record.done = true;
    return !record.done;
  }

  sync(mounts: ReadonlyMap<GlyphRecord, HTMLElement>): void {
    for (const [record, effect] of this.running) {
      if (mounts.get(record) !== effect.span || record.done) {
        effect.animation.cancel();
        this.running.delete(record);
      }
    }
    for (const [record, span] of mounts) {
      if (this.running.has(record)) continue;
      if (!this.shouldWrap(record)) {
        this.retire(span, record);
        continue;
      }
      const animation = span.animate(
        [
          { opacity: 0.2, filter: "blur(2px)" },
          { opacity: 0.85, filter: "blur(0px)", offset: 0.6 },
          { opacity: 1, filter: "none" },
        ],
        { duration: 180, fill: "both", easing: "ease-out" },
      );
      // Absolute document-timeline time, including the capped batch stagger.
      // Reparenting or remounting must never restart an already-visible glyph.
      animation.startTime = record.start;
      const effect = { span, animation };
      this.running.set(record, effect);
      void animation.finished.then(
        () => {
          if (this.disposed || this.running.get(record) !== effect) return;
          this.running.delete(record);
          this.retire(span, record);
          animation.cancel();
          this.notify();
        },
        () => {
          if (this.disposed || this.running.get(record) !== effect) return;
          this.running.delete(record);
          this.retire(span, record);
          this.notify();
        },
      );
    }
    this.notify();
  }

  private retire(span: HTMLElement, record: GlyphRecord): void {
    record.done = true;
    if (!this.root.contains(span)) return;
    preserveSelection(this.root, () => {
      const parent = span.parentNode;
      span.replaceWith(...Array.from(span.childNodes));
      parent?.normalize();
    });
  }

  private notify(): void {
    const active = this.active;
    if (active === this.notified) return;
    this.notified = active;
    this.onChange?.(active);
  }

  settle(): void {
    for (const record of this.records) record.done = true;
    const effects = Array.from(this.running.entries());
    this.running.clear();
    preserveSelection(this.root, () => {
      const parents = new Set<Node>();
      for (const [, effect] of effects) {
        effect.animation.cancel();
        const span = effect.span;
        if (!this.root.contains(span)) continue;
        if (span.parentNode) parents.add(span.parentNode);
        span.replaceWith(...Array.from(span.childNodes));
      }
      for (const parent of parents) parent.normalize();
    });
    this.notify();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.motion?.removeEventListener("change", this.onMotionChange);
    this.settle();
    this.records = [];
  }
}
