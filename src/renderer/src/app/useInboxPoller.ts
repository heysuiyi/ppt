import { useEffect, useRef } from "react";

interface UseInboxPollerOptions {
  enabled: boolean;
  activeSessionId: string;
  sessionLoaded: boolean;
  busy: boolean;
  onInboxTurn: (prompt: string) => Promise<void> | void;
  onError?: (error: unknown) => void;
}

export function useInboxPoller({
  enabled,
  activeSessionId,
  sessionLoaded,
  busy,
  onInboxTurn,
  onError,
}: UseInboxPollerOptions): void {
  const inFlightRef = useRef(false);
  const busyRef = useRef(busy);
  const onInboxTurnRef = useRef(onInboxTurn);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    busyRef.current = busy;
    onInboxTurnRef.current = onInboxTurn;
    onErrorRef.current = onError;
  }, [busy, onError, onInboxTurn]);

  useEffect(() => {
    if (!enabled || !sessionLoaded || !activeSessionId) return;

    let disposed = false;
    const tick = async () => {
      if (disposed || busyRef.current || inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const inbox = await window.desktopApi.pollLeadInbox(activeSessionId);
        if (!disposed && inbox.hasMessages && !busyRef.current) {
          await onInboxTurnRef.current(
            `[Inbox poller]\n请读取并处理 lead inbox 中的 ${inbox.count} 条消息。`,
          );
        }
      } catch (error) {
        onErrorRef.current?.(error);
      } finally {
        inFlightRef.current = false;
      }
    };

    const interval = window.setInterval(() => {
      void tick();
    }, 1_000);
    void tick();

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [activeSessionId, enabled, sessionLoaded]);
}
