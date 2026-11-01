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
    const rule = (title: string, bottom = false): string => {
      const label = title ? truncateTerminalText(` ${title} `, columns - 3) : "";
      const line = `${bottom ? "╰" : "╭"}─${label}${"─".repeat(Math.max(0, columns - visibleWidth(label) - 3))}${bottom ? "╯" : "╮"}`;
      return options.color ? `\x1b[2m${line}\x1b[0m` : line;
    };
    const inset = (line: string): string => {
      const text = truncateTerminalText(line, columns - 4);
      return `│ ${text}${" ".repeat(Math.max(0, columns - 4 - visibleWidth(text)))} │`;
    };
    let composer: string[] = [];
    let composerCursor = 0;
    let composerColumn = 0;
    if (view && !view.selector) {
      const secret = view.prompt?.secret === true;
      const clusters = secret ? [] : graphemes(view.composer.draft.text);
      const body: string[] = [];
      const width = Math.max(1, columns - 4);
      let line = "";
      let used = 0;
      let position = 0;
      let column = 0;
      // 光标与正文共用同一次字素布局，避免宽字符在边界换行后光标仍留在上一行。
      for (let index = 0; index <= clusters.length; index += 1) {
        const cluster = clusters[index];
        const text = cluster === "\t" ? " ".repeat(4 - (used % 4)) : safe(cluster ?? "");
        const size = visibleWidth(text);
        if (cluster !== "\n" && used > 0 && used + size > width) {
          body.push(line);
          line = "";
          used = 0;
        }
        if (index === (secret ? 0 : view.composer.draft.cursor)) {
          position = body.length;
          column = used;
        }
        if (cluster === undefined) break;
        if (cluster === "\n") {
          body.push(line);
          line = "";
          used = 0;
        } else {
          line += text;
          used += size;
        }
      }
      body.push(line);
      const promptLines = view.prompt ? wrapTerminalText(view.prompt.text, columns) : [];
      const promptBudget = Math.max(1, height - statuses.length - 3);
      const prompt =
        promptLines.length <= promptBudget
          ? promptLines
          : [...promptLines.slice(0, promptBudget - 1), promptLines[promptLines.length - 1]!];
      const reserve = view.interaction || selectedTool || previews.length > 0 ? 3 : 2;
      const max = Math.max(
        1,
        Math.min(3, Math.floor(height / 3), height - statuses.length - prompt.length - reserve - 2),
      );
      const offset = Math.max(0, Math.min(position - max + 1, body.length - max));
      const title = view.prompt
        ? secret
          ? "安全输入 · 隐藏输入"
          : "确认输入"
        : view.phase === "idle" && view.composer.submission.enabled
          ? "输入"
          : "草稿 · 暂不发送";
      composer = [
        ...prompt,
        rule(title),
        ...body.slice(offset, offset + max).map(inset),
        rule("", true),
      ];
      composerCursor = prompt.length + 1 + Math.max(0, position - offset);
      composerColumn = 2 + column;
    }
    const available = Math.max(0, height - statuses.length - composer.length);
    const content: string[] = [];
    if (view?.selector) {
      const selector = view.selector;
      const selected = selector.items.findIndex((item) => item.id === selector.selectedId);
      const capacity = Math.max(1, available - 3);
      const start = Math.max(
        0,
        Math.min(selected - Math.floor(capacity / 2), selector.items.length - capacity),
      );
      content.push(rule(selector.title));
      content.push(truncateTerminalText(`搜索: ${selector.query || "输入以筛选"}`, columns));
      for (const item of selector.items.slice(start, start + capacity)) {
        const text = truncateTerminalText(
          `${item.id === selector.selectedId ? "›" : " "} ${item.label}${item.description ? ` — ${item.description}` : ""}`,
          columns,
        );
        content.push(
          options.color && item.id === selector.selectedId ? `\x1b[36m${text}\x1b[0m` : text,
        );
      }
      if (selector.items.length === 0) content.push("没有匹配项");
      content.push(
        truncateTerminalText(
          `${selected >= 0 ? selected + 1 : 0}/${selector.items.length} 项${start > 0 ? " · ↑ 上方更多" : ""}${start + capacity < selector.items.length ? " · ↓ 下方更多" : ""}`,
          columns,
        ),
      );
    } else if (view?.interaction) {
      const { reference, display } = view.interaction;
      content.push(truncateTerminalText(`待确认 · ${reference.interactionId}`, columns));
      if (display.support === "supported") {
        content.push(...wrapTerminalText(display.summary, columns));
        for (const choice of display.choices)
          content.push(
            ...wrapTerminalText(`${choice.id}: ${choice.label} (${choice.responseType})`, columns),
          );
        content.push(
          ...wrapTerminalText(
            display.confirmation === "interaction-id"
              ? "需要明确选择并确认交互 ID。"
              : "需要明确选择；仅按 Enter 不会批准。",
            columns,
          ),
        );
      } else {
        content.push(
          ...wrapTerminalText(
            `${reference.owner}/${reference.payloadType}@${reference.payloadVersion}`,
            columns,
          ),
          ...wrapTerminalText("不支持此交互；私有内容已隐藏，请使用支持的宿主回答。", columns),
        );
      }
    } else if (selectedTool && cards.has(selectedTool)) {
      const lines = toolCardLines(cards.get(selectedTool)!, columns, true);
      const summary = toolCardLines(cards.get(selectedTool)!, columns, false);
      const pinned = summary.slice(0, Math.max(1, available - 2));
      const pageSize = Math.max(1, available - pinned.length - 1);
      const details = lines.slice(pinned.length);
      const pages = Math.max(1, Math.ceil(details.length / pageSize));
      toolPages = pages;
      toolPage = Math.min(toolPage, pages - 1);
      content.push(...pinned, ...details.slice(toolPage * pageSize, (toolPage + 1) * pageSize));
      content.push(
        truncateTerminalText(`详情 ${toolPage + 1}/${pages} · Ctrl+O 翻页/收起`, columns),
      );
    } else {
      for (const preview of previews) {
        content.push(
          truncateTerminalText(
            `生成预览 · 步骤 ${preview.step}${preview.truncated ? " · 仅保留尾部" : ""}`,
            columns,
          ),
        );
        content.push(...markdownLines(preview.text, columns, true));
      }
      if (previews.length > 0)
        content.push(truncateTerminalText("预览尚未提交，以最终结果为准", columns));
      const latest = latestTool ? cards.get(latestTool) : undefined;
      if (latest) content.push(...toolCardLines(latest, columns, false));
      if (content.length === 0 && view && !view.prompt) {
        content.push(
          truncateTerminalText(
            view.phase === "idle" && view.composer.submission.enabled
              ? "开始对话 · 描述任务，或输入 / 查看命令"
              : view.activity || "状态将在此更新；草稿不会自动发送",
            columns,
          ),
          "",
        );
      }
    }
    const visible =
      content.length <= available
        ? content
        : available === 0
          ? []
          : view?.interaction
            ? content
                .slice(0, Math.max(0, available - 1))
                .concat(truncateTerminalText("完整交互内容保留在历史中", columns))
            : view?.selector
              ? content.slice(0, available)
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
            ? [safe(view.prompt.text) + (view.prompt.secret ? " [隐藏输入]" : "")]
            : []),
          ...(view.prompt?.secret || view.selector ? [] : [`> ${safe(view.composer.draft.text)}`]),
          ...(view.selector
            ? [
                safe(view.selector.title),
                safe(`搜索: ${view.selector.query}`),
                ...view.selector.items.map((item) =>
                  safe(
                    `${item.id === view.selector?.selectedId ? ">" : " "} ${item.label}${item.description ? ` — ${item.description}` : ""}`,
                  ),
                ),
                `${view.selector.items.findIndex((item) => item.id === view.selector?.selectedId) + 1}/${view.selector.items.length} 项`,
              ]
            : []),
          ...(view.interaction
            ? [
                safe(`待确认: ${view.interaction.reference.interactionId}`),
                view.interaction.display.support === "supported"
                  ? safe(view.interaction.display.summary)
                  : "不支持此交互；私有内容已隐藏。",
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
