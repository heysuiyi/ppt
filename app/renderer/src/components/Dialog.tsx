import { type HTMLAttributes, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { OverlayContext, useOverlayLayer, useOverlayOwner } from "./overlay-lifecycle";

export interface DialogProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  overlayClassName?: string;
  closeOnBackdrop?: boolean;
}

export function Dialog({
  open,
  onClose,
  label,
  children,
  className,
  overlayClassName,
  closeOnBackdrop = true,
  onKeyDown,
  ...props
}: DialogProps) {
  const owner = useOverlayOwner();
  const rootRef = useRef<HTMLDivElement>(null);
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null);
  const depth = owner.depth + 1;
  const isTop = useOverlayLayer(open, {
    depth,
    modal: true,
    root: () => rootRef.current,
    dismiss: onClose,
  });
  useLayoutEffect(() => {
    if (!open) setPortalHost(null);
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div
      ref={rootRef}
      className={cx("ui-dialog-overlay", overlayClassName)}
      data-ui-dialog-overlay=""
      tabIndex={-1}
      onClick={(event) => {
        if (closeOnBackdrop && isTop() && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        {...props}
        className={cx("ui-dialog", className)}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-ui-dialog=""
        onKeyDown={(event) => {
          if (isTop()) onKeyDown?.(event);
        }}
      >
        <OverlayContext.Provider value={{ depth, portalHost }}>{children}</OverlayContext.Provider>
        <div ref={setPortalHost} className="ui-dialog-portals" />
      </div>
    </div>,
    owner.portalHost ?? document.body,
  );
}
