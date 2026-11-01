interface SelectionPoint {
  node: Node;
  offset: number;
  textOffset: number | null;
  value: string | null;
}

function textOffset(root: HTMLElement, node: Node, offset: number): number {
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

function locate(root: HTMLElement, offset: number): [Node, number] {
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */);
  let node = walker.nextNode();
  while (node) {
    const length = (node as Text).length;
    if (offset <= length) return [node, offset];
    offset -= length;
    node = walker.nextNode();
  }
  return [root, root.childNodes.length];
}

function mapOffset(offset: number, before: string, after: string): number {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++;
  if (offset <= prefix) return offset;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix++;
  if (offset >= before.length - suffix) return offset + after.length - before.length;
  return Math.min(offset, after.length - suffix);
}

export function preserveSelection(root: HTMLElement, mutate: () => void): void {
  const selection = root.ownerDocument.getSelection();
  const anchorNode = selection?.anchorNode;
  const focusNode = selection?.focusNode;
  if (
    !selection?.rangeCount ||
    !anchorNode ||
    !focusNode ||
    (!root.contains(anchorNode) && !root.contains(focusNode))
  ) {
    mutate();
    return;
  }
  const capture = (node: Node, offset: number): SelectionPoint => ({
    node,
    offset,
    textOffset: root.contains(node) ? textOffset(root, node, offset) : null,
    value: node.nodeType === 3 ? (node as Text).data : null,
  });
  const anchor = capture(anchorNode, selection.anchorOffset);
  const focus = capture(focusNode, selection.focusOffset);
  const before = root.textContent ?? "";
  mutate();
  const after = root.textContent ?? "";
  const restore = (point: SelectionPoint): [Node, number] => {
    if (point.textOffset === null) return [point.node, point.offset];
    if (
      root.contains(point.node) &&
      point.value !== null &&
      point.node.textContent === point.value
    ) {
      return [point.node, point.offset];
    }
    return locate(root, mapOffset(point.textOffset, before, after));
  };
  // Unlike restoring a Range, this retains anchor/focus order for backward selections.
  selection.setBaseAndExtent(...restore(anchor), ...restore(focus));
}

export function patchText(node: Text, value: string): void {
  if (node.data === value) return;
  if (value.startsWith(node.data)) {
    node.appendData(value.slice(node.length));
    return;
  }
  let prefix = 0;
  let suffix = 0;
  while (prefix < node.length && prefix < value.length && node.data[prefix] === value[prefix])
    prefix++;
  while (
    suffix < node.length - prefix &&
    suffix < value.length - prefix &&
    node.data[node.length - suffix - 1] === value[value.length - suffix - 1]
  )
    suffix++;
  node.replaceData(
    prefix,
    node.length - prefix - suffix,
    value.slice(prefix, value.length - suffix),
  );
}
