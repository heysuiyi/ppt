import type { Composer } from "./input-contract.js";
import type { TerminalDraft, TerminalEditorAction } from "./terminal-contract.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

export function createComposer(initial: TerminalDraft = { text: "", cursor: 0 }): Composer {
  let text = initial.text.replace(/\r\n?/g, "\n");
  let cells = graphemes(text);
  let cursor = Math.max(0, Math.min(cells.length, Math.trunc(initial.cursor) || 0));
  const history: TerminalDraft[] = [];
  let historyIndex = 0;
  let savedDraft: TerminalDraft | undefined;
  let preferredColumn: number | undefined;

  function setDraft(draft: TerminalDraft): void {
    text = draft.text.replace(/\r\n?/g, "\n");
    cells = graphemes(text);
    cursor = Math.max(0, Math.min(cells.length, Math.trunc(draft.cursor) || 0));
    historyIndex = history.length;
    savedDraft = undefined;
    preferredColumn = undefined;
  }

  function remember(): void {
    if (text && history.at(-1)?.text !== text) history.push({ text, cursor });
    historyIndex = history.length;
    savedDraft = undefined;
  }

  function replace(start: number, count: number, insertion: string): void {
    const prefix = cells.slice(0, start).join("") + insertion;
    text = prefix + cells.slice(start + count).join("");
    cells = graphemes(text);
    cursor = graphemes(prefix).length;
    historyIndex = history.length;
    savedDraft = undefined;
    preferredColumn = undefined;
  }

  function recall(direction: -1 | 1): void {
    if (history.length === 0) return;
    if (historyIndex === history.length) {
      if (direction > 0) return;
      savedDraft = { text, cursor };
    }
    historyIndex = Math.max(0, Math.min(history.length, historyIndex + direction));
    const draft = historyIndex === history.length ? savedDraft : history[historyIndex];
    if (!draft) return;
    text = draft.text;
    cells = graphemes(text);
    cursor = draft.cursor;
    preferredColumn = undefined;
  }

  function vertical(direction: -1 | 1): void {
    if (!cells.includes("\n")) {
      recall(direction);
      return;
    }
    let start = cursor;
    while (start > 0 && cells[start - 1] !== "\n") start--;
    preferredColumn ??= cursor - start;
    if (direction < 0) {
      if (start === 0) return;
      const end = start - 1;
      start = end;
      while (start > 0 && cells[start - 1] !== "\n") start--;
      cursor = Math.min(end, start + preferredColumn);
    } else {
      let end = cursor;
      while (end < cells.length && cells[end] !== "\n") end++;
      if (end === cells.length) return;
      start = end + 1;
      end = start;
      while (end < cells.length && cells[end] !== "\n") end++;
      cursor = Math.min(end, start + preferredColumn);
    }
  }

  return {
    get draft() {
      return { text, cursor };
    },
    setDraft,
    remember,
    clear(keep = false) {
      if (keep) remember();
      setDraft({ text: "", cursor: 0 });
    },
    edit(action: TerminalEditorAction) {
      if (action.action !== "up" && action.action !== "down") preferredColumn = undefined;
      switch (action.action) {
        case "insert":
          replace(cursor, 0, action.text.replace(/\r\n?/g, "\n"));
          break;
        case "newline":
          replace(cursor, 0, "\n");
          break;
        case "backspace":
          if (cursor > 0) replace(cursor - 1, 1, "");
          break;
        case "delete":
          if (cursor < cells.length) replace(cursor, 1, "");
          break;
        case "left":
          cursor = Math.max(0, cursor - 1);
          break;
        case "right":
          cursor = Math.min(cells.length, cursor + 1);
          break;
        case "home":
          while (cursor > 0 && cells[cursor - 1] !== "\n") cursor--;
          break;
        case "end":
          while (cursor < cells.length && cells[cursor] !== "\n") cursor++;
          break;
        case "up":
          vertical(-1);
          break;
        case "down":
          vertical(1);
          break;
        case "interrupt":
          remember();
          setDraft({ text: "", cursor: 0 });
          break;
        default:
          // Submission, focus and lifecycle belong to the controller, not the editor.
          break;
      }
    },
  };
}
