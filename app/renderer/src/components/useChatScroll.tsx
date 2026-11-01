import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  type ChatScrollController,
  type ChatScrollPosition,
  createChatScrollController,
  type FoldToken,
} from "./chat-scroll-controller";

export type { ChatScrollPosition, FoldToken };

export interface ChatScrollApi {
  viewportRef: RefObject<HTMLDivElement | null>;
  streamRef: RefObject<HTMLDivElement | null>;
  /** Sync refs into the controller and attach listeners. Returns disposer. */
  bind: () => () => void;
  isFollowing: () => boolean;
  setFollowing: (value: boolean) => void;
  scrollToBottom: () => void;
  stickToBottomIfFollowing: () => void;
  beginFold: (anchor: HTMLElement | null) => FoldToken | null;
  commitFold: (token: FoldToken | null) => void;
  subscribe: (listener: () => void) => () => void;
  capturePosition: () => ChatScrollPosition;
  restorePosition: (position: ChatScrollPosition) => void;
}

const noopRef: RefObject<HTMLDivElement | null> = { current: null };

const noopApi: ChatScrollApi = {
  viewportRef: noopRef,
  streamRef: noopRef,
  bind: () => () => {},
  isFollowing: () => false,
  setFollowing: () => {},
  scrollToBottom: () => {},
  stickToBottomIfFollowing: () => {},
  beginFold: () => null,
  commitFold: () => {},
  subscribe: () => () => {},
  capturePosition: () => ({ following: false, scrollTop: 0, anchor: null }),
  restorePosition: () => {},
};

const ChatScrollContext = createContext<ChatScrollApi | null>(null);

export function ChatScrollProvider({ children }: { children: ReactNode }) {
  const controllerRef = useRef<ChatScrollController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createChatScrollController();
  }
  const controller = controllerRef.current;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => controller.dispose(), [controller]);

  const bind = useCallback(() => {
    controller.setViewport(viewportRef.current);
    controller.setStream(streamRef.current);
    return controller.attach();
  }, [controller]);

  const api = useMemo<ChatScrollApi>(
    () => ({
      viewportRef,
      streamRef,
      bind,
      isFollowing: () => controller.isFollowing(),
      setFollowing: (value) => controller.setFollowing(value),
      scrollToBottom: () => controller.scrollToBottom(),
      stickToBottomIfFollowing: () => controller.stickToBottomIfFollowing(),
      beginFold: (anchor) => controller.beginFold(anchor),
      commitFold: (token) => controller.commitFold(token),
      subscribe: (listener) => controller.subscribe(listener),
      capturePosition: () => controller.capturePosition(),
      restorePosition: (position) => controller.restorePosition(position),
    }),
    [bind, controller],
  );

  return <ChatScrollContext.Provider value={api}>{children}</ChatScrollContext.Provider>;
}

/** Returns a no-op API when rendered outside ChatScrollProvider (unit tests). */
export function useChatScroll(): ChatScrollApi {
  return useContext(ChatScrollContext) ?? noopApi;
}
