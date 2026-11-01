import { createIncremarkParser, type IncremarkPlugin } from "@incremark/core";
import { MicromarkAstBuilder } from "@incremark/core/engines/micromark";
import type { Element, Root as HastRoot } from "hast";
import type { Html, Root as MdastRoot } from "mdast";
import { toHast } from "mdast-util-to-hast";
import { find, html, svg } from "property-information";

interface LiteralHtml extends Omit<Html, "type"> {
  type: "literalHtml";
}

declare module "mdast" {
  interface BlockContentMap {
    literalHtml: LiteralHtml;
  }
  interface PhrasingContentMap {
    literalHtml: LiteralHtml;
  }
  interface RootContentMap {
    literalHtml: LiteralHtml;
  }
}

interface MutableSyntaxNode {
  type: string;
  children?: MutableSyntaxNode[];
}

function preserveLiteralHtml(node: MutableSyntaxNode): void {
  if (node.type === "html") node.type = "literalHtml";
  for (const child of node.children ?? []) preserveLiteralHtml(child);
}

// Preserve HTML boundaries before Incremark's HTML-to-paragraph conversion.
// This is the public micromark transform hook, not a parser implementation patch.
const literalHtmlPlugin: IncremarkPlugin = {
  name: "literal-html-boundaries",
  type: "micromark",
  micromark: {
    extensions: [],
    mdastExtensions: [{ transforms: [preserveLiteralHtml] }],
  },
};

export function createMarkdownParser() {
  return createIncremarkParser({
    astBuilder: MicromarkAstBuilder,
    gfm: true,
    math: false,
    plugins: [literalHtmlPlugin],
  });
}

// The same relative-URL rules and protocol whitelist as ReactMarkdown's
// defaultUrlTransform. Raw HTML is always literal, so it cannot introduce URLs.
export function safeMarkdownUrl(value: string): string {
  const colon = value.indexOf(":");
  const slash = value.indexOf("/");
  const question = value.indexOf("?");
  const hash = value.indexOf("#");
  return colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (question !== -1 && colon > question) ||
    (hash !== -1 && colon > hash) ||
    /^(https?|ircs?|mailto|xmpp)$/i.test(value.slice(0, colon))
    ? value
    : "";
}

function sanitizeElement(element: Element): void {
  for (const key of Object.keys(element.properties)) {
    if (/^on/i.test(key) || key === "style") delete element.properties[key];
    else if (
      ["href", "src", "cite", "action", "formAction", "poster", "longDesc", "xLinkHref"].includes(
        key,
      )
    ) {
      element.properties[key] = safeMarkdownUrl(String(element.properties[key] ?? ""));
    }
  }
  const alignment = element.properties.align;
  if (
    (element.tagName === "th" || element.tagName === "td") &&
    (alignment === "left" || alignment === "right" || alignment === "center")
  ) {
    delete element.properties.align;
    element.properties.style = `text-align: ${alignment};`;
  }
  if (["table", "thead", "tbody", "tfoot", "tr"].includes(element.tagName)) {
    element.children = element.children.filter(
      (child) => child.type !== "text" || Boolean(child.value.trim()),
    );
  }
}

export function markdownToHast(ast: MdastRoot): HastRoot {
  // One conversion for the entire document is essential: toHast owns global
  // reference numbering, repeated-reference backrefs, and the single footer.
  const tree = toHast(ast, {
    handlers: { literalHtml: (_state, node: LiteralHtml) => ({ type: "text", value: node.value }) },
  }) as HastRoot;
  const visit = (node: HastRoot | Element): void => {
    if (node.type === "element") sanitizeElement(node);
    for (const child of node.children) if (child.type === "element") visit(child);
  };
  visit(tree);
  return tree;
}

export function markdownAttributes(element: Element, svgSpace: boolean): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const [property, value] of Object.entries(element.properties)) {
    if (value == null) continue;
    const info = find(svgSpace ? svg : html, property);
    if (info.boolean || info.overloadedBoolean) {
      if (value === false) continue;
      if (value === true) {
        attributes.set(info.attribute, "");
        continue;
      }
    }
    attributes.set(
      info.attribute,
      Array.isArray(value) ? value.join(info.commaSeparated ? ", " : " ") : String(value),
    );
  }
  return attributes;
}
