import { splitGraphemes } from "@shared/streaming-text";
import type { Element as HastElement, Text as HastText, RootContent } from "hast";
import { type GlyphInput, type GlyphRecord, InkReveal } from "./ink-reveal";
import { createMarkdownParser, markdownAttributes, markdownToHast } from "./markdown-semantics";
import { patchText, preserveSelection } from "./selection";

interface RenderText {
  type: "text";
  value: string;
  key: number | undefined;
}

interface RenderElement {
  type: "element";
  tagName: string;
  attributes: ReadonlyMap<string, string>;
  children: RenderNode[];
  key: number | undefined;
  svg: boolean;
  glyph?: GlyphRecord;
}

type RenderNode = RenderText | RenderElement;

export interface MarkdownRendererOptions {
  onEffectsChange?: (active: boolean) => void;
}

export interface MarkdownUpdateOptions {
  animate: boolean;
  finalize?: boolean;
}

const skippedTags: Record<string, true> = {
  pre: true,
  code: true,
  table: true,
  svg: true,
  math: true,
};
const glyphAttributes = new Map([["class", "markdown-ink-glyph"]]);

function skipElement(node: HastElement): boolean {
  return (
    Boolean(skippedTags[node.tagName]) ||
    Boolean(node.properties.hidden) ||
    node.properties.ariaHidden === "true" ||
    (Array.isArray(node.properties.className) && node.properties.className.includes("sr-only"))
  );
}

export class MarkdownRenderer {
  private readonly parser = createMarkdownParser();
  private readonly ink: InkReveal;
  private readonly keys = new WeakMap<Node, number>();
  private _source = "";
  private finalized = false;
  private disposed = false;

  constructor(
    private readonly root: HTMLElement,
    options: MarkdownRendererOptions = {},
  ) {
    root.replaceChildren();
    this.ink = new InkReveal(root, options.onEffectsChange);
  }

  get source(): string {
    return this._source;
  }
  get activeEffects(): boolean {
    return this.ink.active;
  }

  update(source: string, options: MarkdownUpdateOptions): void {
    if (this.disposed) return;
    if (!options.animate) this.ink.settle();
    const changed = source !== this._source;
    const finish = Boolean(options.finalize) && !this.finalized;
    if (!changed && !finish) return;
    if (changed) {
      if (this.finalized || !source.startsWith(this._source)) {
        this.parser.reset();
        if (source) this.parser.append(source);
      } else {
        this.parser.append(source.slice(this._source.length));
      }
      this._source = source;
      this.finalized = false;
    }
    if (options.finalize) {
      this.parser.finalize();
      this.finalized = true;
    }
    this.render(options.animate);
  }

  settleEffects(): void {
    this.ink.settle();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ink.dispose();
    this.root.replaceChildren();
    this.parser.reset();
  }

  private render(animate: boolean): void {
    const tree = markdownToHast(this.parser.getAst());
    const inputs: GlyphInput[] = [];
    const segments = new WeakMap<HastText, string[]>();
    const collect = (node: RootContent, skipped: boolean): void => {
      if (node.type === "text") {
        const values = splitGraphemes(node.value);
        segments.set(node, values);
        for (const value of values) inputs.push({ value, eligible: !skipped && /\S/u.test(value) });
      } else if (node.type === "element") {
        const skip = skipped || skipElement(node);
        for (const child of node.children) collect(child, skip);
      }
    };
    for (const child of tree.children) collect(child, false);
    // This ledger includes structural whitespace and generated footnote text,
    // not only visible/animated letters. Formatting changes cannot shift a
    // block-local animation cursor and replay text in another paragraph.
    const records = this.ink.reconcile(inputs, animate);
    const mounts = new Map<GlyphRecord, HTMLElement>();
    let cursor = 0;
    const build = (nodes: readonly RootContent[], svgSpace: boolean): RenderNode[] => {
      const result: RenderNode[] = [];
      for (const node of nodes) {
        if (node.type === "text") {
          let text = "";
          let key: number | undefined;
          const flush = (): void => {
            if (text) result.push({ type: "text", value: text, key });
            text = "";
            key = undefined;
          };
          for (const value of segments.get(node) ?? []) {
            const record = records[cursor++]!;
            if (this.ink.shouldWrap(record)) {
              flush();
              result.push({
                type: "element",
                tagName: "span",
                attributes: glyphAttributes,
                children: [{ type: "text", value, key: record.id }],
                key: record.id,
                svg: false,
                glyph: record,
              });
            } else {
              key ??= record.id;
              text += value;
            }
          }
          flush();
        } else if (node.type === "element") {
          const svg = svgSpace || node.tagName === "svg";
          const children = build(node.children, svg && node.tagName !== "foreignObject");
          result.push({
            type: "element",
            tagName: node.tagName,
            attributes: markdownAttributes(node, svg),
            children,
            key: children.find((child) => child.key !== undefined)?.key,
            svg,
          });
        }
      }
      return result;
    };
    const desired = build(tree.children, false);
    preserveSelection(this.root, () => this.patch(this.root, desired, mounts));
    this.ink.sync(mounts);
  }

  private compatible(node: Node, desired: RenderNode): boolean {
    if (desired.type === "text") return node.nodeType === 3;
    if (node.nodeType !== 1) return false;
    const element = node as Element;
    return (
      element.localName === desired.tagName &&
      element.namespaceURI ===
        (desired.svg ? "http://www.w3.org/2000/svg" : "http://www.w3.org/1999/xhtml")
    );
  }

  private patch(
    parent: Node,
    desired: readonly RenderNode[],
    mounts: Map<GlyphRecord, HTMLElement>,
  ): void {
    let current = parent.firstChild;
    // A later retained sibling wins over a same-tag positional fallback. This
    // keeps unrelated paragraphs mounted when a new paragraph is inserted.
    const remaining = new Set<number>();
    for (const node of desired) if (node.key !== undefined) remaining.add(node.key);
    for (const fresh of desired) {
      if (fresh.key !== undefined) remaining.delete(fresh.key);
      const matches = (node: Node): boolean =>
        this.compatible(node, fresh) &&
        (fresh.key === undefined || this.keys.get(node) === fresh.key);
      let match = current;
      if (match && !matches(match)) {
        let candidate = match.nextSibling;
        while (candidate && !matches(candidate)) candidate = candidate.nextSibling;
        if (candidate) {
          parent.insertBefore(candidate, current);
          match = candidate;
        } else if (
          !this.compatible(match, fresh) ||
          (this.keys.has(match) && remaining.has(this.keys.get(match)!))
        )
          match = null;
      }
      if (!match) {
        match =
          fresh.type === "text"
            ? this.root.ownerDocument.createTextNode("")
            : fresh.svg
              ? this.root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", fresh.tagName)
              : this.root.ownerDocument.createElement(fresh.tagName);
        parent.insertBefore(match, current);
      }
      if (fresh.key !== undefined) this.keys.set(match, fresh.key);
      else this.keys.delete(match);
      if (fresh.type === "text") patchText(match as Text, fresh.value);
      else {
        const element = match as HTMLElement;
        for (const attribute of Array.from(element.attributes)) {
          if (!fresh.attributes.has(attribute.name)) element.removeAttribute(attribute.name);
        }
        for (const [name, value] of fresh.attributes) {
          if (element.getAttribute(name) !== value) element.setAttribute(name, value);
        }
        this.patch(element, fresh.children, mounts);
        if (fresh.glyph) mounts.set(fresh.glyph, element);
      }
      current = match.nextSibling;
    }
    while (current) {
      const next = current.nextSibling;
      parent.removeChild(current);
      current = next;
    }
  }
}
