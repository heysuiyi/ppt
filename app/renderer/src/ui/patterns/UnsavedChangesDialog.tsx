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
      title="放弃未提交的修改？"
      description="这些修改只存在于当前预览内存。放弃后将继续原来的关闭或切换操作。"
      confirmLabel="放弃修改"
      cancelLabel="继续编辑"
      destructive
      fallbackFocusRef={fallbackFocusRef}
      onRequestClose={onContinueEditing}
      onConfirm={onDiscard}
    />
  );
}
