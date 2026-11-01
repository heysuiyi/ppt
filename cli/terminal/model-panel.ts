import { renderComposerFrame } from "./composer-frame.js";
import { composerContentWidth } from "./composer-layout.js";
import type { TerminalFeedback, TerminalSelectorView, TerminalView } from "./renderer-contract.js";
import type { TerminalSelectionItem } from "./terminal-contract.js";
import { truncateTerminalText, visibleWidth, wrapTerminalText } from "./terminal-text.js";

export interface ModelPanelFrame {
  readonly lines: readonly string[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
  readonly showCursor: boolean;
}

interface ModelPanelOptions {
  readonly columns: number;
  readonly rows: number;
  readonly color: boolean;
  readonly hint: string;
  readonly feedback?: TerminalFeedback;
  readonly configuration?: TerminalView;
}

function modelPanelLayout(
  browser: TerminalSelectorView,
  terminalColumns: number,
  configuration: boolean,
) {
  const columns = Number.isFinite(terminalColumns) ? Math.max(0, Math.floor(terminalColumns)) : 0;
  const interiorWidth = Math.max(0, columns - 3);
  const split = columns >= 80 || (configuration && columns >= 40);
  let leftWidth = 0;
  if (split) {
    for (const item of browser.navigation?.groups ?? [])
      leftWidth = Math.max(
        leftWidth,
        visibleWidth(item.label) + visibleWidth(item.description ?? "") + 5,
      );
    leftWidth =
      columns < 80
        ? Math.min(14, Math.floor(interiorWidth / 3))
        : Math.min(36, Math.floor(interiorWidth / 3), Math.max(20, leftWidth));
  }
  const rightWidth = split ? interiorWidth - leftWidth - 1 : interiorWidth;
  return { split, interiorWidth, leftWidth, rightWidth };
}

/** Match the shared composer frame, including its gutter and final caret cell. */
export function modelPanelEditorWidth(
  browser: TerminalSelectorView,
  terminalColumns: number,
): number {
  const { rightWidth } = modelPanelLayout(browser, terminalColumns, true);
  const frameWidth = Math.max(0, rightWidth - 2);
  return frameWidth >= 8 ? composerContentWidth(frameWidth) : Math.max(1, frameWidth - 1);
}

/** A complete alternate-screen frame; the caller owns screen and input lifetimes. */
export function renderModelPanel(
  selector: TerminalSelectorView,
  options: ModelPanelOptions,
): ModelPanelFrame {
  const { split, interiorWidth, leftWidth, rightWidth } = modelPanelLayout(
    selector,
    options.columns,
    !!options.configuration,
  );
  const height = Math.max(0, Math.floor(options.rows) - 1);
  const navigation = selector.navigation!;
  const configuration = options.configuration;
  const bodyHeight = height - 4;
  // Header, search, pinned action, two detail rows, and feedback never enter the list viewport.
  const listHeight = Math.max(1, bodyHeight - 6);
  const action = navigation.action;
  const models = action ? selector.items.filter((item) => item.id !== action.id) : selector.items;
  const groupIndex = navigation.groups.findIndex((item) => item.id === navigation.selectedGroupId);
  const group = navigation.groups[groupIndex];
  const selectedIndex = models.findIndex((item) => item.id === selector.selectedId);
  const selectedItem = action && selector.selectedId === action.id ? action : models[selectedIndex];
  const groupsFocused = navigation.pane === "groups";
  const modelFocused = !groupsFocused;
  const actionSelected = !!action && selector.selectedId === action.id;
  const creating = navigation.selectedGroupId.startsWith("create:");
  const feedback = configuration?.feedback ?? options.feedback;
  let cursorRow = 0;
  let cursorColumn = 0;
  let showCursor = false;
  const color = options.color && process.env.NO_COLOR === undefined;

  const paint = (text: string, code: string): string =>
    color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const border = (text: string): string => paint(text, "90");
  const padText = (text: string, columns: number): string => {
    const clipped = truncateTerminalText(text, Math.max(0, columns));
    return clipped + " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
  };
  const cell = (text: string, columns: number, emphasis?: string): string => {
    const padded = ` ${padText(text, columns - 2)} `;
    return emphasis ? paint(padded, emphasis) : padded;
  };
  const viewportStart = (selected: number, length: number, capacity: number): number =>
    Math.max(0, Math.min(selected - Math.floor(capacity / 2), length - capacity));

  const listRows = (
    items: readonly TerminalSelectionItem[],
    selectedId: string | null,
    focused: boolean,
    columns: number,
    capacity: number,
    descriptions: boolean,
    empty: string,
    connections = false,
  ): string[] => {
    const entries: (TerminalSelectionItem | null)[] = [];
    for (const [index, item] of items.entries()) {
      if (
        connections &&
        item.id.startsWith("create:") &&
        (index === 0 || !items[index - 1]!.id.startsWith("create:"))
      )
        entries.push(null);
      entries.push(item);
    }
    const selected = entries.findIndex((item) => item?.id === selectedId);
    const start = viewportStart(selected, entries.length, capacity);
    const textWidth = columns - 2;
    const result: string[] = [];
    for (let row = 0; row < capacity; row++) {
      const item = entries[start + row];
      const active = item != null && item.id === selectedId;
      // Reserve the edge for both arrows, including the one-row narrow viewport.
      const scroll = `${row === 0 && start > 0 ? "↑" : ""}${
        row === capacity - 1 && start + capacity < entries.length ? "↓" : ""
      }`;
      const scrollWidth = visibleWidth(scroll);
      const available = textWidth - (scroll ? scrollWidth + 1 : 0);
      let text = "";
      if (item) {
        const marker = active ? (focused ? "›" : "◆") : " ";
        if (descriptions && item.description) {
          // Keep the supplied connection count visible even when its name is long.
          const annotation = truncateTerminalText(item.description, Math.floor(available / 2));
          const annotationWidth = visibleWidth(annotation);
          text = `${padText(`${marker} ${item.label}`, available - annotationWidth - 1)} ${annotation}`;
        } else text = padText(`${marker} ${item.label}`, available);
      } else
        text = padText(
          item === null ? "── 新建连接 ──" : row === 0 && items.length === 0 ? empty : "",
          available,
        );
      if (scroll) text = `${text} ${scroll}`;
      result.push(cell(text, columns, active ? (focused ? "1;36" : "1") : undefined));
    }
    return result;
  };

  const scope = group?.label ?? "All";
  const heading = `${modelFocused ? "›" : " "} ${scope}`;
  const modelCount = creating ? "" : `${models.length} 个模型`;
  const headingRow = (columns: number, connections: boolean): string => {
    const count = truncateTerminalText(modelCount, Math.floor((columns - 2) / 2));
    const label = connections ? `› 连接 · ${scope}` : heading;
    return cell(
      `${padText(label, columns - 3 - visibleWidth(count))} ${count}`,
      columns,
      connections || modelFocused ? "1;36" : "1",
    );
  };
  const right: string[] = [];
  if (configuration) {
    const step = configuration.selector;
    const status = configuration.activity ?? "";
    right.push(cell(step?.title ?? scope, rightWidth, "1;36"));
    if (step) {
      right.push(
        cell(`搜索: ${step.query || "输入以筛选"}`, rightWidth),
        ...listRows(
          step.items,
          step.selectedId,
          true,
          rightWidth,
          Math.max(1, bodyHeight - 5),
          true,
          "没有匹配选项",
        ),
      );
      const selected = step.items.find((item) => item.id === step.selectedId);
      right.push(cell(selected?.description ?? "", rightWidth));
    } else if (configuration.prompt) {
      const prompt = configuration.prompt;
      const promptLines = wrapTerminalText(prompt.text, Math.max(1, rightWidth - 2));
      const promptBudget = Math.max(1, Math.min(3, bodyHeight - 4));
      const visiblePrompt =
        promptLines.length <= promptBudget
          ? promptLines
          : [...promptLines.slice(0, promptBudget - 1), promptLines.at(-1)!];
      for (const line of visiblePrompt) right.push(cell(line, rightWidth));
      const ownsInput =
        configuration.input.purpose === "prompt" || configuration.input.purpose === "secret";
      if (ownsInput) {
        const secret = prompt.secret || configuration.input.purpose === "secret";
        const frame = renderComposerFrame(configuration.composer.draft, rightWidth - 2, {
          maxRows: Math.max(1, bodyHeight - right.length - 2),
          color: false,
          secret,
        });
        cursorRow = 1 + right.length + frame.cursorRow;
        cursorColumn = (split ? leftWidth + 3 : 2) + frame.cursorColumn;
        showCursor = configuration.composer.editable && frame.lines.length > 0;
        for (const line of frame.lines) right.push(cell(line, rightWidth));
      }
    } else {
      right.push(cell(`连接: ${scope}`, rightWidth));
    }
    // Activity and feedback stay pinned, including during discovery and confirmation.
    while (right.length < bodyHeight - 2) right.push(cell("", rightWidth));
    right.push(
      cell(status, rightWidth),
      cell(
        feedback && feedback.kind !== "notice"
          ? `${feedback.kind === "blocking" ? "错误" : "提示"}: ${feedback.message}`
          : "",
        rightWidth,
        feedback?.kind === "blocking" ? "31" : undefined,
      ),
    );
  } else {
    const showGroups = !split && groupsFocused;
    right.push(
      headingRow(rightWidth, showGroups),
      cell(creating ? "" : `搜索模型: ${selector.query || "输入以筛选"}`, rightWidth),
    );
    if (creating && !showGroups) {
      for (let row = 0; row < listHeight; row++) right.push(cell("", rightWidth));
    } else {
      right.push(
        ...listRows(
          showGroups ? navigation.groups : models,
          showGroups ? navigation.selectedGroupId : selector.selectedId,
          showGroups ? groupsFocused : modelFocused,
          rightWidth,
          listHeight,
          showGroups,
          "没有匹配模型",
          showGroups,
        ),
      );
    }
    right.push(
      cell(
        action ? `${actionSelected ? (modelFocused ? "›" : "◆") : " "} ${action.label}` : "",
        rightWidth,
        actionSelected ? (modelFocused ? "1;36" : "1") : undefined,
      ),
      cell(creating ? "" : `模型: ${selectedItem?.label ?? "未选择模型"}`, rightWidth),
      cell(
        creating
          ? ""
          : actionSelected
            ? "连接: 打开连接配置"
            : `连接: ${selectedItem?.description ?? (selectedItem ? "本地状态未提供" : "选择模型查看本地配置状态")}`,
        rightWidth,
      ),
      cell(
        feedback && feedback.kind !== "notice"
          ? `${feedback.kind === "blocking" ? "错误" : "提示"}: ${feedback.message}`
          : "",
        rightWidth,
        feedback?.kind === "blocking" ? "31" : undefined,
      ),
    );
  }

  const titleSegment = (columns: number): string => {
    const title = " Models ";
    return `${border("─")}${paint(title, "1")}${border("─".repeat(columns - 1 - visibleWidth(title)))}`;
  };
  const lines: string[] = [
    split
      ? `${border("╭")}${titleSegment(leftWidth)}${border(`┬${"─".repeat(rightWidth)}╮`)}`
      : `${border("╭")}${titleSegment(interiorWidth)}${border("╮")}`,
  ];
  const left = split
    ? [
        cell(
          `${groupsFocused && !configuration ? "›" : " "} 连接`,
          leftWidth,
          groupsFocused && !configuration ? "1;36" : "1",
        ),
        ...listRows(
          navigation.groups,
          navigation.selectedGroupId,
          groupsFocused && !configuration,
          leftWidth,
          bodyHeight - 1,
          true,
          "没有连接",
          true,
        ),
      ]
    : [];
  for (let row = 0; row < bodyHeight; row++) {
    lines.push(
      split
        ? `${border("│")}${left[row]!}${border("│")}${right[row]!}${border("│")}`
        : `${border("│")}${right[row]!}${border("│")}`,
    );
  }
  lines.push(
    border(
      split
        ? `├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`
        : `├${"─".repeat(interiorWidth)}┤`,
    ),
    `${border("│")}${cell(options.hint, interiorWidth)}${border("│")}`,
    border(`╰${"─".repeat(interiorWidth)}╯`),
  );
  return { lines, cursorRow, cursorColumn, showCursor };
}
