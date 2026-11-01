import { layoutComposer } from "./composer-layout.js";
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

interface PreviewBatch {
  next: readonly TerminalTextPreview[];
  timer?: NodeJS.Timeout;
}

function queryKey(identity: TerminalTextPreview["identity"]): string {
  return JSON.stringify([identity.agentId, identity.threadId, identity.queryId, identity.runId]);
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
  let cachedViewport: Viewport | undefined;
  let cachedSize: { columns: number; rows: number } | undefined;
  let previewBatch: PreviewBatch | undefined;
  const archivedInteractions = new Set<string>();
  const endedQueries = new Set<string>();
  const archivedPrompts = new Set<string>();
  let previewGeneration = 0;
  let closing = false;

  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  function dimensions(): { columns: number; rows: number } {
    return { columns: options.columns(), rows: options.rows() };
  }

  function tuiAvailable(size = dimensions()): boolean {
    return !closed && options.mode === "tui" && size.columns >= 40 && size.rows >= 12;
  }

  function discardPreview(): void {
    previewGeneration += 1;
    const batch = previewBatch;
    previewBatch = undefined;
    if (batch?.timer) clearTimeout(batch.timer);
    previews = [];
  }

  function schedulePreview(batch: PreviewBatch, generation: number): void {
    batch.timer = setTimeout(() => {
      batch.timer = undefined;
      void enqueue(async () => {
        if (closed || generation !== previewGeneration || previewBatch !== batch) return;
        const next = batch.next;
        previews = next.filter((part) => !endedQueries.has(queryKey(part.identity)));
        await redraw();
        if (previewBatch !== batch) return;
        if (batch.next === next) previewBatch = undefined;
        else schedulePreview(batch, generation);
      }).catch((error: unknown) => {
        if (previewBatch === batch) previewBatch = undefined;
        options.onOutputError(error);
      });
    }, 16);
  }

  function interactionLines(
    view: NonNullable<TerminalView["interaction"]>,
    columns: number,
  ): string[] {
    const { reference, display } = view;
    const lines = [`待确认 · ${reference.interactionId}`];
    if (display.support === "supported") {
      lines.push(display.summary);
      for (const choice of display.choices)
        lines.push(`${choice.id}: ${choice.label} (${choice.responseType})`);
      lines.push(
        display.confirmation === "interaction-id"
          ? `需要明确选择，并输入完整交互 ID：${reference.interactionId}`
          : "需要明确选择；仅按 Enter 不会批准。",
      );
    } else {
      lines.push(
        `${reference.owner}/${reference.payloadType}@${reference.payloadVersion}`,
        "不支持此交互；私有内容已隐藏，请使用支持的宿主回答。",
      );
    }
    return lines.flatMap((line) => wrapTerminalText(line, columns));
  }

  async function eraseViewport(): Promise<void> {
    if (viewportRows === 0) return;
    cachedViewport = undefined;
    cachedSize = undefined;
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

  function composeViewport(size: { columns: number; rows: number }): Viewport {
    const columns = Math.max(1, size.columns - 1);
    const height = Math.max(1, size.rows - 1);
    const view = currentView;
    let statuses = view ? statusLines(view, columns) : [];
    const minimumInput = view && !view.selector ? 3 + (view.prompt ? 2 : 0) : 0;
    const minimumPanel = view?.interaction
      ? view.selector
        ? 6
        : view.completion
          ? 7
          : 3
      : view?.completion
        ? 4
        : 0;
    const statusBudget = Math.max(1, height - minimumInput - minimumPanel);
    if (statuses.length > statusBudget)
      statuses =
        statusBudget === 1
          ? statuses.slice(-1)
          : [...statuses.slice(0, statusBudget - 1), ...statuses.slice(-1)];
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
      const layout = layoutComposer(
        secret ? { text: "", cursor: 0 } : view.composer.draft,
        Math.max(1, size.columns - 5),
      );
      const body = layout.lines;
      const position = layout.cursorRow;
      const column = layout.cursorColumn;
      const promptLines = view.prompt ? wrapTerminalText(view.prompt.text, columns) : [];
      const promptBudget = Math.max(1, height - statuses.length - 3);
      const prompt =
        promptLines.length <= promptBudget
          ? promptLines
          : [
              ...promptLines.slice(0, Math.max(1, promptBudget - 2)),
              ...(promptBudget > 2 ? [truncateTerminalText("… 完整提示可回看历史", columns)] : []),
              ...(promptBudget > 1 ? [promptLines[promptLines.length - 1]!] : []),
            ];
      const reserve = view.completion
        ? 4
        : view.interaction || selectedTool || previews.length > 0
          ? 3
          : 2;
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
    if (view?.interaction) {
      const { reference, display } = view.interaction;
      const budget = Math.max(1, available - (view.selector ? 3 : view.completion ? 4 : 0));
      const summary =
        display.support === "supported"
          ? wrapTerminalText(display.summary, columns)
          : wrapTerminalText(
              `${reference.owner}/${reference.payloadType}@${reference.payloadVersion}`,
              columns,
            );
      const ruleText =
        display.support === "supported"
          ? display.confirmation === "interaction-id"
            ? "明确选择 + 完整交互 ID；Enter 不批准"
            : "需要明确选择；Enter 不会批准"
          : "未知交互：私有内容隐藏，不可批准";
      const full = interactionLines(view.interaction, columns);
      if (!view.selector && !view.completion && full.length <= budget) content.push(...full);
      else
        content.push(
          ...summary.slice(0, Math.max(1, budget - 2)),
          ...(budget > 1 ? [truncateTerminalText(ruleText, columns)] : []),
          ...(budget > 2
            ? [truncateTerminalText("完整摘要、选项及 ID 已保留在上方历史", columns)]
            : []),
        );
    }
    if (view?.selector || view?.completion) {
      const selector = view.selector ?? view.completion!;
      const selectorAvailable = Math.max(1, available - content.length);
      const navigation = selector.navigation;
      if (navigation) {
        const items = selector.items.filter((item) => item.id !== navigation.action.id);
        const selectedModel = items.findIndex((item) => item.id === selector.selectedId);
        const selectedGroup = navigation.groups.findIndex(
          (item) => item.id === navigation.selectedGroupId,
        );
        const capacity = Math.max(1, selectorAvailable - 5);
        const offset = (selected: number, length: number): number =>
          Math.max(0, Math.min(selected - Math.floor(capacity / 2), length - capacity));
        const modelStart = offset(selectedModel, items.length);
        const groupStart = offset(selectedGroup, navigation.groups.length);
        const rowText = (item: TerminalSelectionItem | undefined, selected: boolean): string =>
          item
            ? `${selected ? "›" : " "} ${item.label}${item.description ? ` — ${item.description}` : ""}`
            : "";
        const highlight = (text: string, selected: boolean): string =>
          options.color && selected ? `\x1b[36m${text}\x1b[0m` : text;
        content.push(rule(selector.title));
        content.push(
          truncateTerminalText(
            `搜索模型: ${selector.query || "输入以筛选 · All 搜索全部"}`,
            columns,
          ),
        );
        if (size.columns >= 80) {
          const leftWidth = Math.min(26, Math.floor(columns / 3));
          const rightWidth = Math.max(1, columns - leftWidth - 3);
          const pair = (left: string, right: string): string => {
            const cell = truncateTerminalText(left, leftWidth);
            return `${cell}${" ".repeat(Math.max(0, leftWidth - visibleWidth(cell)))} │ ${truncateTerminalText(right, rightWidth)}`;
          };
          content.push(
            pair(
              `${navigation.pane === "groups" ? "›" : " "} 厂商连接`,
              `${navigation.pane === "models" ? "›" : " "} 模型`,
            ),
          );
          for (let index = 0; index < capacity; index++) {
            const group = navigation.groups[groupStart + index];
            const model = items[modelStart + index];
            if (!group && !model && index > 0) break;
            const groupActive = group?.id === navigation.selectedGroupId;
            const modelActive = model?.id === selector.selectedId;
            content.push(
              highlight(
                pair(
                  rowText(group, groupActive),
                  model
                    ? rowText(model, modelActive && navigation.pane === "models")
                    : index === 0
                      ? "没有匹配模型"
                      : "",
                ),
                (groupActive && navigation.pane === "groups") ||
                  (modelActive && navigation.pane === "models"),
              ),
            );
          }
        } else {
          const group = navigation.groups[selectedGroup];
          content.push(
            truncateTerminalText(
              navigation.pane === "groups"
                ? "› 厂商连接 · Enter 返回模型"
                : `› 模型 · ${group?.label ?? "All"}`,
              columns,
            ),
          );
          const list = navigation.pane === "groups" ? navigation.groups : items;
          const start = navigation.pane === "groups" ? groupStart : modelStart;
          const selected =
            navigation.pane === "groups" ? navigation.selectedGroupId : selector.selectedId;
          for (const item of list.slice(start, start + capacity))
            content.push(
              highlight(
                truncateTerminalText(rowText(item, item.id === selected), columns),
                item.id === selected,
              ),
            );
          if (!list.length) content.push("没有匹配模型");
        }
        const actionSelected =
          selector.selectedId === navigation.action.id && navigation.pane === "models";
        content.push(
          highlight(
            truncateTerminalText(rowText(navigation.action, actionSelected), columns),
            actionSelected,
          ),
          truncateTerminalText(
            `连接 ${selectedGroup + 1}/${navigation.groups.length} · 模型 ${selectedModel + 1}/${items.length}${modelStart > 0 || modelStart + capacity < items.length ? " · ↑↓ 更多" : ""}`,
            columns,
          ),
        );
      } else {
        const selected = selector.items.findIndex((item) => item.id === selector.selectedId);
        const capacity = Math.max(1, selectorAvailable - (view.interaction ? 2 : 3));
        const start = Math.max(
          0,
          Math.min(selected - Math.floor(capacity / 2), selector.items.length - capacity),
        );
        content.push(rule(selector.title));
        if (!view.interaction)
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
      }
    } else if (view?.interaction) {
      // The safe approval summary above remains visible alongside its active input.
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
        truncateTerminalText(`详情 ${toolPage + 1}/${pages} · Ctrl+O 翻页 · Escape 收起`, columns),
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
          : view?.interaction || view?.selector || view?.completion
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
    const size = dimensions();
    if (!tuiAvailable(size)) {
      const hadViewport = viewportRows > 0;
      await eraseViewport();
      if (hadViewport) await options.writeOutput("\x1b[?25h");
      if (!closed && (options.mode === "plain" || options.mode === "tui") && currentView) {
        const view = currentView;
        const text = [
          ...statusLines(view, Math.max(40, size.columns)),
          ...(view.prompt
            ? [safe(view.prompt.text) + (view.prompt.secret ? " [隐藏输入]" : "")]
            : []),
          ...(view.prompt?.secret || view.selector ? [] : [`> ${safe(view.composer.draft.text)}`]),
          ...(view.selector || view.completion
            ? (() => {
                const selector = (view.selector ?? view.completion)!;
                const navigation = selector.navigation;
                const groups = navigation?.pane === "groups";
                const items = groups && navigation ? navigation.groups : selector.items;
                const selected =
                  groups && navigation ? navigation.selectedGroupId : selector.selectedId;
                return [
                  safe(selector.title),
                  ...(navigation
                    ? [
                        safe(
                          `当前连接组: ${navigation.groups.find((item) => item.id === navigation.selectedGroupId)?.label ?? "All"} · 焦点: ${groups ? "连接组" : "模型"}`,
                        ),
                        "输入序号或 ID + Enter；/groups 选组，/connect 添加/配置，/back 返回，/cancel 退出。",
                      ]
                    : []),
                  ...(groups && navigation
                    ? [`${safe(navigation.action.label)} · 输入 /connect`]
                    : []),
                  safe(`搜索: ${selector.query}`),
                  ...items.map((item, index) =>
                    safe(
                      `${item.id === selected ? ">" : " "} ${index + 1}. ${item.label}${item.description ? ` — ${item.description}` : ""}`,
                    ),
                  ),
                  `${items.findIndex((item) => item.id === selected) + 1}/${items.length} 项`,
                ];
              })()
            : []),
          ...(view.interaction
            ? interactionLines(view.interaction, Math.max(40, size.columns))
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
    const resized =
      cachedSize && (cachedSize.columns !== size.columns || cachedSize.rows !== size.rows);
    if (resized) await eraseViewport();
    const viewport = composeViewport(size);
    const previous = cachedViewport;
    const sameContent =
      previous?.lines.length === viewport.lines.length &&
      previous.lines.every((line, index) => line === viewport.lines[index]);
    if (
      sameContent &&
      previous.cursorRow === viewport.cursorRow &&
      previous.cursorColumn === viewport.cursorColumn &&
      previous.showCursor === viewport.showCursor
    )
      return;
    let text = "";
    let row = cursorRow;
    const move = (target: number): void => {
      text += "\r";
      if (target < row) text += `\x1b[${row - target}A`;
      else if (target > row) text += `\x1b[${target - row}B`;
      row = target;
    };
    if (!sameContent) {
      text += "\x1b[?25l";
      move(0);
      const count = Math.max(viewportRows, viewport.lines.length);
      for (let index = 0; index < count; index += 1) {
        if (index > 0) {
          text += "\r\n";
          row += 1;
        }
        if (!previous || previous.lines[index] !== viewport.lines[index])
          text += `\x1b[2K${viewport.lines[index] ?? ""}`;
      }
    }
    move(viewport.cursorRow);
    if (viewport.cursorColumn > 0) text += `\x1b[${viewport.cursorColumn}C`;
    if (!sameContent || previous?.showCursor !== viewport.showCursor)
      text += viewport.showCursor ? "\x1b[?25h" : "\x1b[?25l";
    await options.writeOutput(text);
    viewportRows = viewport.lines.length;
    cursorRow = viewport.cursorRow;
    cachedViewport = viewport;
    cachedSize = size;
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
      discardPreview();
      return enqueue(async () => {
        const projected = sanitizeTerminalRecord(record);
        if (projected.type === "query.result") endedQueries.add(queryKey(projected.identity));
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
          else if (projected.type === "query.result" && projected.status === "completed")
            await appendHistory(`Query ${projected.status}`);
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
      if (closing || closed || options.mode !== "tui") return Promise.resolve();
      if (next.length === 0) {
        discardPreview();
        return enqueue(redraw);
      }
      const filtered = next.filter((part) => !endedQueries.has(queryKey(part.identity)));
      if (filtered.length === 0) return Promise.resolve();
      if (previewBatch) {
        previewBatch.next = filtered;
        return Promise.resolve();
      }
      const batch: PreviewBatch = { next: filtered };
      previewBatch = batch;
      schedulePreview(batch, previewGeneration);
      return Promise.resolve();
    },
    view(next) {
      return enqueue(async () => {
        if (closed) return;
        currentView = next;
        if (next.interaction && options.mode === "tui") {
          const key = JSON.stringify([next.interaction.reference, next.interaction.display]);
          if (!archivedInteractions.has(key)) {
            archivedInteractions.add(key);
            if (tuiAvailable())
              await appendHistory(
                interactionLines(next.interaction, Math.max(1, options.columns() - 1)).join("\n"),
              );
          }
        }
        if (next.prompt && options.mode === "tui" && !archivedPrompts.has(next.prompt.text)) {
          archivedPrompts.add(next.prompt.text);
          if (tuiAvailable()) await appendHistory(next.prompt.text);
        }
        await redraw();
      });
    },
    user(text) {
      discardPreview();
      return enqueue(async () => {
        if (closed || options.mode === "jsonl" || options.mode === "print") return;
        if (tuiAvailable()) await appendHistory(`You: ${safe(text)}`);
        else await options.writeError(`You: ${safe(text)}\n`);
      });
    },
    history(messages) {
      discardPreview();
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
      discardPreview();
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
    dismissTool() {
      return enqueue(async () => {
        if (!selectedTool) return false;
        selectedTool = undefined;
        toolPage = 0;
        if (!closed) await redraw();
        return true;
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
      closing = true;
      discardPreview();
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
