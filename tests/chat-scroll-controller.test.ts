// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ChatScrollController,
  createChatScrollController,
} from "../app/renderer/src/components/chat-scroll-controller";

function rectangle(top: number, height: number, width = 320): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: width,
    width,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function mountFixture(
  options: { scrollTop?: number; scrollHeight?: number; clientHeight?: number } = {},
) {
  const viewport = document.createElement("div");
  const stream = document.createElement("div");
  const message = document.createElement("div");
  const markdown = document.createElement("div");
  const host = document.createElement("div");
  const header = document.createElement("button");
  viewport.className = "chat-scroll-viewport";
  stream.className = "chat-stream";
  message.dataset.chatScrollAnchor = "message:message-1";
  markdown.dataset.chatScrollAnchor = "markdown:document-1";
  header.textContent = "Thoughts";
  let height = options.scrollHeight ?? 1200;
  let clientHeight = options.clientHeight ?? 400;
  let top = options.scrollTop ?? 800;
  let headerY = 100;
  let writes = 0;
  const blockY = [0, 200, 400, 600, 800, 1000];
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, get: () => clientHeight },
    clientWidth: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, get: () => height },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        writes += 1;
        top = Math.min(Math.max(0, height - clientHeight), Math.max(0, value));
      },
    },
  });
  viewport.getBoundingClientRect = () => rectangle(100, clientHeight);
  viewport.getClientRects = () => [viewport.getBoundingClientRect()] as unknown as DOMRectList;
  for (const element of [stream, message, markdown, host]) {
    element.getBoundingClientRect = () => rectangle(100 - top, height);
    element.getClientRects = () => [element.getBoundingClientRect()] as unknown as DOMRectList;
  }
  header.getBoundingClientRect = () => rectangle(100 + headerY - top, 20);
  header.getClientRects = () => [header.getBoundingClientRect()] as unknown as DOMRectList;
  const paragraphs = blockY.map((_, index) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = `Stable paragraph ${index}`;
    paragraph.getBoundingClientRect = () => rectangle(100 + blockY[index]! - top, 160);
    paragraph.getClientRects = () => [paragraph.getBoundingClientRect()] as unknown as DOMRectList;
    host.appendChild(paragraph);
    return paragraph;
  });
  markdown.appendChild(host);
  message.appendChild(markdown);
  stream.append(header, message);
  viewport.appendChild(stream);
  document.body.appendChild(viewport);
  return {
    viewport,
    stream,
    message,
    markdown,
    host,
    header,
    paragraphs,
    resize(next: { scrollHeight?: number; clientHeight?: number }) {
      height = next.scrollHeight ?? height;
      clientHeight = next.clientHeight ?? clientHeight;
      // Emulate the browser's automatic clamp, not an imperative scroll write.
      top = Math.min(top, Math.max(0, height - clientHeight));
    },
    shiftContentAbove(delta: number) {
      for (let index = 0; index < blockY.length; index += 1) blockY[index]! += delta;
      headerY += delta;
      height += delta;
      top = Math.min(top, Math.max(0, height - clientHeight));
    },
    scroll(next: number, dispatch = true) {
      top = Math.min(Math.max(0, height - clientHeight), Math.max(0, next));
      if (dispatch) viewport.dispatchEvent(new Event("scroll"));
    },
    wheel(deltaY: number, target: HTMLElement = viewport) {
      target.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }));
    },
    get writes() {
      return writes;
    },
  };
}

interface ObserverFixture {
  callback: ResizeObserverCallback;
  observed: Set<Element>;
  disconnected: boolean;
}

let observers: ObserverFixture[] = [];
const controllers: ChatScrollController[] = [];

function setup(options?: Parameters<typeof mountFixture>[0]) {
  const fixture = mountFixture(options);
  const frames = new Map<number, () => void>();
  let frameId = 0;
  const controller = createChatScrollController({
    scheduleFrame: (callback) => {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
  });
  controllers.push(controller);
  controller.setViewport(fixture.viewport);
  controller.setStream(fixture.stream);
  const detach = controller.attach();
  const observer = observers.at(-1)!;
  return {
    ...fixture,
    controller,
    frames,
    observer,
    detach,
    runFrames() {
      const pending = [...frames.values()];
      frames.clear();
      for (const frame of pending) frame();
    },
    fireResize(target: Element = fixture.stream) {
      if (observer.observed.has(target)) observer.callback([], {} as ResizeObserver);
    },
    get writes() {
      return fixture.writes;
    },
  };
}

function touch(element: HTMLElement, type: string, clientY: number) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "touches", {
    value: { item: (index: number) => (index === 0 ? { clientY } : null) },
  });
  element.dispatchEvent(event);
}

beforeEach(() => {
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private fixture: ObserverFixture;
      constructor(callback: ResizeObserverCallback) {
        this.fixture = { callback, observed: new Set(), disconnected: false };
        observers.push(this.fixture);
      }
      observe(element: Element) {
        this.fixture.observed.add(element);
      }
      unobserve(element: Element) {
        this.fixture.observed.delete(element);
      }
      disconnect() {
        this.fixture.disconnected = true;
      }
    },
  );
});

afterEach(() => {
  for (const controller of controllers) controller.dispose();
  controllers.length = 0;
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("chat-scroll-controller", () => {
  it("coalesces following and writes the clamped bottom only when it changes", () => {
    const fixture = setup({ scrollTop: 0, scrollHeight: 800 });
    fixture.controller.stickToBottomIfFollowing();
    fixture.controller.stickToBottomIfFollowing();
    expect(fixture.frames.size).toBe(1);
    fixture.resize({ scrollHeight: 900 });
    fixture.runFrames();
    expect(fixture.viewport.scrollTop).toBe(500);
    expect(fixture.writes).toBe(1);
    fixture.controller.stickToBottomIfFollowing();
    fixture.runFrames();
    expect(fixture.writes).toBe(1);
  });

  it("exits following immediately for a 24px upward wheel near the bottom", () => {
    const fixture = setup();
    fixture.controller.stickToBottomIfFollowing();
    fixture.wheel(-24);
    expect(fixture.controller.isFollowing()).toBe(false);
    expect(fixture.frames.size).toBe(0);
    fixture.scroll(776);
    fixture.runFrames();
    expect(fixture.viewport.scrollTop).toBe(776);
    fixture.shiftContentAbove(80);
    fixture.fireResize();
    expect(fixture.viewport.scrollTop).toBe(856);
    expect(fixture.controller.isFollowing()).toBe(false);
  });

  it.each(["resize first", "native scroll first"])(
    "keeps an upward wheel's 24px reading offset through concurrent growth (%s)",
    (order) => {
      const fixture = setup();
      fixture.viewport.addEventListener(
        "wheel",
        () => {
          fixture.shiftContentAbove(156);
          if (order === "resize first") {
            fixture.fireResize();
            fixture.viewport.dispatchEvent(new Event("scroll"));
            fixture.viewport.dispatchEvent(new Event("scrollend"));
          }
        },
        { once: true },
      );
      fixture.wheel(-24);
      if (order === "resize first") {
        fixture.scroll(fixture.viewport.scrollTop - 24);
      } else {
        fixture.scroll(776, false);
        fixture.fireResize();
        fixture.viewport.dispatchEvent(new Event("scroll"));
        fixture.viewport.dispatchEvent(new Event("scrollend"));
      }
      expect(fixture.viewport.scrollTop).toBe(932);
      expect(fixture.controller.isFollowing()).toBe(false);
      const paragraphTop = fixture.paragraphs[4]!.getBoundingClientRect().top;
      fixture.shiftContentAbove(156);
      fixture.fireResize();
      expect(
        fixture.viewport.scrollHeight - fixture.viewport.clientHeight - fixture.viewport.scrollTop,
      ).toBe(24);
      expect(fixture.paragraphs[4]!.getBoundingClientRect().top).toBe(paragraphTop);
      expect(fixture.controller.isFollowing()).toBe(false);
    },
  );

  it.each(["resize first", "native scroll first"])(
    "resumes when a real downward wheel reaches bottom despite interleaved layout (%s)",
    (order) => {
      const fixture = setup({ scrollTop: 500 });
      fixture.controller.setFollowing(false);
      fixture.viewport.addEventListener(
        "wheel",
        () => {
          fixture.shiftContentAbove(156);
          if (order === "resize first") {
            fixture.fireResize();
            fixture.viewport.dispatchEvent(new Event("scroll"));
            fixture.viewport.dispatchEvent(new Event("scrollend"));
          }
        },
        { once: true },
      );
      fixture.wheel(10000);
      const bottom = fixture.viewport.scrollHeight - fixture.viewport.clientHeight;
      fixture.scroll(bottom, order === "resize first");
      if (order !== "resize first") {
        fixture.fireResize();
        fixture.viewport.dispatchEvent(new Event("scroll"));
        fixture.viewport.dispatchEvent(new Event("scrollend"));
      }
      expect(fixture.viewport.scrollTop).toBe(bottom);
      expect(fixture.controller.isFollowing()).toBe(true);
    },
  );

  it("resumes only after actual downward user motion reaches a 2px bottom epsilon", () => {
    const fixture = setup();
    const listener = vi.fn();
    fixture.controller.subscribe(listener);
    fixture.controller.setFollowing(false);
    fixture.controller.setFollowing(false);
    fixture.scroll(800); // No user intent: an external/script scroll cannot grant permission.
    expect(fixture.controller.isFollowing()).toBe(false);
    fixture.wheel(-24);
    fixture.scroll(776);
    fixture.wheel(10);
    fixture.scroll(790);
    expect(fixture.controller.isFollowing()).toBe(false);
    fixture.wheel(10);
    fixture.scroll(799);
    expect(fixture.controller.isFollowing()).toBe(true);
    fixture.controller.setFollowing(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not mistake an asynchronous controller scroll or resize clamp for user resume", () => {
    const fixture = setup({ scrollTop: 300 });
    fixture.controller.restorePosition({ following: false, scrollTop: 750, anchor: null });
    fixture.viewport.dispatchEvent(new Event("scroll"));
    expect(fixture.controller.isFollowing()).toBe(false);
    fixture.wheel(20);
    fixture.resize({ clientHeight: 450 });
    fixture.viewport.dispatchEvent(new Event("scroll"));
    fixture.fireResize();
    expect(fixture.viewport.scrollTop).toBe(750);
    expect(fixture.controller.isFollowing()).toBe(false);
    fixture.resize({ scrollHeight: 300 });
    fixture.viewport.dispatchEvent(new Event("scroll"));
    expect(fixture.viewport.scrollTop).toBe(0);
    expect(fixture.controller.isFollowing()).toBe(false);
  });

  it("observes viewport shrink and follows synchronously before paint, without another frame", () => {
    const fixture = setup();
    fixture.controller.stickToBottomIfFollowing();
    fixture.resize({ clientHeight: 320 });
    fixture.fireResize(fixture.viewport);
    expect(fixture.viewport.scrollTop).toBe(880);
    expect(fixture.frames.size).toBe(0);
    expect(fixture.writes).toBe(1);
    fixture.fireResize();
    expect(fixture.writes).toBe(1);
  });

  it("preserves the first visible stable paragraph through upstream grow and shrink", () => {
    const fixture = setup({ scrollTop: 300 });
    fixture.controller.setFollowing(false);
    const paragraphTop = fixture.paragraphs[1]!.getBoundingClientRect().top;
    fixture.shiftContentAbove(80);
    fixture.fireResize();
    expect(fixture.viewport.scrollTop).toBe(380);
    expect(fixture.paragraphs[1]!.getBoundingClientRect().top).toBe(paragraphTop);
    fixture.shiftContentAbove(-60);
    fixture.fireResize();
    expect(fixture.viewport.scrollTop).toBe(320);
    expect(fixture.paragraphs[1]!.getBoundingClientRect().top).toBe(paragraphTop);
    fixture.resize({ clientHeight: 280 });
    fixture.fireResize();
    expect(fixture.paragraphs[1]!.getBoundingClientRect().top).toBe(paragraphTop);
    expect(fixture.frames.size).toBe(0);
    expect(fixture.controller.isFollowing()).toBe(false);
  });

  it("captures a new reading anchor after actual user scroll, not the previous paragraph", () => {
    const fixture = setup({ scrollTop: 300 });
    fixture.controller.setFollowing(false);
    fixture.wheel(200);
    fixture.scroll(500);
    const position = fixture.controller.capturePosition();
    expect(position).toEqual({
      following: false,
      scrollTop: 500,
      anchor: { rootKey: "markdown:document-1", path: [0, 2], viewportOffset: -100 },
    });
    fixture.shiftContentAbove(80);
    fixture.fireResize();
    expect(fixture.viewport.scrollTop).toBe(580);
    expect(fixture.controller.isFollowing()).toBe(false);
  });

  it("restores a serializable block anchor after content above changes", () => {
    const fixture = setup({ scrollTop: 300 });
    fixture.controller.setFollowing(false);
    const position = JSON.parse(JSON.stringify(fixture.controller.capturePosition()));
    fixture.scroll(0);
    fixture.shiftContentAbove(90);
    fixture.controller.restorePosition(position);
    expect(fixture.viewport.scrollTop).toBe(390);
    expect(fixture.paragraphs[1]!.getBoundingClientRect().top).toBe(0);
    expect(fixture.controller.isFollowing()).toBe(false);
  });

  it("skips hidden duplicate roots when resolving a saved anchor", () => {
    const fixture = setup({ scrollTop: 300 });
    fixture.controller.setFollowing(false);
    const position = fixture.controller.capturePosition();
    const hiddenRoot = fixture.markdown.cloneNode(true) as HTMLElement;
    hiddenRoot.hidden = true;
    hiddenRoot.getClientRects = () => [] as unknown as DOMRectList;
    fixture.message.prepend(hiddenRoot);
    fixture.scroll(0);
    fixture.controller.restorePosition(position);
    expect(fixture.viewport.scrollTop).toBe(300);
  });

  it("uses the surviving successor block when the anchored paragraph is removed", () => {
    const fixture = setup({ scrollTop: 300 });
    fixture.controller.setFollowing(false);
    fixture.paragraphs[1]!.remove();
    fixture.shiftContentAbove(-80);
    fixture.fireResize();
    expect(fixture.viewport.scrollTop).toBe(420);
    expect(fixture.paragraphs[2]!.getBoundingClientRect().top).toBe(0);
    expect(fixture.controller.isFollowing()).toBe(false);
  });

  it("uses a clamped numeric fallback if the stable root was removed", () => {
    const fixture = setup({ scrollTop: 300 });
    fixture.controller.setFollowing(false);
    const position = fixture.controller.capturePosition();
    fixture.message.remove();
    fixture.scroll(20);
    fixture.controller.restorePosition(position);
    expect(fixture.viewport.scrollTop).toBe(300);
    fixture.resize({ scrollHeight: 500 });
    fixture.fireResize();
    expect(fixture.viewport.scrollTop).toBe(100);
    expect(fixture.controller.isFollowing()).toBe(false);
    const writes = fixture.writes;
    fixture.fireResize();
    expect(fixture.writes).toBe(writes);
  });

  it("restores following mode to the current bottom rather than a stale saved number", () => {
    const fixture = setup({ scrollTop: 300 });
    fixture.controller.setFollowing(false);
    fixture.controller.restorePosition({ following: true, scrollTop: 10, anchor: null });
    expect(fixture.viewport.scrollTop).toBe(800);
    expect(fixture.controller.isFollowing()).toBe(true);
  });

  it("compensates a reading fold once, including its subsequent ResizeObserver delivery", () => {
    const fixture = setup({ scrollTop: 300 });
    fixture.controller.setFollowing(false);
    const token = fixture.controller.beginFold(fixture.header);
    fixture.shiftContentAbove(-80);
    fixture.controller.commitFold(token);
    expect(fixture.viewport.scrollTop).toBe(220);
    const writes = fixture.writes;
    fixture.fireResize();
    fixture.controller.commitFold(token);
    expect(fixture.viewport.scrollTop).toBe(220);
    expect(fixture.writes).toBe(writes);
    expect(fixture.controller.isFollowing()).toBe(false);
  });

  it("shares one anchor across simultaneous fold transactions without double compensation", () => {
    const fixture = setup({ scrollTop: 300 });
    fixture.controller.setFollowing(false);
    const first = fixture.controller.beginFold(fixture.header);
    const second = fixture.controller.beginFold(fixture.header);
    fixture.shiftContentAbove(80);
    fixture.controller.commitFold(first);
    fixture.controller.commitFold(second);
    expect(fixture.viewport.scrollTop).toBe(380);
    expect(fixture.writes).toBe(1);
    fixture.fireResize();
    expect(fixture.writes).toBe(1);
  });

  it("uses the surviving fold header when folding removes the reading block", () => {
    const fixture = setup({ scrollTop: 300 });
    fixture.controller.setFollowing(false);
    const token = fixture.controller.beginFold(fixture.header);
    fixture.markdown.remove();
    fixture.shiftContentAbove(-60);
    fixture.controller.commitFold(token);
    expect(fixture.viewport.scrollTop).toBe(240);
    fixture.fireResize();
    expect(fixture.viewport.scrollTop).toBe(240);
    expect(fixture.controller.isFollowing()).toBe(false);
  });

  it("keeps following through a fold at the real clipped bottom", () => {
    const fixture = setup();
    const token = fixture.controller.beginFold(fixture.header);
    fixture.resize({ scrollHeight: 500 });
    fixture.controller.commitFold(token);
    expect(fixture.viewport.scrollTop).toBe(100);
    expect(fixture.controller.isFollowing()).toBe(true);
    fixture.resize({ scrollHeight: 600 });
    fixture.fireResize();
    expect(fixture.viewport.scrollTop).toBe(200);
  });

  it("invalidates a stale following fold immediately on upward user intent", () => {
    const fixture = setup();
    const token = fixture.controller.beginFold(fixture.header);
    fixture.controller.stickToBottomIfFollowing();
    fixture.wheel(-24);
    fixture.scroll(776);
    fixture.controller.commitFold(token);
    fixture.runFrames();
    expect(fixture.viewport.scrollTop).toBe(776);
    expect(fixture.controller.isFollowing()).toBe(false);
    fixture.resize({ scrollHeight: 700 });
    fixture.fireResize();
    expect(fixture.viewport.scrollTop).toBe(300);
    expect(fixture.controller.isFollowing()).toBe(false);
  });

  it("ignores hidden and foreign fold origins, including an anchor hidden before commit", () => {
    const fixture = setup({ scrollTop: 300 });
    fixture.controller.setFollowing(false);
    const hidden = document.createElement("div");
    hidden.hidden = true;
    const hiddenHeader = document.createElement("button");
    hidden.appendChild(hiddenHeader);
    fixture.stream.appendChild(hidden);
    const foreignHeader = document.createElement("button");
    document.body.appendChild(foreignHeader);
    expect(fixture.controller.beginFold(hiddenHeader)).toBeNull();
    expect(fixture.controller.beginFold(foreignHeader)).toBeNull();
    const token = fixture.controller.beginFold(fixture.header);
    fixture.header.hidden = true;
    fixture.shiftContentAbove(80);
    fixture.controller.commitFold(token);
    expect(fixture.viewport.scrollTop).toBe(300);
    expect(fixture.controller.isFollowing()).toBe(false);
  });

  it("invalidates pending folds even when explicit follow permission is unchanged", () => {
    const fixture = setup({ scrollTop: 300 });
    fixture.controller.setFollowing(false);
    const token = fixture.controller.beginFold(fixture.header);
    fixture.controller.setFollowing(false);
    fixture.shiftContentAbove(80);
    fixture.controller.commitFold(token);
    expect(fixture.viewport.scrollTop).toBe(300);
    expect(fixture.controller.isFollowing()).toBe(false);
  });

  it("recognizes upward keyboard, touch, and scrollbar intent without waiting for scroll", () => {
    const fixture = setup();
    fixture.viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    expect(fixture.controller.isFollowing()).toBe(false);
    fixture.controller.setFollowing(true);
    touch(fixture.viewport, "touchstart", 100);
    touch(fixture.viewport, "touchmove", 124);
    expect(fixture.controller.isFollowing()).toBe(false);
    fixture.controller.setFollowing(true);
    fixture.viewport.dispatchEvent(
      new MouseEvent("pointerdown", {
        button: 0,
        clientX: 315,
        clientY: 200,
        bubbles: true,
      }),
    );
    expect(fixture.controller.isFollowing()).toBe(false);
  });

  it("does not take outer scroll permission from editable or independently scrollable panels", () => {
    const fixture = setup();
    const panel = document.createElement("div");
    panel.style.overflowY = "auto";
    Object.defineProperties(panel, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 400 },
    });
    fixture.host.appendChild(panel);
    fixture.wheel(-24, panel);
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    touch(panel, "touchstart", 100);
    touch(panel, "touchmove", 124);
    panel.dispatchEvent(new Event("scroll", { bubbles: true }));
    const input = document.createElement("textarea");
    fixture.stream.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(fixture.controller.isFollowing()).toBe(true);
    fixture.wheel(-24);
    expect(fixture.controller.isFollowing()).toBe(false);
  });

  it("pauses for a text selection drag, but not ordinary fold button clicks", () => {
    const fixture = setup();
    fixture.header.dispatchEvent(
      new MouseEvent("pointerdown", {
        button: 0,
        clientX: 100,
        clientY: 150,
        bubbles: true,
      }),
    );
    document.dispatchEvent(new MouseEvent("pointerup", { button: 0 }));
    expect(fixture.controller.isFollowing()).toBe(true);
    const paragraph = fixture.paragraphs[4]!;
    paragraph.dispatchEvent(
      new MouseEvent("pointerdown", {
        button: 0,
        clientX: 100,
        clientY: 150,
        bubbles: true,
      }),
    );
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 0);
    range.setEnd(paragraph.firstChild!, 6);
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 140, clientY: 150 }));
    document.dispatchEvent(new Event("selectionchange"));
    expect(fixture.controller.isFollowing()).toBe(false);
  });

  it("keeps new bindings alive when a stale StrictMode cleanup runs", () => {
    const fixture = setup();
    const secondDetach = fixture.controller.attach();
    fixture.detach();
    fixture.wheel(-24);
    expect(fixture.controller.isFollowing()).toBe(false);
    secondDetach();
    fixture.controller.setFollowing(true);
    fixture.wheel(-24);
    expect(fixture.controller.isFollowing()).toBe(true);
  });

  it("cancels pending work and observers on dispose, then supports a fresh bind cycle", () => {
    const fixture = setup();
    const listener = vi.fn();
    const unsubscribe = fixture.controller.subscribe(listener);
    fixture.controller.stickToBottomIfFollowing();
    fixture.controller.dispose();
    expect(fixture.frames.size).toBe(0);
    expect(fixture.observer.disconnected).toBe(true);
    fixture.resize({ scrollHeight: 1600 });
    fixture.fireResize();
    expect(fixture.viewport.scrollTop).toBe(800);
    fixture.controller.setViewport(fixture.viewport);
    fixture.controller.setStream(fixture.stream);
    fixture.controller.attach();
    fixture.wheel(-24);
    expect(fixture.controller.isFollowing()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    fixture.controller.setFollowing(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
