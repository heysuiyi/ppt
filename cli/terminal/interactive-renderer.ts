import { humanRecordOutput } from "./human-renderer.js";
import { encodeTerminalRecord } from "./jsonl-renderer.js";
import type {
  TerminalRenderer,
  TerminalRendererOptions,
  TerminalView,
} from "./renderer-contract.js";
import { statusLines } from "./status-line.js";
import type {
  TerminalSelectionItem,
  TerminalTextPreview,
  TerminalToolRecord,
} from "./terminal-contract.js";
import { sanitizeTerminalRecord } from "./terminal-projection.js";
import {
  graphemes,
  markdownLines,
  sanitizeTerminalText as safe,
  truncateTerminalText,
  visibleWidth,
  wrapTerminalText,
} from "./terminal-text.js";
import { toolCardId, toolCardLines, toolSelection, toolSummary } from "./tool-card.js";

interface Viewport {
  readonly lines: readonly string[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
  readonly showCursor: boolean;
}

export function createTerminalRenderer(options: TerminalRendererOptions): TerminalRenderer {
  let queue = Promise.resolve();
  let closed = false;
  let viewportRows = 0;
  let cursorRow = 0;
  let currentView: TerminalView | undefined;
  let previews: readonly TerminalTextPreview[] = [];
  let selectedTool: string | undefined;
  let latestTool: string | undefined;
  let usedTui = false;
  let toolPage = 0;
  let plainView = "";
  const cards = new Map<string, TerminalToolRecord>();
  const settledMessages = new Set<string>();
  let toolPages = 1;

  function enqueue(action: () => Promise<void>): Promise<void> {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  }

  function tuiAvailable(): boolean {
    return !closed && options.mode === "tui" && options.columns() >= 40 && options.rows() >= 12;
  }

  async function eraseViewport(): Promise<void> {
    if (viewportRows === 0) return;
    let text = "\x1b[?25l\r";
    if (cursorRow > 0) text += `\x1b[${cursorRow}A`;
    for (let row = 0; row < viewportRows; row += 1) {
      text += "\x1b[2K";
      if (row < viewportRows - 1) text += "\x1b[1B\r";
    }
    if (viewportRows > 1) text += `\x1b[${viewportRows - 1}A`;
    text += "\r";
    viewportRows = 0;
    cursorRow = 0;
    await options.writeOutput(text);
  }

  function composeViewport(): Viewport {
    const columns = Math.max(1, options.columns() - 1);
    const height = Math.max(1, options.rows() - 1);
    const view = currentView;
    const statuses = view ? statusLines(view, columns) : [];
    let composer: string[] = [];
    let composerCursor = 0;
    let composerColumn = 0;
    if (view) {
      const clusters = graphemes(view.composer.draft.text);
      const prefix = clusters.slice(0, view.composer.draft.cursor).join("");
      const secret = view.prompt?.secret === true;
      const text = secret ? "" : view.composer.draft.text;
      const before = secret ? "" : prefix;
      const body = wrapTerminalText(text, Math.max(1, columns - 2));
      const prior = wrapTerminalText(before, Math.max(1, columns - 2));
      const position = prior.length - 1;
      const max = Math.max(1, Math.floor(height / 3));
      const offset = Math.max(0, Math.min(position - max + 1, body.length - max));
      composer = body
        .slice(offset, offset + max)
        .map((line, index) => `${offset + index === 0 ? "> " : "  "}${line}`);
      composerCursor = Math.max(0, position - offset);
      composerColumn = Math.min(columns, 2 + visibleWidth(prior[prior.length - 1] ?? ""));
      if (view.prompt)
        composer.unshift(
          truncateTerminalText(view.prompt.text + (secret ? " [hidden]" : ""), columns),
        );
      if (view.prompt) composerCursor += 1;
    }
    const available = Math.max(0, height - statuses.length - composer.length);
    const content: string[] = [];
    if (view?.selector) {
      const selector = view.selector;
      content.push(truncateTerminalText(`${selector.title} | search: ${selector.query}`, columns));
      const selected = selector.items.findIndex((item) => item.id === selector.selectedId);
      const capacity = Math.max(1, available - 2);
      const start = Math.max(
        0,
        Math.min(selected - Math.floor(capacity / 2), selector.items.length - capacity),
      );
      for (const item of selector.items.slice(start, start + capacity)) {
        content.push(
          truncateTerminalText(
            `${item.id === selector.selectedId ? ">" : " "} ${item.label}${item.description ? ` — ${item.description}` : ""}`,
            columns,
          ),
        );
      }
      if (selector.items.length === 0) content.push("No matching choices.");
      content.push(truncateTerminalText("↑/↓ select · Enter confirm · Esc back", columns));
    } else if (view?.interaction) {
      const { reference, display } = view.interaction;
      content.push(...wrapTerminalText(`Waiting: ${reference.interactionId}`, columns));
      content.push(
        ...wrapTerminalText(
          `${reference.owner}/${reference.payloadType}@${reference.payloadVersion}`,
          columns,
        ),
      );
      if (display.support === "supported") {
        content.push(...wrapTerminalText(display.summary, columns));
        for (const choice of display.choices)
          content.push(
            ...wrapTerminalText(`${choice.id}: ${choice.label} (${choice.responseType})`, columns),
          );
        content.push(
          ...wrapTerminalText(
            display.confirmation === "interaction-id"
              ? "Explicit choice and interaction ID confirmation required."
              : "Explicit choice required; Enter alone does not approve.",
            columns,
          ),
        );
      } else
        content.push(
          ...wrapTerminalText(
            "Unsupported interaction. Private payload withheld; use a supported host to answer.",
            columns,
          ),
        );
    } else if (selectedTool && cards.has(selectedTool)) {
      const lines = toolCardLines(cards.get(selectedTool)!, columns, true);
      const summary = toolCardLines(cards.get(selectedTool)!, columns, false);
      const pageSize = Math.max(1, available - summary.length - 1);
      const details = lines.slice(summary.length);
      const pages = Math.max(1, Math.ceil(details.length / pageSize));
      toolPages = pages;
      toolPage = Math.min(toolPage, pages - 1);
      content.push(...summary, ...details.slice(toolPage * pageSize, (toolPage + 1) * pageSize));
      content.push(
        truncateTerminalText(`Details ${toolPage + 1}/${pages} · Ctrl+O next/collapse`, columns),
      );
    } else {
      for (const preview of previews) {
        content.push(
          truncateTerminalText(
            `Preview · step ${preview.step} · ${preview.requestId} · part ${preview.contentIndex}${preview.truncated ? " · tail only; final result is authoritative" : " · not committed"}`,
            columns,
          ),
        );
        content.push(...markdownLines(preview.text, columns, true));
      }
      if (previews.length > 0)
        content.push(
          truncateTerminalText(
            previews.some((item) => item.truncated)
              ? "Preview tail only; final result authoritative"
              : "Preview only; not committed",
            columns,
          ),
        );
      const latest = latestTool ? cards.get(latestTool) : undefined;
      if (latest) content.push(...toolCardLines(latest, columns, false));
    }
    const visible =
      content.length <= available
        ? content
        : available === 0
          ? []
          : view?.interaction
            ? content
                .slice(0, Math.max(0, available - 1))
                .concat(
                  truncateTerminalText("More interaction text is retained in history.", columns),
                )
            : content.slice(-available);
    const lines = [...visible, ...composer, ...statuses].slice(0, height);
    if (lines.length === 0) lines.push("");
    return {
      lines,
      cursorRow: Math.min(lines.length - 1, visible.length + composerCursor),
      cursorColumn: composerColumn,
      showCursor: !!view && (view.composer.editable || !!view.prompt) && !view.selector,
    };
  }

  async function redraw(): Promise<void> {
    if (!tuiAvailable()) {
      const hadViewport = viewportRows > 0;
      await eraseViewport();
      if (hadViewport) await options.writeOutput("\x1b[?25h");
      if (!closed && (options.mode === "plain" || options.mode === "tui") && currentView) {
        const view = currentView;
        const text = [
          ...statusLines(view, Math.max(40, options.columns())),
          ...(view.prompt
            ? [safe(view.prompt.text) + (view.prompt.secret ? " [hidden]" : "")]
            : []),
          ...(view.prompt?.secret ? [] : [`> ${safe(view.composer.draft.text)}`]),
          ...(view.selector
            ? [
                safe(view.selector.title),
                ...view.selector.items.map((item) =>
                  safe(
                    `${item.id === view.selector?.selectedId ? ">" : " "} ${item.label}${item.description ? ` — ${item.description}` : ""}`,
                  ),
                ),
              ]
            : []),
          ...(view.interaction
            ? [
                safe(`Waiting: ${view.interaction.reference.interactionId}`),
                view.interaction.display.support === "supported"
                  ? safe(view.interaction.display.summary)
                  : "Unsupported interaction; private payload withheld.",
              ]
            : []),
        ].join("\n");
        if (text !== plainView) {
          plainView = text;
          await options.writeError(`${text}\n`);
        }
      }
      return;
    }
    plainView = "";
    usedTui = true;
    await eraseViewport();
    const viewport = composeViewport();
    let text = `\x1b[?25l${viewport.lines.join("\r\n")}`;
    const bottom = viewport.lines.length - 1;
    if (bottom > viewport.cursorRow) text += `\x1b[${bottom - viewport.cursorRow}A`;
    text += `\r${viewport.cursorColumn > 0 ? `\x1b[${viewport.cursorColumn}C` : ""}`;
    if (viewport.showCursor) text += "\x1b[?25h";
    viewportRows = viewport.lines.length;
    cursorRow = viewport.cursorRow;
    await options.writeOutput(text);
  }

  async function appendHistory(text: string, markdown = false): Promise<void> {
    await eraseViewport();
    const lines = markdown
      ? markdownLines(text, Math.max(1, options.columns() - 1))
      : wrapTerminalText(text, Math.max(1, options.columns() - 1));
    await options.writeOutput(`${lines.join("\r\n")}\r\n`);
    await redraw();
  }

  return {
    record(record) {
      return enqueue(async () => {
        const projected = sanitizeTerminalRecord(record);
        if (projected.type === "assistant.message") {
          const key = JSON.stringify([
            projected.identity.agentId,
            projected.identity.threadId,
            projected.identity.queryId,
            projected.messageIndex,
          ]);
          if (settledMessages.has(key)) return;
          settledMessages.add(key);
          previews = [];
        }
        if (projected.type === "query.result" || projected.type === "error") previews = [];
        if (projected.type === "tool") {
          latestTool = toolCardId(projected);
          cards.set(latestTool, projected);
        }
        if (options.mode === "jsonl") {
          await options.writeOutput(encodeTerminalRecord(projected));
          return;
        }
        const human = humanRecordOutput(projected);
        if (tuiAvailable()) {
          if (projected.type === "assistant.message")
            await appendHistory(projected.content.map((part) => part.text).join(""), true);
          else if (projected.type === "tool") await appendHistory(toolSummary(projected));
          else if (human.error) await appendHistory(human.error.trimEnd());
          else await redraw();
        } else {
          if (viewportRows > 0) await redraw();
          if (human.output) await options.writeOutput(human.output);
          if (human.error) await options.writeError(human.error);
        }
      });
    },
    preview(next) {
      return enqueue(async () => {
        if (closed || options.mode !== "tui") return;
        previews = next;
        await redraw();
      });
    },
    view(next) {
      return enqueue(async () => {
        if (closed) return;
        currentView = next;
        await redraw();
      });
    },
    user(text) {
      return enqueue(async () => {
        if (closed || options.mode === "jsonl" || options.mode === "print") return;
        if (tuiAvailable()) await appendHistory(`You: ${safe(text)}`);
        else await options.writeError(`You: ${safe(text)}\n`);
      });
    },
    history(messages) {
      return enqueue(async () => {
        if (closed || options.mode === "jsonl" || options.mode === "print") return;
        for (const message of messages) {
          if (tuiAvailable())
            await appendHistory(
              `${message.role === "user" ? "You" : "Assistant"}: ${safe(message.text)}`,
              message.role === "assistant",
            );
          else await options.writeError(`${message.role}: ${safe(message.text)}\n`);
        }
      });
    },
    message(text) {
      return enqueue(async () => {
        if (tuiAvailable()) await appendHistory(safe(text));
        else await options.writeError(`${safe(text)}\n`);
      });
    },
    toggleTool() {
      return enqueue(async () => {
        if (closed) return;
        const latest = latestTool;
        if (!latest) return;
        if (!selectedTool) {
          selectedTool = latest;
          toolPage = 0;
        } else {
          if (toolPage + 1 < toolPages) toolPage += 1;
          else {
            selectedTool = undefined;
            toolPage = 0;
          }
        }
        if (tuiAvailable()) await redraw();
        else if (selectedTool)
          await options.writeError(
            `${toolCardLines(cards.get(selectedTool)!, Math.max(40, options.columns()), true).join("\n")}\n`,
          );
      });
    },
    tools(): readonly TerminalSelectionItem[] {
      return Array.from(cards.values(), toolSelection);
    },
    selectTool(id) {
      return enqueue(async () => {
        if (closed || !cards.has(id)) return;
        selectedTool = id;
        toolPage = 0;
        if (tuiAvailable()) await redraw();
        else
          await options.writeError(
            `${toolCardLines(cards.get(id)!, Math.max(40, options.columns()), true).join("\n")}\n`,
          );
      });
    },
    close() {
      return enqueue(async () => {
        if (closed) return;
        await eraseViewport();
        closed = true;
        previews = [];
        if (usedTui) await options.writeOutput("\x1b[?25h");
      });
    },
  };
}
