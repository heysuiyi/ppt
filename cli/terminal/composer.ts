import { layoutComposer } from "./composer-layout.js";
import type { Composer } from "./input-contract.js";
import type { TerminalDraft, TerminalEditorAction } from "./terminal-contract.js";
import { graphemes } from "./terminal-text.js";

export function createComposer(initial: TerminalDraft = { text: "", cursor: 0 }): Composer {
  let text = initial.text.replace(/\r\n?/g, "\n");
  let cells = graphemes(text);
  let cursor = Math.max(0, Math.min(cells.length, Math.trunc(initial.cursor) || 0));
  const history: TerminalDraft[] = [];
  let historyIndex = 0;
  let savedDraft: TerminalDraft | undefined;
  let preferredColumn: number | undefined;
  let columns = 80;

  function leaveHistory(): void {
    historyIndex = history.length;
    preferredColumn = undefined;
  }

  function moveCursor(next: number): void {
    if (next === cursor) return;
    cursor = next;
    leaveHistory();
  }

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
    leaveHistory();
  }

  function recall(direction: -1 | 1): void {
    if (history.length === 0) return;
    if (historyIndex === history.length) {
      if (direction > 0) return;
      savedDraft ??= { text, cursor };
    }
    historyIndex = Math.max(0, Math.min(history.length, historyIndex + direction));
    const draft = historyIndex === history.length ? savedDraft : history[historyIndex];
    if (!draft) return;
    text = draft.text;
    cells = graphemes(text);
    cursor = draft.cursor;
    preferredColumn = undefined;
    if (historyIndex === history.length) savedDraft = undefined;
  }

  function vertical(direction: -1 | 1): void {
    if (historyIndex < history.length) {
      recall(direction);
      return;
    }
    const layout = layoutComposer({ text, cursor }, columns);
    const current = layout.positions[cursor]!;
    const row = current.row + direction;
    if (row < 0 || row >= layout.lines.length) {
      recall(direction);
      return;
    }
    preferredColumn ??= current.column;
    let target: number | undefined;
    let distance = Infinity;
    for (let index = 0; index < layout.positions.length; index++) {
      const position = layout.positions[index]!;
      if (position.row !== row) continue;
      const nextDistance = Math.abs(position.column - preferredColumn);
      if (nextDistance < distance) {
        target = index;
        distance = nextDistance;
      }
    }
    if (target !== undefined) cursor = target;
  }

  return {
    get draft() {
      return { text, cursor };
    },
    setDraft,
    setColumns(next: number) {
      columns = Number.isFinite(next) ? Math.max(1, Math.floor(next)) : 1;
    },
    remember,
    clear(keep = false) {
      if (keep) remember();
      setDraft({ text: "", cursor: 0 });
    },
    edit(action: TerminalEditorAction) {
      switch (action.action) {
        case "insert":
          if (action.text) replace(cursor, 0, action.text.replace(/\r\n?/g, "\n"));
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
          moveCursor(Math.max(0, cursor - 1));
          break;
        case "right":
          moveCursor(Math.min(cells.length, cursor + 1));
          break;
        case "home": {
          let start = cursor;
          while (start > 0 && cells[start - 1] !== "\n") start--;
          moveCursor(start);
          break;
        }
        case "end": {
          let end = cursor;
          while (end < cells.length && cells[end] !== "\n") end++;
          moveCursor(end);
          break;
        }
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
