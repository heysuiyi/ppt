import type { Selector } from "./input-contract.js";
import type { TerminalSelectionItem } from "./terminal-contract.js";

export function createSelector(
  items: readonly TerminalSelectionItem[],
  selectedId: string | null = null,
): Selector {
  let query = "";
  let visible = [...items];
  let selected = visible.some((item) => item.id === selectedId) ? selectedId : null;

  return {
    get query() {
      return query;
    },
    get items() {
      return visible;
    },
    get selectedId() {
      return selected;
    },
    search(text) {
      query = text;
      const needle = query.normalize("NFKC").toLocaleLowerCase();
      visible = items.filter((item) =>
        `${item.label}\n${item.description ?? ""}`
          .normalize("NFKC")
          .toLocaleLowerCase()
          .includes(needle),
      );
      if (!visible.some((item) => item.id === selected)) selected = null;
    },
    move(direction) {
      if (visible.length === 0) {
        selected = null;
        return;
      }
      const index = visible.findIndex((item) => item.id === selected);
      const next =
        index < 0
          ? direction > 0
            ? 0
            : visible.length - 1
          : (index + direction + visible.length) % visible.length;
      selected = visible[next]?.id ?? null;
    },
    accept() {
      return selected ?? undefined;
    },
  };
}
