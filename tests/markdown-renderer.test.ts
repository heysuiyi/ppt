// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarkdownRenderer } from "../src/renderer/src/components/markdown/MarkdownRenderer";

describe("MarkdownRenderer native document semantics", () => {
  let root: HTMLDivElement;
  let renderer: MarkdownRenderer;

  beforeEach(() => {
    root = document.createElement("div");
    root.className = "markdown-body";
    document.body.append(root);
    renderer = new MarkdownRenderer(root);
  });

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    renderer.dispose();
    root.remove();
  });

  it("renders raw HTML literally without creating executable or event-bearing elements", () => {
    const source = [
      "<script>window.markdownExecuted = true</script>",
      "",
      '<img src="x" onerror="window.markdownExecuted = true">',
      "",
      'Text <b onclick="alert(1)">not HTML</b>.',
    ].join("\n");
    renderer.update(source, { animate: false, finalize: true });

    expect(root.textContent).toContain("<script>window.markdownExecuted = true</script>");
    expect(root.textContent).toContain('<img src="x" onerror="window.markdownExecuted = true">');
    expect(root.textContent).toContain('Text <b onclick="alert(1)">not HTML</b>.');
    expect(root.querySelector("script, img, b, [onclick], [onerror]")).toBeNull();
    expect(root.className).toBe("markdown-body");
  });

  it("does not expose unsafe protocols as navigable links or image sources", () => {
    renderer.update(
      "[Unsafe](javascript:alert%281%29) [Safe](https://example.com/path) ![Unsafe image](data:text/html,unsafe)",
      { animate: false, finalize: true },
    );

    expect(root.querySelector('a[href="https://example.com/path"]')?.textContent).toBe("Safe");
    expect(root.textContent).toContain("Unsafe");
    for (const element of root.querySelectorAll("a, img")) {
      const url = element.getAttribute(element.tagName === "A" ? "href" : "src");
      expect(url ?? "").not.toMatch(/^(?:javascript|vbscript|data):/i);
    }
  });

  it("preserves task checkbox state and safe table alignment without structural whitespace", () => {
    renderer.update(
      [
        "- [x] Shipped",
        "- [ ] Pending",
        "",
        "| Left | Center | Right |",
        "| :--- | :---: | ---: |",
        "| One | Two | Three |",
      ].join("\n"),
      { animate: false, finalize: true },
    );

    const checkboxes = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checkboxes.map((checkbox) => checkbox.checked)).toEqual([true, false]);
    expect(checkboxes.map((checkbox) => checkbox.disabled)).toEqual([true, true]);
    expect(checkboxes.map((checkbox) => checkbox.parentElement?.textContent?.trim())).toEqual([
      "Shipped",
      "Pending",
    ]);
    const table = root.querySelector("table")!;
    expect([...table.querySelectorAll("th")].map((cell) => cell.style.textAlign)).toEqual([
      "left",
      "center",
      "right",
    ]);
    expect([...table.querySelectorAll("td")].map((cell) => cell.style.textAlign)).toEqual([
      "left",
      "center",
      "right",
    ]);
    expect([...table.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual([
      "One",
      "Two",
      "Three",
    ]);
    for (const element of [table, ...table.querySelectorAll("thead, tbody, tr")]) {
      expect([...element.childNodes].every((child) => child.nodeType === Node.ELEMENT_NODE)).toBe(
        true,
      );
    }
  });

  it("resolves late reference definitions inside nested containers across the whole document", () => {
    const partial = [
      "Stable paragraph.",
      "",
      "> - Read **[the guide][guide]**.",
      ">   - See [the detail][detail].",
      "",
      "Last paragraph.",
    ].join("\n");
    renderer.update(partial, { animate: false });
    const paragraph = root.querySelector("p");
    renderer.update(`${partial}\n\n[guide]: https://example.com/guide\n[detail]: /details`, {
      animate: false,
      finalize: true,
    });

    expect(root.querySelector("p")).toBe(paragraph);
    expect(root.querySelector("blockquote > ul > li strong > a")?.getAttribute("href")).toBe(
      "https://example.com/guide",
    );
    expect(root.querySelector("blockquote ul ul a")?.getAttribute("href")).toBe("/details");
    expect([...root.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
      "the guide",
      "the detail",
    ]);
    expect(root.textContent).not.toContain("[guide]:");
  });

  it("numbers cross-paragraph footnotes globally with one accessible footer and working backrefs", () => {
    renderer.update(
      [
        "First paragraph[^alpha].",
        "",
        "Second paragraph[^beta].",
        "",
        "[^beta]: Second note.",
        "[^alpha]: First note.",
      ].join("\n"),
      { animate: false, finalize: true },
    );

    const references = [...root.querySelectorAll<HTMLAnchorElement>("a[data-footnote-ref]")];
    expect(references.map((reference) => reference.textContent)).toEqual(["1", "2"]);
    const footers = root.querySelectorAll("section[data-footnotes]");
    expect(footers).toHaveLength(1);
    const footer = footers[0]!;
    const notes = [...footer.querySelectorAll("ol > li")];
    expect(notes).toHaveLength(2);
    expect(notes[0]?.textContent).toContain("First note.");
    expect(notes[1]?.textContent).toContain("Second note.");

    references.forEach((reference, index) => {
      const describedBy = reference.getAttribute("aria-describedby");
      expect(describedBy).toBe(footer.querySelector("h2")?.id);
      expect(describedBy).toBeTruthy();
      expect(reference.hasAttribute("ariadescribedby")).toBe(false);
      const note = notes[index]!;
      expect(reference.getAttribute("href")).toBe(`#${note.id}`);
      expect(note.id).not.toBe("");
      const backref = note.querySelector("a[data-footnote-backref]");
      expect(backref?.getAttribute("href")).toBe(`#${reference.id}`);
      expect(reference.id).not.toBe("");
      expect(backref?.getAttribute("aria-label")).toMatch(/back/i);
    });
  });

  it("adds late footnotes to an existing document without restarting numbering per paragraph", () => {
    const partial = "First[^one].\n\nSecond[^two].";
    renderer.update(partial, { animate: false });
    renderer.update(`${partial}\n\n[^one]: Note one.\n[^two]: Note two.`, {
      animate: false,
      finalize: true,
    });

    expect(
      [...root.querySelectorAll("a[data-footnote-ref]")].map((reference) => reference.textContent),
    ).toEqual(["1", "2"]);
    expect(root.querySelectorAll("section[data-footnotes] ol > li")).toHaveLength(2);
    expect(root.querySelectorAll("section[data-footnotes]")).toHaveLength(1);
  });

  it("preserves an old paragraph and selection when a later bold span closes", () => {
    renderer.update("Stable selected paragraph.\n\nNext **bold", { animate: false });
    const oldParagraph = root.querySelector("p")!;
    const range = document.createRange();
    range.setStart(oldParagraph.firstChild!, 7);
    range.setEnd(oldParagraph.firstChild!, 15);
    const selection = document.getSelection()!;
    selection.addRange(range);
    expect(selection.toString()).toBe("selected");

    renderer.update("Stable selected paragraph.\n\nNext **bold** ending.", {
      animate: false,
      finalize: true,
    });
    renderer.settleEffects();

    expect(root.querySelector("p")).toBe(oldParagraph);
    expect(root.querySelector("strong")?.textContent).toBe("bold");
    expect(root.querySelectorAll("p")[1]?.textContent).toBe("Next bold ending.");
    expect(selection.toString()).toBe("selected");
    expect(root.contains(selection.anchorNode)).toBe(true);
    expect(root.contains(selection.focusNode)).toBe(true);
  });

  it("preserves selection within a paragraph while appending text to that same paragraph", () => {
    renderer.update("Selected text", { animate: false });
    const paragraph = root.querySelector("p")!;
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 0);
    range.setEnd(paragraph.firstChild!, 8);
    const selection = document.getSelection()!;
    selection.addRange(range);

    renderer.update("Selected text continues without moving the selection.", {
      animate: false,
      finalize: true,
    });
    renderer.settleEffects();

    expect(root.querySelector("p")).toBe(paragraph);
    expect(paragraph.textContent).toBe("Selected text continues without moving the selection.");
    expect(selection.toString()).toBe("Selected");
    expect(selection.anchorOffset).toBe(0);
    expect(selection.focusOffset).toBe(8);
  });

  it("reconciles rewritten and shortened snapshots and makes finalization idempotent", () => {
    renderer.update("Retained paragraph.\n\nDiscard this old tail.", { animate: false });
    const retained = root.querySelector("p");
    renderer.update("Retained paragraph.\n\nReplacement tail.", { animate: false });
    expect(root.querySelector("p")).toBe(retained);
    expect(root.querySelectorAll("p")[1]?.textContent).toBe("Replacement tail.");

    const finalSource = "Retained paragraph.";
    renderer.update(finalSource, { animate: false, finalize: true });
    expect(root.querySelector("p")).toBe(retained);
    expect(root.querySelectorAll("p")).toHaveLength(1);
    renderer.update(finalSource, { animate: false, finalize: true });
    renderer.settleEffects();
    renderer.settleEffects();
    expect(renderer.source).toBe(finalSource);
    expect(root.querySelector("p")).toBe(retained);
    expect(root.textContent).toBe(finalSource);
    expect(renderer.activeEffects).toBe(false);
  });

  it("retains running ink and selected prose through semantic changes, finalization and retirement", async () => {
    let time = 1_000;
    const timeline = Object.getOwnPropertyDescriptor(document, "timeline");
    const animate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
    const effects = new Map<HTMLElement, { animation: Animation; finish: () => void }>();
    Object.defineProperty(document, "timeline", {
      configurable: true,
      value: {
        get currentTime() {
          return time;
        },
      },
    });
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value(this: HTMLElement) {
        let finish!: () => void;
        const finished = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const animation = { startTime: null, finished, cancel() {} } as unknown as Animation;
        effects.set(this, { animation, finish });
        return animation;
      },
    });
    try {
      renderer.update("Selected prefix.\n\nNext **bold", { animate: true });
      const paragraph = root.querySelector("p")!;
      const selection = document.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      selection.addRange(range);
      const running = [...paragraph.querySelectorAll<HTMLElement>(".markdown-ink-glyph")].map(
        (span) => ({
          span,
          effect: effects.get(span)!,
          start: effects.get(span)!.animation.startTime,
        }),
      );
      expect(running.length).toBeGreaterThan(0);

      time += 50;
      const source = "Selected prefix.\n\nNext **bold** ending.";
      renderer.update(source, { animate: true });
      renderer.update(source, { animate: true, finalize: true });
      expect(root.querySelector("p")).toBe(paragraph);
      expect(root.querySelector("strong")?.textContent).toBe("bold");
      expect(selection.toString()).toBe("Selected prefix.");
      for (const { span, effect, start } of running) {
        expect(paragraph.contains(span)).toBe(true);
        expect(effects.get(span)).toBe(effect);
        expect(effect.animation.startTime).toBe(start);
      }

      for (const effect of effects.values()) effect.finish();
      await Promise.all([...effects.values()].map((effect) => effect.animation.finished));
      expect(root.querySelectorAll(".markdown-ink-glyph")).toHaveLength(0);
      expect(root.textContent).toBe("Selected prefix.\nNext bold ending.");
      expect(selection.toString()).toBe("Selected prefix.");
      expect(root.querySelector("p")).toBe(paragraph);

      time += 300;
      renderer.update(`${source} More.`, { animate: true, finalize: true });
      expect(paragraph.querySelector(".markdown-ink-glyph")).toBeNull();
      expect(root.textContent).toBe("Selected prefix.\nNext bold ending. More.");
      expect(selection.toString()).toBe("Selected prefix.");
      expect(
        [...root.querySelectorAll(".markdown-ink-glyph")]
          .map((glyph) => glyph.textContent)
          .join(""),
      ).toBe("More.");
    } finally {
      if (timeline) Object.defineProperty(document, "timeline", timeline);
      else Reflect.deleteProperty(document, "timeline");
      if (animate) Object.defineProperty(HTMLElement.prototype, "animate", animate);
      else Reflect.deleteProperty(HTMLElement.prototype, "animate");
    }
  });

  it("keeps code and table text clear without introducing animation wrappers", () => {
    renderer.update("`inline code`\n\n```js\nconst value = 1;\n```\n\n| A |\n| - |\n| B |", {
      animate: true,
      finalize: true,
    });

    expect(root.querySelector("p > code")?.textContent).toBe("inline code");
    expect(root.querySelector("pre > code")?.textContent).toBe("const value = 1;\n");
    expect(root.querySelector("th")?.textContent).toBe("A");
    expect(root.querySelector("td")?.textContent).toBe("B");
    for (const excluded of root.querySelectorAll("code, pre, table")) {
      expect(excluded.querySelector("span")).toBeNull();
    }
  });

  it("clears only the owned descendants on disposal", () => {
    renderer.update("A complete **document**.", { animate: false, finalize: true });
    renderer.dispose();
    expect(root.childNodes).toHaveLength(0);
    expect(root.className).toBe("markdown-body");
    expect(renderer.activeEffects).toBe(false);
    renderer.dispose();
    expect(root.childNodes).toHaveLength(0);
  });
});
