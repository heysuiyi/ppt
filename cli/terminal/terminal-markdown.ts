import { MicromarkAstBuilder } from "@incremark/core/engines/micromark";
import type { Definition, Nodes, Table } from "mdast";
import stringWidth from "string-width";
import { graphemes, sanitizeTerminalText, wrapTerminalText } from "./terminal-text.js";

interface Span {
  text: string;
  style: string;
}

// 复用现有 Markdown 引擎，不依赖 renderer/DOM，也不执行 HTML 或模型提供的终端转义。
const builder = new MicromarkAstBuilder({ gfm: true, math: false });
const reset = "\x1b[0m";

/** 只在 TUI 中投影 Markdown；视口硬换行，归档代码行交给终端软换行以保留复制内容。 */
export function markdownLines(
  text: string,
  columns: number,
  viewport = false,
  color = false,
): string[] {
  const source = sanitizeTerminalText(text);
  const root = builder.parse(source);
  const definitions = new Map<string, Definition>();
  const collect = (node: Nodes): void => {
    if (node.type === "definition") definitions.set(node.identifier.toUpperCase(), node);
    if ("children" in node) for (const child of node.children) collect(child);
  };
  collect(root);
  const raw = (node: Nodes): string =>
    source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? source.length);
  const paint = (value: string, style: string): string =>
    color && style && value ? `\x1b[${style}m${value}${reset}` : value;

  function inline(nodes: readonly Nodes[], style = ""): Span[] {
    return nodes.flatMap((node): Span[] => {
      const add = (code: string): string => (style ? `${style};${code}` : code);
      switch (node.type) {
        case "text":
          return [{ text: sanitizeTerminalText(node.value), style }];
        case "strong":
          return inline(node.children, add("1"));
        case "emphasis":
          return inline(node.children, add("3"));
        case "delete":
          return inline(node.children, add("9"));
        case "inlineCode":
          return [{ text: sanitizeTerminalText(node.value), style: add("36") }];
        case "break":
          return [{ text: "\n", style }];
        case "link":
        case "linkReference": {
          const url =
            node.type === "link" ? node.url : definitions.get(node.identifier.toUpperCase())?.url;
          const label = inline(node.children, add("4;36"));
          // 不发 OSC 8；地址作为可复制文字保留，不能让协议或控制字符触发终端动作。
          if (url && label.map((span) => span.text).join("") !== url)
            label.push({ text: ` (${sanitizeTerminalText(url)})`, style });
          return label;
        }
        case "image":
        case "imageReference": {
          const url =
            node.type === "image" ? node.url : definitions.get(node.identifier.toUpperCase())?.url;
          return [
            {
              text: `Image: ${sanitizeTerminalText(node.alt ?? "")}${url ? ` (${sanitizeTerminalText(url)})` : ""}`,
              style,
            },
          ];
        }
        default:
          return [{ text: sanitizeTerminalText("value" in node ? node.value : raw(node)), style }];
      }
    });
  }

  // 样式与文字分开度量；每段自行 reset，裁掉视口前文或换行后均不会丢失/泄漏样式。
  function wrap(spans: readonly Span[], budget: number): string[] {
    const width = Math.max(1, budget);
    const lines: string[] = [];
    let line = "";
    let used = 0;
    for (const span of spans) {
      let fragment = "";
      const flush = (): void => {
        line += paint(fragment, span.style);
        fragment = "";
      };
      for (const cluster of graphemes(span.text)) {
        if (cluster === "\n") {
          flush();
          lines.push(line);
          line = "";
          used = 0;
          continue;
        }
        const repeats = cluster === "\t" ? 4 - (used % 4) : 1;
        const value = cluster === "\t" ? " " : cluster;
        const size = stringWidth(value);
        for (let index = 0; index < repeats; index += 1) {
          if (used > 0 && used + size > width) {
            flush();
            lines.push(line);
            line = "";
            used = 0;
          }
          fragment += value;
          used += size;
        }
      }
      flush();
    }
    lines.push(line);
    return lines;
  }

  function table(node: Table, width: number): string[] {
    const rows = node.children.map((row, index) =>
      row.children.map((cell) => inline(cell.children, index === 0 ? "1" : "")),
    );
    const count = rows[0]?.length ?? 0;
    if (!count) return [];
    const textRows = rows.map((row) => row.map((cell) => cell.map((span) => span.text).join("")));
    const sizes = Array.from({ length: count }, (_, column) =>
      Math.max(1, ...textRows.map((row) => stringWidth(row[column] ?? ""))),
    );
    const minimum = Array.from({ length: count }, (_, column) =>
      Math.max(
        1,
        ...textRows.flatMap((row) =>
          graphemes(row[column] ?? "").map((cluster) => stringWidth(cluster)),
        ),
      ),
    );
    const available = width - (3 * count + 1);
    if (minimum.reduce((sum, size) => sum + size, 0) > available)
      return wrapTerminalText(raw(node), width);
    let total = sizes.reduce((sum, size) => sum + size, 0);
    while (total > available) {
      let widest = -1;
      for (let column = 0; column < count; column += 1)
        if (sizes[column]! > minimum[column]! && (widest < 0 || sizes[column]! > sizes[widest]!))
          widest = column;
      if (widest < 0) break;
      sizes[widest]! -= 1;
      total -= 1;
    }
    const border = (left: string, middle: string, right: string): string =>
      paint(`${left}${sizes.map((size) => "─".repeat(size + 2)).join(middle)}${right}`, "2");
    const lines = [border("┌", "┬", "┐")];
    rows.forEach((row, rowIndex) => {
      const cells = sizes.map((size, column) => wrap(row[column] ?? [], size));
      const height = Math.max(...cells.map((cell) => cell.length));
      for (let index = 0; index < height; index += 1) {
        const parts = cells.map((cell, column) => {
          const value = cell[index] ?? "";
          // 这里只剥离本模块发出的 SGR，不能把不可信输入作为 ANSI 接受。
          const gap = Math.max(
            0,
            sizes[column]! - stringWidth(value.replace(/\x1b\[[\d;]*m/g, "")),
          );
          const align = node.align?.[column];
          const left = align === "right" ? gap : align === "center" ? Math.floor(gap / 2) : 0;
          return `${" ".repeat(left)}${value}${" ".repeat(gap - left)}`;
        });
        lines.push(`│ ${parts.join(" │ ")} │`);
      }
      if (rowIndex === 0) lines.push(border("├", "┼", "┤"));
    });
    lines.push(border("└", "┴", "┘"));
    return lines;
  }

  function blocks(nodes: readonly Nodes[], width: number, tight = false): string[] {
    const result: string[] = [];
    for (const node of nodes) {
      let lines: string[];
      switch (node.type) {
        case "definition":
          continue;
        case "paragraph":
          lines = wrap(inline(node.children), width);
          break;
        case "heading": {
          const prefix = node.depth >= 3 || !color ? `${"#".repeat(node.depth)} ` : "";
          lines = wrap(
            [
              { text: prefix, style: "1;36" },
              ...inline(node.children, node.depth === 1 ? "1;4;36" : "1;36"),
            ],
            width,
          );
          break;
        }
        case "thematicBreak":
          lines = [paint("─".repeat(width), "2")];
          break;
        case "blockquote":
          lines =
            width < 4
              ? wrapTerminalText(raw(node), width)
              : blocks(node.children, width - 2).map((line) => `${paint("│ ", "2")}${line}`);
          break;
        case "list":
          lines = node.children.flatMap((item, index) => {
            const marker = node.ordered ? `${(node.start ?? 1) + index}. ` : "• ";
            const prefix = `${marker}${item.checked == null ? "" : item.checked ? "[x] " : "[ ] "}`;
            const indent = stringWidth(prefix);
            if (width - indent < 2) return wrapTerminalText(raw(item), width);
            const body = blocks(item.children, width - indent, !node.spread);
            return [
              ...(index > 0 && node.spread ? [""] : []),
              ...body.map((line, row) => `${row === 0 ? prefix : " ".repeat(indent)}${line}`),
            ];
          });
          break;
        case "code": {
          const original = raw(node).split("\n");
          const fence = /^ {0,3}(`{3,}|~{3,})/.exec(original[0] ?? "");
          lines = [];
          if (fence) lines.push(...wrap([{ text: original[0]!, style: "2" }], width));
          for (const line of node.value.split("\n")) {
            if (viewport)
              lines.push(...wrap([{ text: sanitizeTerminalText(line), style: "36" }], width));
            else lines.push(paint(sanitizeTerminalText(line), "36"));
          }
          // 未闭合的流式代码块不能凭空出现结束围栏。
          const last = original.at(-1) ?? "";
          const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(last);
          if (
            fence &&
            original.length > 1 &&
            closing &&
            closing[1]![0] === fence[1]![0] &&
            closing[1]!.length >= fence[1]!.length
          )
            lines.push(...wrap([{ text: last, style: "2" }], width));
          break;
        }
        case "table":
          lines = table(node, width);
          break;
        default:
          lines = wrap([{ text: raw(node), style: "" }], width);
      }
      if (result.length && !tight) result.push("");
      result.push(...lines);
    }
    return result;
  }

  return blocks(root.children, Math.max(1, Math.floor(columns)));
}
