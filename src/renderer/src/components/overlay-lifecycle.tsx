import { createContext, useContext, useLayoutEffect, useRef } from "react";

interface OverlayOwner {
  depth: number;
  portalHost: HTMLElement | null;
}

export const OverlayContext = createContext<OverlayOwner>({ depth: 0, portalHost: null });
export const useOverlayOwner = () => useContext(OverlayContext);

interface Layer {
  depth: number;
  root: () => HTMLElement | null;
  trigger?: () => HTMLElement | null;
  modal?: boolean;
  dismiss: () => void;
  outside?: boolean;
  keydown?: (event: KeyboardEvent) => void;
  tab?: () => void;
}

const layers: Layer[] = [];
const inertElements = new Map<HTMLElement, boolean>();
let observer: MutationObserver | null = null;
let previousOverflow = "";
const ordered = () => [...layers].sort((a, b) => a.depth - b.depth);
const topLayer = () => ordered().at(-1);
const topModal = () =>
  ordered()
    .filter((layer) => layer.modal)
    .at(-1);
const contains = (layer: Layer, target: Node) =>
  Boolean(layer.root()?.contains(target) || layer.trigger?.()?.contains(target));

function focusable(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button, input, textarea, select, a[href], [tabindex], [contenteditable="true"]',
    ),
  ].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      !element.closest('[inert], [hidden], [aria-hidden="true"]') &&
      element.getClientRects().length > 0,
  );
}

function focusFirst(layer: Layer) {
  const root = layer.root();
  if (root) (focusable(root)[0] ?? root).focus();
}

function syncInert() {
  const modal = topModal();
  const root = modal?.root();
  for (const [element, inert] of inertElements) element.inert = inert;
  inertElements.clear();
  if (!root) return;
  for (const element of document.body.children) {
    if (!(element instanceof HTMLElement) || element.contains(root)) continue;
    inertElements.set(element, element.inert);
    element.inert = true;
  }
}

function onKeyDown(event: KeyboardEvent) {
  const top = topLayer();
  if (!top) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    top.dismiss();
    return;
  }
  if (event.key === "Tab") {
    top.tab?.();
    const modal = topModal();
    const root = modal?.root();
    if (!root) return;
    const items = focusable(root);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (
      items.length === 0 ||
      (event.shiftKey ? index <= 0 : index < 0 || index === items.length - 1)
    ) {
      event.preventDefault();
      (event.shiftKey ? (items.at(-1) ?? root) : (items[0] ?? root)).focus();
    }
    return;
  }
  top.keydown?.(event);
}

function onPointerDown(event: PointerEvent) {
  const top = topLayer();
  if (top?.outside && event.target instanceof Node && !contains(top, event.target)) top.dismiss();
}

function onFocusIn(event: FocusEvent) {
  const modal = topModal();
  if (modal && event.target instanceof Node && !modal.root()?.contains(event.target))
    focusFirst(modal);
}

function start() {
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("focusin", onFocusIn, true);
  observer = new MutationObserver(syncInert);
  observer.observe(document.body, { childList: true });
}

function stop() {
  document.removeEventListener("keydown", onKeyDown, true);
  document.removeEventListener("pointerdown", onPointerDown, true);
  document.removeEventListener("focusin", onFocusIn, true);
  observer?.disconnect();
  observer = null;
}

export function useOverlayLayer(open: boolean, options: Layer) {
  const latest = useRef(options);
  latest.current = options;
  const layerRef = useRef<Layer | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer: Layer = {
      depth: latest.current.depth,
      modal: latest.current.modal,
      root: () => latest.current.root(),
      trigger: () => latest.current.trigger?.() ?? null,
      dismiss: () => latest.current.dismiss(),
      get outside() {
        return latest.current.outside;
      },
      keydown: (event) => latest.current.keydown?.(event),
      tab: () => latest.current.tab?.(),
    };
    layerRef.current = layer;
    if (layers.length === 0) start();
    if (layer.modal && !topModal()) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    layers.push(layer);
    syncInert();
    if (layer.modal) focusFirst(layer);
    return () => {
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
      layerRef.current = null;
      syncInert();
      if (layer.modal && !topModal()) document.body.style.overflow = previousOverflow;
      if (layers.length === 0) stop();
      const active = document.activeElement;
      if (
        previousFocus?.isConnected &&
        !previousFocus.closest("[inert]") &&
        (active === document.body || (active instanceof Node && contains(layer, active)))
      )
        previousFocus.focus();
    };
  }, [open]);
  return () => topLayer() === layerRef.current;
}
