export interface ChatScrollAnchor {
  rootKey: string;
  /** Element-child indices, relative to the stable root (never text/glyph nodes). */
  path: number[];
  viewportOffset: number;
}

export interface ChatScrollPosition {
  following: boolean;
  scrollTop: number;
  anchor: ChatScrollAnchor | null;
}

/** An opaque, single-use fold transaction token. */
export interface FoldToken {
  readonly anchor: HTMLElement;
}

export interface ChatScrollControllerOptions {
  /** Injected for tests; defaults to requestAnimationFrame. */
  scheduleFrame?: (cb: () => void) => number;
  cancelFrame?: (id: number) => void;
}

export interface ChatScrollController {
  setViewport(element: HTMLElement | null): void;
  setStream(element: HTMLElement | null): void;
  isFollowing(): boolean;
  setFollowing(value: boolean): void;
  subscribe(listener: () => void): () => void;
  capturePosition(): ChatScrollPosition;
  restorePosition(position: ChatScrollPosition): void;
  scrollToBottom(): void;
  stickToBottomIfFollowing(): void;
  beginFold(anchor: HTMLElement | null): FoldToken | null;
  commitFold(token: FoldToken | null): void;
  /** Bind intent/scroll listeners and observe both layout owners. */
  attach(): () => void;
  dispose(): void;
}

interface Metrics {
  top: number;
  height: number;
  viewportHeight: number;
}

interface ReadingAnchor {
  position: ChatScrollAnchor;
  element: HTMLElement | null;
}

interface UserScrollIntent {
  direction: number;
  top: number;
  allowFollowing: boolean;
  moved: boolean;
  programmatic: boolean;
}

interface FoldTransaction {
  tokens: Set<FoldToken>;
  position: ChatScrollPosition;
  header: HTMLElement;
  headerOffset: number;
}

const BOTTOM_EPSILON_PX = 2;
const SCROLL_EPSILON_PX = 0.5;
const ROOT_SELECTOR = "[data-chat-scroll-anchor]";
const BLOCK_SELECTOR = "p,li,pre,table,blockquote,h1,h2,h3,h4,h5,h6,hr,figure,summary,button";
const EDITABLE_SELECTOR = "input,textarea,select,[contenteditable]:not([contenteditable=false])";

/**
 * The sole writer of outer chat scrolling. Following is user permission, not a
 * geometric guess: layout changes and asynchronous script scrolls cannot grant it.
 */
export function createChatScrollController(
  options: ChatScrollControllerOptions = {},
): ChatScrollController {
  const scheduleFrame = options.scheduleFrame ?? ((cb) => window.requestAnimationFrame(cb));
  const cancelFrame = options.cancelFrame ?? ((id) => window.cancelAnimationFrame(id));
  const listeners = new Set<() => void>();
  let viewport: HTMLElement | null = null;
  let stream: HTMLElement | null = null;
  let following = true;
  let readingAnchor: ReadingAnchor | null = null;
  let fallbackTop = 0;
  let programmaticTop: number | null = null;
  let userIntent: UserScrollIntent | null = null;
  let fold: FoldTransaction | null = null;
  let followFrame: number | null = null;
  let frameRevision = 0;
  let detach: (() => void) | null = null;

  const measure = (): Metrics | null =>
    viewport
      ? {
          top: viewport.scrollTop,
          height: viewport.scrollHeight,
          viewportHeight: viewport.clientHeight,
        }
      : null;

  const isVisible = (element: HTMLElement): boolean =>
    !element.closest("[hidden]") &&
    element.getClientRects().length > 0 &&
    element.getBoundingClientRect().height > 0;

  const contentTop = (): number =>
    viewport ? viewport.getBoundingClientRect().top + viewport.clientTop : 0;

  const maximumTop = (metrics: Metrics): number =>
    Math.max(0, metrics.height - metrics.viewportHeight);

  const cancelFollow = () => {
    frameRevision += 1;
    if (followFrame !== null) cancelFrame(followFrame);
    followFrame = null;
  };

  const changeFollowing = (value: boolean) => {
    if (following === value) return;
    following = value;
    for (const listener of listeners) listener();
  };

  const consumeUserScroll = (metrics: Metrics): number => {
    if (programmaticTop !== null && Math.abs(metrics.top - programmaticTop) <= SCROLL_EPSILON_PX) {
      programmaticTop = null;
      if (userIntent) userIntent.top = metrics.top;
      return 0;
    }
    if (!userIntent) return 0;
    // Native clamping is layout, not a user reaching the bottom. Owned writes
    // rebase this baseline, so any residual motion still belongs to the gesture.
    const baseline = Math.min(maximumTop(metrics), Math.max(0, userIntent.top));
    const movement = metrics.top - baseline;
    userIntent.top = metrics.top;
    if (
      Math.abs(movement) <= SCROLL_EPSILON_PX ||
      (userIntent.direction < 0 && movement > 0) ||
      (userIntent.direction > 0 && movement < 0)
    ) {
      return 0;
    }
    programmaticTop = null;
    userIntent.moved = true;
    userIntent.programmatic = false;
    fold = null;
    if (movement < 0) {
      cancelFollow();
      changeFollowing(false);
    } else if (
      userIntent.allowFollowing &&
      maximumTop(metrics) - metrics.top <= BOTTOM_EPSILON_PX
    ) {
      readingAnchor = null;
      changeFollowing(true);
    }
    return movement;
  };

  const nestedScroller = (element: Element | null): HTMLElement | null => {
    for (let node = element; node && node !== viewport; node = node.parentElement) {
      if (!(node instanceof HTMLElement) || node.scrollHeight <= node.clientHeight + 1) continue;
      if (/(auto|scroll)/.test(window.getComputedStyle(node).overflowY)) return node;
    }
    return null;
  };

  const anchorFor = (element: HTMLElement): ReadingAnchor | null => {
    const root = element.closest<HTMLElement>(ROOT_SELECTOR);
    const rootKey = root?.getAttribute("data-chat-scroll-anchor");
    if (!root || !rootKey || !stream?.contains(root)) return null;
    const path: number[] = [];
    for (let node = element; node !== root; ) {
      const parent = node.parentElement;
      if (!parent) return null;
      path.push(Array.prototype.indexOf.call(parent.children, node));
      node = parent;
    }
    path.reverse();
    return {
      element,
      position: {
        rootKey,
        path,
        viewportOffset: element.getBoundingClientRect().top - contentTop(),
      },
    };
  };

  const findReadingAnchor = (): ReadingAnchor | null => {
    if (!viewport || !stream || !isVisible(viewport)) return null;
    const top = contentTop();
    const bottom = top + viewport.clientHeight;
    const visibleBlock = (element: HTMLElement): HTMLElement | null => {
      const candidate = nestedScroller(element) ?? element;
      if (!isVisible(candidate)) return null;
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > top && rect.top < bottom ? candidate : null;
    };
    // Prefer a visible paragraph/block to a large ancestor whose top is offscreen.
    for (const element of stream.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) {
      if (element.matches("li,blockquote,figure") && element.querySelector(BLOCK_SELECTOR))
        continue;
      const candidate = visibleBlock(element);
      const anchor = candidate && anchorFor(candidate);
      if (anchor) return anchor;
    }
    for (const element of stream.querySelectorAll<HTMLElement>(ROOT_SELECTOR)) {
      const candidate = visibleBlock(element);
      const anchor = candidate && anchorFor(candidate);
      if (anchor) return anchor;
    }
    return null;
  };

  const resolveAnchor = (position: ChatScrollAnchor): HTMLElement | null => {
    if (!stream) return null;
    for (const root of stream.querySelectorAll<HTMLElement>(ROOT_SELECTOR)) {
      if (root.getAttribute("data-chat-scroll-anchor") !== position.rootKey || !isVisible(root)) {
        continue;
      }
      let element: Element = root;
      for (const index of position.path) {
        const child = element.children.item(index);
        if (!child) return null;
        element = child;
      }
      return element instanceof HTMLElement && isVisible(element) ? element : null;
    }
    return null;
  };

  const rememberReadingPosition = () => {
    if (!viewport || !isVisible(viewport)) return;
    fallbackTop = viewport.scrollTop;
    readingAnchor = findReadingAnchor();
  };

  const writeScrollTop = (target: number, metrics: Metrics) => {
    if (!viewport) return;
    const next = Math.min(maximumTop(metrics), Math.max(0, Number.isFinite(target) ? target : 0));
    if (Math.abs(metrics.top - next) > SCROLL_EPSILON_PX) {
      viewport.scrollTop = next;
      // The native scroll event arrives later, not within this assignment.
      programmaticTop = viewport.scrollTop;
      if (userIntent) userIntent.programmatic = true;
    }
    fallbackTop = viewport.scrollTop;
    if (userIntent) userIntent.top = viewport.scrollTop;
  };

  const reconcile = (metrics = measure()) => {
    if (!viewport || !metrics || !isVisible(viewport)) return;
    const userMovement = consumeUserScroll(metrics);
    if (following) {
      writeScrollTop(maximumTop(metrics), metrics);
      return;
    }
    if (readingAnchor) {
      let element = readingAnchor.element;
      if (!element || !stream?.contains(element) || !isVisible(element)) {
        element = resolveAnchor(readingAnchor.position);
        readingAnchor.element = element;
      }
      if (element) {
        const anchoredTop =
          metrics.top +
          element.getBoundingClientRect().top -
          contentTop() -
          readingAnchor.position.viewportOffset;
        const target = Math.min(maximumTop(metrics), Math.max(0, anchoredTop)) + userMovement;
        writeScrollTop(target, metrics);
        if (userMovement !== 0 || Math.abs(anchoredTop - viewport.scrollTop) > SCROLL_EPSILON_PX) {
          // A clipped boundary is an achievable new reading position, not permission to follow.
          rememberReadingPosition();
        }
        return;
      }
    }
    writeScrollTop(Math.min(maximumTop(metrics), Math.max(0, fallbackTop)) + userMovement, metrics);
    readingAnchor = findReadingAnchor();
  };

  const capturePosition = (): ChatScrollPosition => {
    reconcile();
    rememberReadingPosition();
    return {
      following,
      scrollTop: fallbackTop,
      anchor: readingAnchor
        ? { ...readingAnchor.position, path: [...readingAnchor.position.path] }
        : null,
    };
  };

  const setFollowing = (value: boolean) => {
    cancelFollow();
    fold = null;
    userIntent = null;
    if (!value) rememberReadingPosition();
    else readingAnchor = null;
    changeFollowing(value);
  };

  const restorePosition = (position: ChatScrollPosition) => {
    cancelFollow();
    fold = null;
    userIntent = null;
    fallbackTop = position.scrollTop;
    readingAnchor = position.anchor
      ? {
          position: { ...position.anchor, path: [...position.anchor.path] },
          element: null,
        }
      : null;
    changeFollowing(position.following);
    reconcile();
  };

  const scrollToBottom = () => {
    cancelFollow();
    userIntent = null;
    const metrics = measure();
    if (metrics) writeScrollTop(maximumTop(metrics), metrics);
    if (!following) rememberReadingPosition();
  };

  const stickToBottomIfFollowing = () => {
    if (!following || !viewport || followFrame !== null) return;
    const revision = frameRevision;
    followFrame = scheduleFrame(() => {
      if (revision !== frameRevision) return;
      followFrame = null;
      if (following) reconcile();
    });
  };

  const beginFold = (header: HTMLElement | null): FoldToken | null => {
    if (!viewport || !header || !viewport.contains(header) || header.closest("[hidden]"))
      return null;
    cancelFollow();
    if (!fold) {
      fold = {
        tokens: new Set(),
        position: capturePosition(),
        header,
        headerOffset: header.getBoundingClientRect().top - contentTop(),
      };
    }
    const token: FoldToken = { anchor: header };
    fold.tokens.add(token);
    return token;
  };

  const commitFold = (token: FoldToken | null) => {
    if (!token || !fold?.tokens.delete(token)) return;
    if (!viewport?.contains(token.anchor) || token.anchor.closest("[hidden]")) {
      fold = null;
      return;
    }
    if (fold.tokens.size > 0) return;
    const transaction = fold;
    fold = null;
    if (following) {
      reconcile();
      return;
    }
    const saved = transaction.position.anchor;
    const element = saved ? resolveAnchor(saved) : null;
    if (saved && element) {
      readingAnchor = { position: saved, element };
      reconcile();
    } else if (stream?.contains(transaction.header) && isVisible(transaction.header)) {
      const metrics = measure();
      if (metrics) {
        writeScrollTop(
          metrics.top +
            transaction.header.getBoundingClientRect().top -
            contentTop() -
            transaction.headerOffset,
          metrics,
        );
      }
      rememberReadingPosition();
    } else {
      fallbackTop = transaction.position.scrollTop;
      readingAnchor = saved ? { position: saved, element: null } : null;
      reconcile();
    }
  };

  const attach = (): (() => void) => {
    detach?.();
    if (!viewport) return () => {};
    const boundViewport = viewport;
    const ownerDocument = boundViewport.ownerDocument;
    let active = true;
    let touchY: number | null = null;
    let pointer: {
      x: number;
      y: number;
      selection: boolean;
      scrollbar: boolean;
      moved: boolean;
    } | null = null;
    let selecting = false;
    if (!following && !readingAnchor) rememberReadingPosition();

    const pause = () => {
      cancelFollow();
      fold = null;
      if (following || !readingAnchor) rememberReadingPosition();
      changeFollowing(false);
    };

    const startIntent = (direction: number) => {
      const metrics = measure();
      if (!metrics) return;
      if (userIntent || !following) reconcile(metrics);
      programmaticTop = null;
      fold = null;
      if (direction < 0) pause();
      userIntent = {
        direction,
        top: boundViewport.scrollTop,
        allowFollowing: !selecting,
        moved: false,
        programmatic: false,
      };
    };

    const eventElement = (target: EventTarget | null): Element | null =>
      target instanceof Element ? target : null;

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY === 0 || nestedScroller(eventElement(event.target))) return;
      startIntent(Math.sign(event.deltaY));
    };

    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches.item(0)?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches.item(0)?.clientY ?? null;
      if (touchY !== null && nextY !== null && !nestedScroller(eventElement(event.target))) {
        const direction = Math.sign(touchY - nextY);
        if (direction !== 0) startIntent(direction);
      }
      touchY = nextY;
    };
    const onTouchEnd = () => {
      touchY = null;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const element = eventElement(event.target);
      if (
        event.defaultPrevented ||
        element?.closest(EDITABLE_SELECTOR) ||
        nestedScroller(element)
      ) {
        return;
      }
      let direction = 0;
      switch (event.key) {
        case "ArrowUp":
        case "PageUp":
        case "Home":
          direction = -1;
          break;
        case "ArrowDown":
        case "PageDown":
        case "End":
          direction = 1;
          break;
        case " ":
          if (!element?.closest("button,a")) direction = event.shiftKey ? -1 : 1;
          break;
      }
      if (direction !== 0) startIntent(direction);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || nestedScroller(eventElement(event.target))) return;
      const rect = boundViewport.getBoundingClientRect();
      const scrollbar =
        event.target === boundViewport &&
        (event.clientX < rect.left + boundViewport.clientLeft ||
          event.clientX >= rect.left + boundViewport.clientLeft + boundViewport.clientWidth);
      const selection = !eventElement(event.target)?.closest(`button,a,${EDITABLE_SELECTOR}`);
      pointer = { x: event.clientX, y: event.clientY, selection, scrollbar, moved: false };
      selecting = false;
      if (scrollbar) {
        pause();
        startIntent(0);
      }
    };

    const onSelectionChange = () => {
      if (!pointer?.selection || !pointer.moved || pointer.scrollbar || selecting) return;
      const selection = ownerDocument.getSelection();
      if (
        selection?.isCollapsed === false &&
        boundViewport.contains(selection.anchorNode) &&
        boundViewport.contains(selection.focusNode)
      ) {
        selecting = true;
        pause();
        startIntent(0);
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (
        !pointer?.selection ||
        Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 3
      ) {
        return;
      }
      pointer.moved = true;
      onSelectionChange();
    };
    const onPointerUp = () => {
      if (pointer?.scrollbar || selecting) {
        reconcile();
        userIntent = null;
      }
      pointer = null;
      selecting = false;
    };

    const onScroll = (event: Event) => {
      if (event.target !== boundViewport) return;
      reconcile();
    };
    const onScrollEnd = (event: Event) => {
      if (event.target !== boundViewport) return;
      reconcile();
      // A correction can finish before the browser applies the wheel default.
      // Its scrollend must not retire that still-pending user gesture.
      if (userIntent?.moved && !userIntent.programmatic) userIntent = null;
    };

    boundViewport.addEventListener("wheel", onWheel, { passive: true });
    boundViewport.addEventListener("touchstart", onTouchStart, { passive: true });
    boundViewport.addEventListener("touchmove", onTouchMove, { passive: true });
    boundViewport.addEventListener("touchend", onTouchEnd, { passive: true });
    boundViewport.addEventListener("touchcancel", onTouchEnd, { passive: true });
    boundViewport.addEventListener("keydown", onKeyDown);
    boundViewport.addEventListener("pointerdown", onPointerDown);
    boundViewport.addEventListener("scroll", onScroll, { passive: true });
    boundViewport.addEventListener("scrollend", onScrollEnd);
    ownerDocument.addEventListener("pointermove", onPointerMove);
    ownerDocument.addEventListener("pointerup", onPointerUp);
    ownerDocument.addEventListener("pointercancel", onPointerUp);
    ownerDocument.addEventListener("selectionchange", onSelectionChange);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        if (!active) return;
        // ResizeObserver runs before paint; another RAF would expose a jumped frame.
        cancelFollow();
        reconcile();
      });
      observer.observe(boundViewport);
      if (stream && stream !== boundViewport) observer.observe(stream);
    }

    const cleanup = () => {
      if (!active) return;
      active = false;
      boundViewport.removeEventListener("wheel", onWheel);
      boundViewport.removeEventListener("touchstart", onTouchStart);
      boundViewport.removeEventListener("touchmove", onTouchMove);
      boundViewport.removeEventListener("touchend", onTouchEnd);
      boundViewport.removeEventListener("touchcancel", onTouchEnd);
      boundViewport.removeEventListener("keydown", onKeyDown);
      boundViewport.removeEventListener("pointerdown", onPointerDown);
      boundViewport.removeEventListener("scroll", onScroll);
      boundViewport.removeEventListener("scrollend", onScrollEnd);
      ownerDocument.removeEventListener("pointermove", onPointerMove);
      ownerDocument.removeEventListener("pointerup", onPointerUp);
      ownerDocument.removeEventListener("pointercancel", onPointerUp);
      ownerDocument.removeEventListener("selectionchange", onSelectionChange);
      observer?.disconnect();
      cancelFollow();
      userIntent = null;
      fold = null;
      if (detach === cleanup) detach = null;
    };
    detach = cleanup;
    return cleanup;
  };

  return {
    setViewport(element) {
      if (viewport === element) return;
      detach?.();
      viewport = element;
      readingAnchor = null;
      programmaticTop = null;
    },
    setStream(element) {
      if (stream === element) return;
      detach?.();
      stream = element;
      readingAnchor = null;
    },
    isFollowing: () => following,
    setFollowing,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    capturePosition,
    restorePosition,
    scrollToBottom,
    stickToBottomIfFollowing,
    beginFold,
    commitFold,
    attach,
    dispose() {
      detach?.();
      cancelFollow();
      viewport = null;
      stream = null;
      readingAnchor = null;
      programmaticTop = null;
      userIntent = null;
      fold = null;
    },
  };
}
