import type { RefObject } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

export interface UnsavedChangesDialogProps {
  open: boolean;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onContinueEditing: () => void;
  onDiscard: () => void;
}

export function UnsavedChangesDialog({
  open,
  fallbackFocusRef,
  onContinueEditing,
  onDiscard,
}: UnsavedChangesDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      title="放弃修改？"
      description="未保存的更改将丢失。"
      confirmLabel="放弃修改"
      cancelLabel="继续编辑"
      destructive
      fallbackFocusRef={fallbackFocusRef}
      onRequestClose={onContinueEditing}
      onConfirm={onDiscard}
    />
  );
}
