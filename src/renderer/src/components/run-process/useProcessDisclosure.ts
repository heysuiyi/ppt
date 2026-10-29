import { Component, type ReactNode, type RefObject, useState } from "react";
import { useChatFold } from "../useChatFold";
import { type ChatScrollApi, type FoldToken, useChatScroll } from "../useChatScroll";

interface ProcessFoldBoundaryProps {
  open: boolean;
  automatic: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  chatScroll: ChatScrollApi;
  children: ReactNode;
}

/** Capture prop-driven folds before React changes the body, not after layout. */
export class ProcessFoldBoundary extends Component<ProcessFoldBoundaryProps> {
  getSnapshotBeforeUpdate(previous: ProcessFoldBoundaryProps): FoldToken | null {
    if (!this.props.automatic || previous.open === this.props.open) return null;
    return this.props.chatScroll.beginFold(this.props.anchorRef.current);
  }

  componentDidUpdate(
    _previous: ProcessFoldBoundaryProps,
    _previousState: unknown,
    snapshot: FoldToken | null,
  ) {
    if (snapshot) this.props.chatScroll.commitFold(snapshot);
  }

  render() {
    return this.props.children;
  }
}

export function useProcessDisclosure(automaticOpen: boolean) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const { anchorRef, transactFold } = useChatFold<HTMLButtonElement>();
  const chatScroll = useChatScroll();
  const open = userOpen ?? automaticOpen;

  const toggle = () => {
    transactFold(() => setUserOpen(!open));
  };

  return {
    open,
    anchorRef,
    toggle,
    foldBoundaryProps: { open, automatic: userOpen === null, anchorRef, chatScroll },
  };
}
