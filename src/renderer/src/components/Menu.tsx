import { type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { useOverlayLayer, useOverlayOwner } from "./overlay-lifecycle";
import { usePopoverPosition } from "./popover-position";

export interface MenuItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

interface MenuProps {
  open: boolean;
  onClose: () => void;
  label: string;
  items: MenuItem[];
  anchorRef?: RefObject<HTMLElement | null>;
  point?: { x: number; y: number };
}

export function Menu({ open, onClose, label, items, anchorRef, point }: MenuProps) {
  const owner = useOverlayOwner();
  const menuRef = useRef<HTMLDivElement>(null);
  const position = usePopoverPosition(
    open,
    menuRef,
    () =>
      point
        ? { left: point.x, right: point.x, top: point.y, bottom: point.y, width: 0 }
        : (anchorRef?.current?.getBoundingClientRect() ?? null),
    "auto",
    190,
  );
  useOverlayLayer(open, {
    depth: owner.depth + 1,
    root: () => menuRef.current,
    trigger: () => anchorRef?.current ?? null,
    outside: true,
    dismiss: onClose,
    tab: () => {
      anchorRef?.current?.focus();
      onClose();
    },
    keydown: (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const buttons = [
        ...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
      ];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : event.key === "ArrowDown"
              ? (index + 1) % buttons.length
              : index <= 0
                ? buttons.length - 1
                : index - 1;
      buttons[next]?.focus();
    },
  });
  const positioned = position !== null;
  useLayoutEffect(() => {
    if (open && positioned)
      menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open, positioned]);
  if (!open) return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      className="ui-menu"
      data-ui-menu=""
      tabIndex={-1}
      onContextMenu={(event) => event.preventDefault()}
      style={
        position
          ? {
              top: position.top,
              left: position.left,
              width: position.width,
              maxHeight: position.maxHeight,
            }
          : { visibility: "hidden" }
      }
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={cx("ui-menu-item", item.danger && "is-danger")}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>,
    owner.portalHost ?? document.body,
  );
}
