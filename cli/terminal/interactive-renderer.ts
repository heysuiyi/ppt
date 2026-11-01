import type { RunIdentity } from "@agent-harness/core/protocol-values";
import { shimmerActivity } from "./activity-shimmer.js";
import { renderCommandCompletions } from "./completion-list.js";
import { renderComposerFrame } from "./composer-frame.js";
import { humanRecordOutput, interactiveRecordOutput } from "./human-renderer.js";
import { encodeTerminalRecord } from "./jsonl-renderer.js";
import { assistantMessageLines, userMessageLines } from "./message-block.js";
import { type ModelPanelFrame, renderModelPanel } from "./model-panel.js";
import { renderOutputBlock, wrapOutputBlockText } from "./output-block.js";
import { canGroupRead, readToolGroupLines } from "./read-tool-group.js";
import type {
  TerminalRenderer,
  TerminalRendererOptions,
  TerminalTurnSettlement,
  TerminalView,
} from "./renderer-contract.js";
import { RunStatistics } from "./run-summary.js";
import { activityLines, contextLines, hintLines, statusLines } from "./status-line.js";
import type {
  TerminalHistoryEntry,
  TerminalQueryResultRecord,
  TerminalRecord,
  TerminalSelectionItem,
  TerminalTextPreview,
  TerminalToolRecord,
} from "./terminal-contract.js";
import { sanitizeTerminalRecord } from "./terminal-projection.js";
import {
  sanitizeTerminalText as safe,
  truncateTerminalText,
  visibleWidth,
  wrapTerminalText,
} from "./terminal-text.js";
import { TerminalTitle } from "./terminal-title.js";
import { renderThinkingBlock } from "./thinking-block.js";
import { toolCardId, toolCardLines, toolCardPageCount, toolSelection } from "./tool-card.js";
import { welcomeLines } from "./welcome.js";

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

interface ActivityAnimation {
  readonly text: string;
  readonly startedAt: number;
  timer?: NodeJS.Timeout;
}

function runKey(identity: RunIdentity): string {
  return JSON.stringify([identity.agentId, identity.threadId, identity.queryId, identity.runId]);
}

function queryKey(identity: RunIdentity): string {
  return JSON.stringify([identity.agentId, identity.threadId, identity.queryId]);
}

function previewKey(preview: TerminalTextPreview): string {
  return JSON.stringify([
    runKey(preview.identity),
    preview.step,
    preview.requestId,
    preview.previewId ?? preview.contentIndex,
  ]);
}

type ActivePart = { type: "preview"; key: string } | { type: "tool"; key: string };

interface TranscriptBlock {
  readonly lines: string[];
  readonly tools?: readonly TerminalToolRecord[];
  readonly thinking?: { readonly text: string };
}

/** 分组只改变显示，不合并调用身份；正文、思考与 Query 边界均由调用方断开。 */
function toolBlocks(
  tools: readonly TerminalToolRecord[],
  columns: number,
  color: boolean,
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (let index = 0; index < tools.length; ) {
    const first = tools[index]!;
    let end = index + 1;
    if (canGroupRead(first))
      while (
        end < tools.length &&
        canGroupRead(tools[end]!) &&
        queryKey(tools[end]!.invocationIdentity) === queryKey(first.invocationIdentity)
      )
        end += 1;
    const group = tools.slice(index, end);
    blocks.push({
      tools: group,
      lines:
        group.length > 1
          ? readToolGroupLines(group, columns, { color })
          : toolCardLines(first, columns, false, { color }),
    });
    index = end;
  }
  return blocks;
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
  let activeIdentity: RunIdentity | undefined;
  let pendingWaiting: TerminalQueryResultRecord | undefined;
  let activeParts: ActivePart[] = [];
  let welcomePending: boolean | undefined;
  let displayedWelcome: readonly string[] = [];
  let toolPage = 0;
  let plainView = "";
  const cards = new Map<string, TerminalToolRecord>();
  const settledMessages = new Set<string>();
  const archivedTools = new Set<string>();
  let toolPages = 1;
  let cachedViewport: Viewport | undefined;
  let cachedSize: { columns: number; rows: number } | undefined;
  let previewBatch: PreviewBatch | undefined;
  let modelPanelActive = false;
  let modelPanelFrame: ModelPanelFrame | undefined;
  let modelPanelSize: { columns: number; rows: number } | undefined;
  let deferredPanelHistory: readonly string[] = [];
  const archivedInteractions = new Set<string>();
  const endedQueries = new Set<string>();
  const archivedPrompts = new Set<string>();
  let previewGeneration = 0;
  let closing = false;
  let activityAnimation: ActivityAnimation | undefined;
  const thoughts = new Map<string, { text: string; label: string }>();
  const archivedThoughts = new Set<string>();
  let selectedThinking: string | undefined;
  let latestThinking: string | undefined;
  let thinkingPage = 0;
  let thinkingPages = 1;
  let statistics: RunStatistics | undefined;
  const summarizedRuns = new Set<string>();
  const title = new TerminalTitle(options.mode === "tui", options.writeOutput);

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

  function stopActivityAnimation(): void {
    if (activityAnimation?.timer) clearTimeout(activityAnimation.timer);
    activityAnimation = undefined;
  }

  function scheduleActivityFrame(animation: ActivityAnimation): void {
    if (activityAnimation !== animation || animation.timer || closing) return;
    // 写出完成后才安排下一帧，慢终端不能积压动画任务。
    animation.timer = setTimeout(() => {
      animation.timer = undefined;
      void enqueue(async () => {
        if (activityAnimation !== animation || closed || closing) return;
        await redraw();
        scheduleActivityFrame(animation);
      }).catch((error: unknown) => {
        stopActivityAnimation();
        options.onOutputError(error);
      });
    }, 1000 / 30);
    animation.timer.unref();
  }

  function syncActivityAnimation(enabled: boolean): void {
    const view = currentView;
    const finishedRun =
      activeIdentity &&
      endedQueries.has(runKey(activeIdentity)) &&
      view?.phase !== "idle" &&
      view?.phase !== "starting";
    const text =
      enabled &&
      !closing &&
      options.color &&
      tuiAvailable() &&
      view?.phase !== "waiting" &&
      !view?.interaction &&
      !view?.selector &&
      !view?.modelPanel &&
      !view?.prompt &&
      view?.feedback?.kind !== "blocking" &&
      !finishedRun
        ? view?.activity
        : undefined;
    if (!text) {
      stopActivityAnimation();
      return;
    }
    if (activityAnimation?.text === text) return;
    stopActivityAnimation();
    activityAnimation = { text, startedAt: Date.now() };
    scheduleActivityFrame(activityAnimation);
  }
  async function beginDisplay(size = dimensions()): Promise<void> {
    if (usedTui || !tuiAvailable(size)) return;
    // 启动时先清可见屏幕再清旧滚动缓冲；后续重绘和缩放不走此路径。
    await options.writeOutput("\x1b[?25l\x1b[H\x1b[2J\x1b[3J");
    usedTui = true;
  }

  function accepts(identity: RunIdentity): boolean {
    return (
      !!activeIdentity &&
      runKey(identity) === runKey(activeIdentity) &&
      (!currentView?.context || identity.threadId === currentView.context.threadId)
    );
  }

  function acceptsRecord(record: TerminalRecord): boolean {
    return !("identity" in record) || !record.identity || accepts(record.identity);
  }

  function updatePreviews(next: readonly TerminalTextPreview[]): void {
    previews = next.filter(
      (part) => accepts(part.identity) && !endedQueries.has(runKey(part.identity)),
    );
    const keys = new Set(previews.map(previewKey));
    activeParts = activeParts.filter((part) => part.type === "tool" || keys.has(part.key));
    const present = new Set(
      activeParts.filter((part) => part.type === "preview").map((part) => part.key),
    );
    for (const preview of previews) {
      const key = previewKey(preview);
      if (!present.has(key)) activeParts.push({ type: "preview", key });
    }
  }

  function liveThought(): TerminalTextPreview | undefined {
    return previews.findLast((preview) => preview.reasoning);
  }

  function thinkingText(): string | undefined {
    return selectedThinking === "live"
      ? liveThought()?.text
      : selectedThinking
        ? thoughts.get(selectedThinking)?.text
        : undefined;
  }

  async function showThinkingDetail(): Promise<void> {
    const text = thinkingText();
    if (text === undefined) return;
    if (tuiAvailable()) await redraw();
    else {
      const block = renderThinkingBlock(text, Math.max(40, options.columns()), {
        color: false,
        expanded: true,
        maxRows: 22,
        page: thinkingPage,
      });
      thinkingPages = block.pages;
      await options.writeError(`${block.lines.join("\n")}\n`);
    }
  }

  function discardPreview(): void {
    previewGeneration += 1;
    const batch = previewBatch;
    previewBatch = undefined;
    if (batch?.timer) clearTimeout(batch.timer);
    previews = [];
    if (selectedThinking === "live") selectedThinking = undefined;
    activeParts = activeParts.filter((part) => part.type !== "preview");
  }

  function retireWelcome(): readonly string[] {
    const lines = welcomePending ? displayedWelcome : [];
    welcomePending = false;
    displayedWelcome = [];
    return lines;
  }

  function paintPreview(batch: PreviewBatch, generation: number): void {
    void enqueue(async () => {
      if (closed || generation !== previewGeneration || previewBatch !== batch) return;
      const next = batch.next;
      updatePreviews(next);
      await redraw();
      if (previewBatch !== batch) return;
      if (batch.next === next) previewBatch = undefined;
      else schedulePreview(batch, generation);
    }).catch((error: unknown) => {
      if (previewBatch === batch) previewBatch = undefined;
      options.onOutputError(error);
    });
  }

  function schedulePreview(batch: PreviewBatch, generation: number): void {
    batch.timer = setTimeout(() => {
      batch.timer = undefined;
      paintPreview(batch, generation);
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

  function inputActivityLines(view: TerminalView, columns: number): string[] {
    const lines = activityLines(view, columns);
    // 活动与留白共用一行：就绪后不因活动消失而让输入框上跳。
    return lines.length === 0 && !view.selector ? [""] : lines;
  }

  function inputPromptLines(view: TerminalView, columns: number): string[] {
    return view.prompt
      ? wrapTerminalText(
          `${view.prompt.secret ? "安全输入 · 隐藏内容\n" : ""}${view.prompt.text}`,
          columns,
        )
      : [];
  }

  function inputPromptBudget(view: TerminalView, height: number, statusRows: number): number {
    return Math.max(1, height - statusRows - 3 - (view.interaction ? 3 : view.completion ? 2 : 0));
  }

  function interactionNeedsArchive(view: TerminalView): boolean {
    if (!view.interaction) return false;
    const columns = Math.max(1, options.columns() - 1);
    const editorRows = view.selector
      ? view.selector.items.length + 3
      : renderComposerFrame(view.composer.draft, columns, {
          maxRows: 7,
          color: false,
          secret: view.prompt?.secret === true,
        }).lines.length +
        1 +
        inputPromptLines(view, columns).length;
    const statusRows =
      inputActivityLines(view, columns).length +
      hintLines(view, columns).length +
      (view.selector ? contextLines(view, columns).length : 0);
    return (
      interactionLines(view.interaction, columns).length + statusRows + editorRows >
      options.rows() - 1
    );
  }

  function eraseViewportText(): string {
    if (viewportRows === 0) return "";
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
    return text;
  }

  async function eraseViewport(): Promise<void> {
    const text = eraseViewportText();
    if (text) await options.writeOutput(text);
  }

  async function leaveModelPanel(): Promise<void> {
    if (!modelPanelActive) return;
    // 1049 恢复主屏及进入前的光标；聊天 viewport 缓存从未借给模型面板。
    await options.writeOutput(
      `\x1b[?1049l${cachedViewport?.showCursor ? "\x1b[?25h" : "\x1b[?25l"}`,
    );
    modelPanelActive = false;
    modelPanelFrame = undefined;
    modelPanelSize = undefined;
  }

  async function drawModelPanel(size: { columns: number; rows: number }): Promise<void> {
    const view = currentView!;
    if (!modelPanelActive) {
      await beginDisplay(size);
      // 先记录所有权；写出异常时 close 仍会尝试归还主屏。
      modelPanelActive = true;
      await options.writeOutput("\x1b[?1049h\x1b[?25l\x1b[H");
    }
    const frame = renderModelPanel(view.modelPanel?.browser ?? view.selector!, {
      ...size,
      color: options.color,
      hint: view.input.hint,
      ...(view.feedback ? { feedback: view.feedback } : {}),
      ...(view.modelPanel ? { configuration: view } : {}),
    });
    const resized =
      modelPanelSize &&
      (modelPanelSize.columns !== size.columns || modelPanelSize.rows !== size.rows);
    const previous = resized ? undefined : modelPanelFrame;
    let text = resized ? "\x1b[H\x1b[2J" : "";
    for (let index = 0; index < frame.lines.length; index += 1) {
      if (frame.lines[index] !== previous?.lines[index])
        text += `\x1b[${index + 1};1H\x1b[2K${frame.lines[index]}`;
    }
    if (
      text ||
      previous?.cursorRow !== frame.cursorRow ||
      previous?.cursorColumn !== frame.cursorColumn ||
      previous?.showCursor !== frame.showCursor
    ) {
      text += `\x1b[${frame.cursorRow + 1};${frame.cursorColumn + 1}H${frame.showCursor ? "\x1b[?25h" : "\x1b[?25l"}`;
      await options.writeOutput(text);
    }
    modelPanelFrame = frame;
    modelPanelSize = size;
  }

  function composeViewport(size: { columns: number; rows: number }): Viewport {
    const columns = Math.max(1, size.columns - 1);
    const height = Math.max(1, size.rows - 1);
    const view = currentView;
    const activity = view ? inputActivityLines(view, columns) : [];
    if (activityAnimation && activity[0])
      activity[0] = shimmerActivity(
        truncateTerminalText(activity[0], Math.max(0, columns - 2)),
        Date.now() - activityAnimation.startedAt,
      );
    const context = view ? contextLines(view, columns, options.color) : [];
    const hints = view ? hintLines(view, columns) : [];
    const statusCount = activity.length + hints.length + (view?.selector ? context.length : 0);
    const rule = (title: string): string => {
      const label = title ? truncateTerminalText(` ${title} `, columns - 3) : "";
      const line = `╭─${label}${"─".repeat(Math.max(0, columns - visibleWidth(label) - 3))}╮`;
      return options.color ? `\x1b[2m${line}\x1b[0m` : line;
    };
    let composer: string[] = [];
    let composerCursor = 0;
    let composerColumn = 0;
    let composerFocused = false;
    if (view && !view.selector) {
      const secret = view.prompt?.secret === true;
      const reserve = view.completion
        ? 4
        : view.interaction
          ? 3
          : selectedTool || activeParts.some((part) => part.type === "tool")
            ? 4
            : previews.length > 0
              ? 3
              : 2;
      const promptLines = inputPromptLines(view, columns);
      const promptBudget = inputPromptBudget(view, height, statusCount);
      const prompt =
        promptLines.length <= promptBudget
          ? promptLines
          : [
              ...promptLines.slice(0, Math.max(1, promptBudget - 2)),
              ...(promptBudget > 2 ? [truncateTerminalText("… 完整提示可回看历史", columns)] : []),
              ...(promptBudget > 1 ? [promptLines[promptLines.length - 1]!] : []),
            ];
      composerFocused = view.composer.editable && (!view.interaction || !!view.prompt);
      const frame = renderComposerFrame(view.composer.draft, columns, {
        maxRows: Math.max(2, height - statusCount - prompt.length - reserve - 1),
        color: options.color,
        secret,
      });
      // 状态带独立绘制；启动时同样预留一行，分段 ANSI 不再被草稿组件转义。
      composer = [...prompt, context[0] ?? "", ...frame.lines];
      composerCursor = prompt.length + 1 + frame.cursorRow;
      composerColumn = frame.cursorColumn;
    }
    const available = Math.max(0, height - statusCount - composer.length);
    const content: string[] = [];
    // 工具卡是完整块；可缩短正文，但不能在最后的视口裁剪中切断边框。
    let transcript: TranscriptBlock[] | undefined;
    let detailCard: TerminalToolRecord | undefined;
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
          ...(budget > 2 && archivedInteractions.has(JSON.stringify([reference, display]))
            ? [truncateTerminalText("完整摘要、选项及 ID 已保留在上方历史", columns)]
            : []),
        );
    }
    const editorStart = content.length;
    if (view?.selector) {
      const selector = view.selector;
      const selectorAvailable = Math.max(1, available - content.length);
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
    } else if (view?.interaction) {
      // The safe approval summary above remains visible alongside its active input.
    } else if (selectedTool && cards.has(selectedTool)) {
      detailCard = cards.get(selectedTool)!;
    } else if (selectedThinking && thinkingText() !== undefined) {
      // 独立详情占用正文区域，不消费或替换主草稿。
    } else {
      transcript = [];
      const previewMap = new Map(previews.map((part) => [previewKey(part), part]));
      let pendingTools: TerminalToolRecord[] = [];
      const flushTools = (): void => {
        transcript!.push(...toolBlocks(pendingTools, columns, options.color));
        pendingTools = [];
      };
      for (const part of activeParts) {
        if (part.type === "tool") {
          const card = cards.get(part.key);
          if (card) pendingTools.push(card);
        } else {
          flushTools();
          const preview = previewMap.get(part.key);
          if (!preview) continue;
          transcript.push({
            ...(preview.reasoning ? { thinking: { text: preview.text } } : {}),
            lines: preview.reasoning
              ? renderThinkingBlock(preview.text, columns, { color: options.color, live: true })
                  .lines
              : [
                  ...(preview.truncated
                    ? [truncateTerminalText("… 前文已截断，仅展示当前正文尾部", columns)]
                    : []),
                  ...assistantMessageLines(preview.text, columns, true, options.color),
                ],
          });
        }
      }
      flushTools();
      for (const block of transcript) content.push(...block.lines);
      if (content.length === 0 && welcomePending && !view?.prompt) {
        displayedWelcome = welcomeLines(
          columns,
          Math.min(5, Math.floor(height / 3), Math.max(0, available - 2)),
          options.color,
        );
        content.push(...displayedWelcome);
      }
    }
    const editorSlot = view?.selector ? content.splice(editorStart) : composer;
    const completion = view?.completion
      ? renderCommandCompletions(
          view.completion,
          columns,
          Math.min(
            available,
            detailCard || selectedThinking ? 4 : Math.max(2, available - content.length),
          ),
          options.color,
        )
      : [];
    const contentBudget = Math.max(
      0,
      available - completion.length - (view?.selector ? editorSlot.length : 0),
    );
    let visible: string[];
    if (selectedThinking && thinkingText() !== undefined && !view?.selector && !view?.interaction) {
      const thinking = renderThinkingBlock(thinkingText()!, columns, {
        color: options.color,
        live: selectedThinking === "live",
        expanded: true,
        maxRows: contentBudget,
        page: thinkingPage,
      });
      thinkingPages = thinking.pages;
      thinkingPage = Math.min(thinkingPage, thinkingPages - 1);
      visible = thinking.lines;
    } else if (detailCard) {
      toolPages = toolCardPageCount(detailCard, columns, contentBudget);
      toolPage = Math.max(0, Math.min(toolPage, toolPages - 1));
      visible = toolCardLines(detailCard, columns, true, {
        maxRows: contentBudget,
        page: toolPage,
        color: options.color,
      });
    } else if (transcript && content.length > contentBudget) {
      const blocks: string[][] = [];
      let remaining = contentBudget;
      for (let index = transcript.length - 1; index >= 0 && remaining > 0; index -= 1) {
        const block = transcript[index]!;
        if (block.lines.length <= remaining) {
          blocks.push(block.lines);
          remaining -= block.lines.length;
          continue;
        }
        if (block.thinking)
          blocks.push(
            renderThinkingBlock(block.thinking.text, columns, {
              color: options.color,
              live: true,
              maxRows: remaining,
            }).lines,
          );
        else if (!block.tools) blocks.push(block.lines.slice(-remaining));
        else if (blocks.length === 0) {
          const latest = block.tools.at(-1)!;
          const grouped =
            block.tools.length > 1
              ? readToolGroupLines(block.tools, columns, {
                  maxRows: remaining,
                  color: options.color,
                })
              : [];
          blocks.push(
            grouped.length
              ? grouped
              : toolCardLines(latest, columns, false, { maxRows: remaining, color: options.color }),
          );
        }
        break;
      }
      visible = blocks.reverse().flat();
    } else {
      visible =
        content.length <= contentBudget
          ? content
          : view?.interaction || view?.selector || view?.completion
            ? content.slice(0, contentBudget)
            : content.slice(-contentBudget);
    }
    const aboveInput = view?.selector ? context : [];
    const lines = [...visible, ...activity, ...aboveInput, ...editorSlot, ...completion, ...hints];
    if (lines.length === 0) lines.push("");
    return {
      lines,
      cursorRow: Math.min(
        lines.length - 1,
        visible.length + activity.length + aboveInput.length + composerCursor,
      ),
      cursorColumn: composerColumn,
      showCursor: composerFocused,
    };
  }

  async function redraw(history: readonly string[] = [], animateActivity = true): Promise<void> {
    syncActivityAnimation(animateActivity);
    const size = dimensions();
    await title.update(currentView, tuiAvailable(size));
    if ((currentView?.modelPanel || currentView?.selector?.navigation) && tuiAvailable(size)) {
      if (history.length) deferredPanelHistory = [...deferredPanelHistory, ...history];
      await drawModelPanel(size);
      return;
    }
    await leaveModelPanel();
    if (deferredPanelHistory.length) {
      history = [...deferredPanelHistory, ...history];
      deferredPanelHistory = [];
    }
    let historyOutput = "";
    if (history.length > 0 && tuiAvailable(size)) {
      await beginDisplay(size);
      historyOutput = `${eraseViewportText()}${history.join("\r\n")}\r\n`;
    }
    if (!tuiAvailable(size)) {
      if (history.length)
        await options.writeError(`${history.map((line) => safe(line)).join("\n")}\n`);
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
                  ...(groups && navigation?.action
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
    await beginDisplay(size);
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
    let text = historyOutput;
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

  async function appendHistory(text: string): Promise<void> {
    await redraw(wrapTerminalText(text, Math.max(1, options.columns() - 1)));
  }

  function updateTool(tool: TerminalToolRecord): void {
    const key = toolCardId(tool);
    const previous = cards.get(key);
    if (previous?.phase === "completed" && tool.phase === "started") return;
    cards.set(key, tool);
    latestTool = key;
    if (
      !archivedTools.has(key) &&
      !activeParts.some((part) => part.type === "tool" && part.key === key)
    )
      activeParts.push({ type: "tool", key });
  }

  function retireTool(key: string, columns: number): readonly string[] {
    const card = cards.get(key);
    if (!card || archivedTools.has(key)) return [];
    archivedTools.add(key);
    activeParts = activeParts.filter((part) => part.type !== "tool" || part.key !== key);
    return toolCardLines(card, columns, false, {
      color: options.color,
      interrupted: card.phase === "started",
    });
  }

  async function writeRecord(record: TerminalRecord): Promise<void> {
    if (options.mode === "jsonl") {
      await options.writeOutput(encodeTerminalRecord(record));
      return;
    }
    const human =
      options.mode === "print" ? humanRecordOutput(record) : interactiveRecordOutput(record);
    if (human.output) await options.writeOutput(human.output);
    if (human.error) await options.writeError(human.error);
  }

  async function settleTurn(settlement: TerminalTurnSettlement): Promise<void> {
    const records = settlement.records.map(sanitizeTerminalRecord).filter(acceptsRecord);
    if (closed && (options.mode === "tui" || options.mode === "plain")) return;
    if (records.length === 0) return;
    const wasLiveThinking = selectedThinking === "live";
    discardPreview();
    stopActivityAnimation();
    const welcome = retireWelcome();
    const canonicalThoughts = new Map<string, string>();
    for (const record of records) {
      statistics?.observe(record);
      if (record.type === "tool") updateTool(record);
      if (record.type === "assistant.reasoning") {
        const key = JSON.stringify([
          queryKey(record.identity),
          record.messageIndex,
          record.contentIndex,
        ]);
        thoughts.set(key, {
          text: record.text,
          label: `思考 · 消息 ${record.messageIndex + 1} / 块 ${record.contentIndex + 1}`,
        });
        latestThinking = key;
        if (!archivedThoughts.has(key))
          canonicalThoughts.set(JSON.stringify([record.messageIndex, record.contentIndex]), key);
        if (wasLiveThinking) selectedThinking = key;
      }
      if (record.type === "query.result") {
        endedQueries.add(runKey(record.identity));
        pendingWaiting = record.status === "waiting" ? record : undefined;
      }
    }
    if (wasLiveThinking && selectedThinking === "live") selectedThinking = undefined;
    if (!tuiAvailable()) {
      for (const record of records) {
        if (record.type === "assistant.reasoning") {
          const key = JSON.stringify([
            queryKey(record.identity),
            record.messageIndex,
            record.contentIndex,
          ]);
          if (archivedThoughts.has(key)) continue;
          archivedThoughts.add(key);
        } else if (record.type === "assistant.message") {
          const key = JSON.stringify([queryKey(record.identity), record.messageIndex]);
          if (settledMessages.has(key)) continue;
          settledMessages.add(key);
        }
        await writeRecord(record);
      }
      return;
    }
    const columns = Math.max(1, options.columns() - 1);
    const lines: string[] = [...welcome];
    const canonical = new Map<string, { messageKey: string; text: string }>();
    const newMessages = new Set<string>();
    for (const record of records) {
      if (record.type !== "assistant.message") continue;
      const messageKey = JSON.stringify([queryKey(record.identity), record.messageIndex]);
      if (settledMessages.has(messageKey)) continue;
      for (const part of record.content)
        canonical.set(JSON.stringify([record.messageIndex, part.contentIndex]), {
          messageKey,
          text: part.text,
        });
    }
    let text = "";
    let messageIndex: number | undefined;
    let pendingTools: TerminalToolRecord[] = [];
    const flushTools = (): void => {
      for (const block of toolBlocks(pendingTools, columns, options.color))
        lines.push(...block.lines);
      pendingTools = [];
    };
    const flushText = (): void => {
      flushTools();
      if (text) lines.push(...assistantMessageLines(text, columns, false, options.color));
      text = "";
    };
    const archiveTool = (key: string): void => {
      if (text) flushText();
      const card = cards.get(key);
      if (!card || archivedTools.has(key)) return;
      if (card.phase === "started") {
        flushTools();
        lines.push(...retireTool(key, columns));
      } else {
        archivedTools.add(key);
        activeParts = activeParts.filter((part) => part.type !== "tool" || part.key !== key);
        pendingTools.push(card);
      }
    };
    const result = records.find((record) => record.type === "query.result");
    const turnIdentity = records.flatMap((record) =>
      "identity" in record && record.identity ? [record.identity] : [],
    )[0];
    const matchedTools = new Set<string>();
    for (const part of settlement.timeline) {
      if (part.type === "tool") {
        if (!turnIdentity) continue;
        // 调用位置来自规范历史，匹配仍使用完整 Query/调用身份。
        for (const [key, card] of cards) {
          if (
            matchedTools.has(key) ||
            card.callId !== safe(part.callId) ||
            queryKey(card.invocationIdentity) !== queryKey(turnIdentity)
          )
            continue;
          matchedTools.add(key);
          archiveTool(key);
          break;
        }
      } else if (part.type === "reasoning") {
        flushText();
        const position = JSON.stringify([part.messageIndex, part.contentIndex]);
        const key = canonicalThoughts.get(position);
        if (!key) continue;
        canonicalThoughts.delete(position);
        archivedThoughts.add(key);
        lines.push(
          ...renderThinkingBlock(thoughts.get(key)!.text, columns, { color: options.color }).lines,
        );
      } else {
        flushTools();
        const position = JSON.stringify([part.messageIndex, part.contentIndex]);
        const entry = canonical.get(position);
        if (!entry) continue;
        canonical.delete(position);
        newMessages.add(entry.messageKey);
        if (messageIndex !== undefined && messageIndex !== part.messageIndex) flushText();
        messageIndex = part.messageIndex;
        text += entry.text;
      }
    }
    flushText();
    for (const key of newMessages) settledMessages.add(key);
    if (result && result.status !== "waiting") {
      const unmatched = activeParts.filter((part) => part.type === "tool");
      if (unmatched.length > 0 && settlement.timeline.length > 0)
        lines.push(...wrapTerminalText("其他已观察工具（规范时间线位置未确认）", columns));
      for (const part of unmatched) archiveTool(part.key);
      flushTools();
    }
    for (const record of records) {
      if (
        record.type === "assistant.message" ||
        record.type === "assistant.reasoning" ||
        record.type === "tool"
      )
        continue;
      if (record.type === "query.result" && record.status === "waiting") continue;
      const human = interactiveRecordOutput(record);
      if (human.error) lines.push(...wrapTerminalText(human.error.trimEnd(), columns));
    }
    if (result && statistics && !summarizedRuns.has(runKey(result.identity))) {
      summarizedRuns.add(runKey(result.identity));
      lines.push(...statistics.lines(columns, options.color));
    }
    if (result?.status !== "waiting") {
      selectedTool = undefined;
      toolPage = 0;
    }
    await redraw(lines, false);
  }

  return {
    bindSession(next: TerminalView, messages: readonly TerminalHistoryEntry[]) {
      return enqueue(async () => {
        if (closed) return;
        stopActivityAnimation();
        const columns = Math.max(1, options.columns() - 1);
        const retired = tuiAvailable()
          ? activeParts.flatMap((part) =>
              part.type === "tool" ? retireTool(part.key, columns) : [],
            )
          : [];
        discardPreview();
        activeIdentity = undefined;
        pendingWaiting = undefined;
        activeParts = [];
        cards.clear();
        archivedTools.clear();
        settledMessages.clear();
        endedQueries.clear();
        archivedInteractions.clear();
        archivedPrompts.clear();
        thoughts.clear();
        archivedThoughts.clear();
        selectedThinking = undefined;
        latestThinking = undefined;
        statistics = undefined;
        summarizedRuns.clear();
        selectedTool = undefined;
        latestTool = undefined;
        toolPage = 0;
        toolPages = 1;
        currentView = next;
        title.bindSession(messages);
        welcomePending = messages.length === 0 && next.scene !== "conversation";
        displayedWelcome = [];
        if (options.mode === "jsonl" || options.mode === "print") return;
        const historyLines = messages.flatMap((message, index): string[] => {
          if (message.role === "reasoning") {
            const key = `history:${index}`;
            thoughts.set(key, { text: safe(message.text), label: `历史思考 ${index + 1}` });
            latestThinking = key;
            return tuiAvailable()
              ? renderThinkingBlock(message.text, columns, { color: options.color }).lines
              : ["公开思考已收起；/thinking 查看"];
          }
          if (message.role === "tool") {
            const result =
              message.tool.result === "recorded"
                ? "工具结果已记录"
                : message.tool.result === "error"
                  ? "工具错误结果已记录"
                  : "缺少对应工具结果";
            const rows = [
              ...wrapOutputBlockText(`调用 ${safe(message.tool.callId)} · ${result}`, columns),
              ...wrapOutputBlockText("历史未保留执行影响与安全正文；不从原始结果猜测。", columns),
            ];
            return tuiAvailable()
              ? renderOutputBlock({
                  width: columns,
                  header: `${safe(message.tool.name)} · 历史`,
                  rows: rows.map((text) => ({ kind: "content", text })),
                  color: options.color,
                  tone: "warning",
                })
              : [`${safe(message.tool.name)}: ${result}；执行影响未知`];
          }
          return tuiAvailable()
            ? message.role === "assistant"
              ? assistantMessageLines(message.text, columns, false, options.color)
              : userMessageLines(message.text, columns, options.color)
            : [`${message.role}: ${safe(message.text)}`];
        });
        if (tuiAvailable()) await redraw([...retired, ...historyLines]);
        else {
          if (historyLines.length) await options.writeError(`${historyLines.join("\n")}\n`);
          await redraw();
        }
      });
    },
    beginRun(identity) {
      return enqueue(async () => {
        if (closed || (currentView?.context && currentView.context.threadId !== identity.threadId))
          return;
        discardPreview();
        pendingWaiting = undefined;
        const sameQuery = activeIdentity && queryKey(activeIdentity) === queryKey(identity);
        if (!sameQuery) {
          activeParts = [];
          latestTool = undefined;
        }
        if (!activeIdentity || runKey(activeIdentity) !== runKey(identity))
          statistics = new RunStatistics();
        selectedThinking = undefined;
        thinkingPage = 0;
        activeIdentity = identity;
        selectedTool = undefined;
        toolPage = 0;
        if (currentView) await redraw();
      });
    },
    settle(settlement) {
      return enqueue(() => settleTurn(settlement));
    },
    record(record) {
      return enqueue(async () => {
        const projected = sanitizeTerminalRecord(record);
        if (!acceptsRecord(projected)) return;
        if (closed && (options.mode === "tui" || options.mode === "plain")) return;
        if (projected.type === "tool" && endedQueries.has(runKey(projected.identity))) return;
        statistics?.observe(projected);
        if (projected.type === "model.completed") {
          if (!tuiAvailable()) await writeRecord(projected);
          return;
        }
        if (projected.type === "assistant.reasoning") {
          await settleTurn({
            records: [projected],
            timeline: [
              {
                type: "reasoning",
                messageIndex: projected.messageIndex,
                contentIndex: projected.contentIndex,
                text: projected.text,
              },
            ],
          });
          return;
        }
        if (projected.type === "assistant.message") {
          await settleTurn({
            records: [projected],
            timeline: projected.content.map((part) => ({
              type: "text",
              messageIndex: projected.messageIndex,
              contentIndex: part.contentIndex,
              text: part.text,
            })),
          });
          return;
        }
        if (projected.type === "query.result" || projected.type === "error") {
          await settleTurn({ records: [projected], timeline: [] });
          return;
        }
        if (projected.type === "tool") updateTool(projected);
        if (tuiAvailable()) {
          const human = interactiveRecordOutput(projected);
          if (projected.type !== "tool" && human.error) await appendHistory(human.error.trimEnd());
          else await redraw();
        } else await writeRecord(projected);
      });
    },
    preview(next) {
      if (closing || closed || options.mode !== "tui") return Promise.resolve();
      if (next.length === 0) {
        discardPreview();
        return enqueue(redraw);
      }
      const filtered = next.filter(
        (part) => accepts(part.identity) && !endedQueries.has(runKey(part.identity)),
      );
      if (filtered.length === 0) return Promise.resolve();
      if (previewBatch) {
        previewBatch.next = filtered;
        return Promise.resolve();
      }
      const batch: PreviewBatch = { next: filtered };
      previewBatch = batch;
      if (previews.length === 0) paintPreview(batch, previewGeneration);
      else schedulePreview(batch, previewGeneration);
      return Promise.resolve();
    },
    view(next) {
      return enqueue(async () => {
        if (closed) return;
        if (welcomePending === undefined) welcomePending = next.scene !== "conversation";
        currentView = next;
        if (next.interaction && options.mode === "tui") {
          const key = JSON.stringify([next.interaction.reference, next.interaction.display]);
          if (interactionNeedsArchive(next) && !archivedInteractions.has(key)) {
            archivedInteractions.add(key);
            if (tuiAvailable())
              await appendHistory(
                interactionLines(next.interaction, Math.max(1, options.columns() - 1)).join("\n"),
              );
          }
        }
        if (
          next.prompt &&
          !next.modelPanel &&
          options.mode === "tui" &&
          !archivedPrompts.has(next.prompt.text) &&
          inputPromptLines(next, Math.max(1, options.columns() - 1)).length >
            inputPromptBudget(
              next,
              options.rows() - 1,
              inputActivityLines(next, Math.max(1, options.columns() - 1)).length +
                hintLines(next, Math.max(1, options.columns() - 1)).length,
            )
        ) {
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
        title.user(text);
        const welcome = retireWelcome();
        if (tuiAvailable())
          await redraw([
            ...welcome,
            ...userMessageLines(text, Math.max(1, options.columns() - 1), options.color),
          ]);
        else await options.writeError(`You: ${safe(text)}\n`);
      });
    },
    message(text) {
      return enqueue(async () => {
        if (closed) return;
        if (tuiAvailable()) await appendHistory(safe(text));
        else await options.writeError(`${safe(text)}\n`);
      });
    },
    toggleTool() {
      return enqueue(async () => {
        if (closed) return;
        const latest = latestTool;
        if (!latest) return;
        selectedThinking = undefined;
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
    toggleThinking() {
      return enqueue(async () => {
        if (closed) return;
        const latest = liveThought() ? "live" : latestThinking;
        if (!selectedThinking) {
          if (!latest) return;
          selectedThinking = latest;
          thinkingPage = 0;
        } else if (thinkingPage + 1 < thinkingPages) thinkingPage += 1;
        else {
          selectedThinking = undefined;
          thinkingPage = 0;
          if (tuiAvailable()) await redraw();
          return;
        }
        selectedTool = undefined;
        await showThinkingDetail();
      });
    },
    dismissDetail() {
      return enqueue(async () => {
        if (!selectedTool && !selectedThinking) return false;
        selectedThinking = undefined;
        thinkingPage = 0;
        selectedTool = undefined;
        toolPage = 0;
        if (!closed) await redraw();
        return true;
      });
    },
    tools(): readonly TerminalSelectionItem[] {
      return Array.from(cards.values(), toolSelection);
    },
    thoughts(): readonly TerminalSelectionItem[] {
      return [
        ...Array.from(thoughts, ([id, thought]) => ({
          id,
          label: thought.label,
          description: truncateTerminalText(thought.text, 80),
        })),
        ...(liveThought() ? [{ id: "live", label: "当前公开思考预览" }] : []),
      ];
    },
    selectThinking(id) {
      return enqueue(async () => {
        if (closed || (id === "live" ? !liveThought() : !thoughts.has(id))) return;
        selectedThinking = id;
        selectedTool = undefined;
        thinkingPage = 0;
        await showThinkingDetail();
      });
    },
    selectTool(id) {
      return enqueue(async () => {
        if (closed || !cards.has(id)) return;
        selectedThinking = undefined;
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
      stopActivityAnimation();
      discardPreview();
      return enqueue(async () => {
        if (closed) return;
        const restorePrimary = modelPanelActive ? "\x1b[?1049l" : "";
        modelPanelActive = false;
        modelPanelFrame = undefined;
        modelPanelSize = undefined;
        const lines = tuiAvailable()
          ? activeParts.flatMap((part) =>
              part.type === "tool" ? retireTool(part.key, Math.max(1, options.columns() - 1)) : [],
            )
          : [];
        const interaction = currentView?.interaction;
        const archived =
          interaction &&
          archivedInteractions.has(JSON.stringify([interaction.reference, interaction.display]));
        const waitingNotice =
          pendingWaiting && !archived ? interactiveRecordOutput(pendingWaiting).error : undefined;
        if (tuiAvailable() && waitingNotice)
          lines.push(
            ...wrapTerminalText(waitingNotice.trimEnd(), Math.max(1, options.columns() - 1)),
          );
        const pendingLines = deferredPanelHistory.length
          ? [...deferredPanelHistory, ...lines]
          : lines;
        const output = `${restorePrimary}${eraseViewportText()}${pendingLines.length ? `${pendingLines.join("\r\n")}\r\n` : ""}${usedTui ? "\x1b[?25h" : ""}`;
        closed = true;
        previews = [];
        try {
          if (output) await options.writeOutput(output);
        } finally {
          await title.close();
        }
      });
    },
  };
}
