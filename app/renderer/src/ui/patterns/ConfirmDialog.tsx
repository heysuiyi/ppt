import { type RefObject, useEffect, useRef, useState } from "react";
import { Alert } from "../components/alert/Alert";
import { Button } from "../components/button/Button";
import { Dialog, type DialogCloseReason } from "../components/dialog/Dialog";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onConfirm: (signal: AbortSignal) => void | Promise<void>;
  onRequestClose: (reason: DialogCloseReason) => void;
}

/** 显式确认才执行；中止仅使本地等待失效，不声称撤销外部效果。 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "取消",
  destructive = false,
  fallbackFocusRef,
  onConfirm,
  onRequestClose,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const active = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open) {
      setPending(false);
      setError(false);
    }
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [open]);
  const close = (reason: DialogCloseReason) => {
    active.current?.abort();
    active.current = null;
    setPending(false);
    onRequestClose(reason);
  };
  const confirm = async () => {
    if (active.current) return;
    const operation = new AbortController();
    active.current = operation;
    setPending(true);
    setError(false);
    try {
      await onConfirm(operation.signal);
    } catch {
      if (!operation.signal.aborted) setError(true);
    } finally {
      if (active.current === operation && !operation.signal.aborted) {
        active.current = null;
        setPending(false);
      }
    }
  };
  return (
    <Dialog
      open={open}
      purpose="confirm"
      title={title}
      description={description}
      initialFocusRef={cancelRef}
      fallbackFocusRef={fallbackFocusRef}
      onRequestClose={close}
      footer={
        <>
          <Button ref={cancelRef} onClick={() => close("cancel")}>
            {cancelLabel}
          </Button>
          <Button
            tone={destructive ? "danger" : "primary"}
            busy={pending}
            onClick={() => void confirm()}
          >
            {pending ? "处理中…" : confirmLabel}
          </Button>
        </>
      }
    >
      {error && (
        <Alert title="操作未完成" tone="error" announce="assertive">
          重试或取消。
        </Alert>
      )}
    </Dialog>
  );
}
