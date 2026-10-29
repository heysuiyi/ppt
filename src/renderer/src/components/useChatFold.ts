import { useLayoutEffect, useRef } from "react";
import { type FoldToken, useChatScroll } from "./useChatScroll";

/** Keep expansion policy local; share only the scroll-anchor transaction. */
export function useChatFold<T extends HTMLElement>() {
  const chatScroll = useChatScroll();
  const anchorRef = useRef<T>(null);
  const pendingFoldRef = useRef<FoldToken | null>(null);

  useLayoutEffect(() => {
    const pending = pendingFoldRef.current;
    if (!pending) return;
    pendingFoldRef.current = null;
    chatScroll.commitFold(pending);
  });

  const transactFold = (update: () => void) => {
    pendingFoldRef.current = chatScroll.beginFold(anchorRef.current);
    update();
  };

  return { anchorRef, transactFold };
}
