import { useCallback, useEffect, useRef, useState } from "react";

export interface NotificationCenter {
  message: string | null;
  notify: (message: string) => void;
}

export function useNotificationCenter(timeoutMs = 3200): NotificationCenter {
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const notify = useCallback(
    (nextMessage: string) => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      setMessage(nextMessage);
      timerRef.current = window.setTimeout(() => {
        setMessage(null);
        timerRef.current = null;
      }, timeoutMs);
    },
    [timeoutMs],
  );

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return { message, notify };
}

export function NotificationViewport({ message }: { message: string | null }) {
  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="true">
      {message ? (
        <div key={message} className="floating-toast-alert" role="status">
          {message}
        </div>
      ) : null}
    </div>
  );
}
