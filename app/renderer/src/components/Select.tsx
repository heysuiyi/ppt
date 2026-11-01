import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { CheckIcon, ChevronDownIcon } from "./Icons";
import { useOverlayLayer, useOverlayOwner } from "./overlay-lifecycle";
import { usePopoverPosition } from "./popover-position";

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

export interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  variant?: "settings" | "block" | "compact";
  placement?: "auto" | "above" | "below";
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  "aria-label"?: string;
  id?: string;
  "aria-labelledby"?: string;
  className?: string;
}

export function Select({
  value,
  options,
  onChange,
  variant = "settings",
  placement = "auto",
  placeholder = "选择…",
  disabled = false,
  ariaLabel,
  "aria-label": nativeAriaLabel,
  id,
  "aria-labelledby": labelledBy,
  className,
}: SelectProps) {
  const listboxId = useId();
  const owner = useOverlayOwner();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];
  const label = ariaLabel ?? nativeAriaLabel;
  const close = useCallback(() => setOpen(false), []);
  const position = usePopoverPosition(
    open,
    menuRef,
    () => triggerRef.current?.getBoundingClientRect() ?? null,
    placement,
  );
  const openMenu = () => {
    if (disabled || options.length === 0) return;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };
  const selectValue = (next: string) => {
    onChange(next);
    close();
    triggerRef.current?.focus();
  };
  useOverlayLayer(open, {
    depth: owner.depth + 1,
    root: () => menuRef.current,
    trigger: () => triggerRef.current,
    outside: true,
    dismiss: close,
    tab: close,
    keydown: (event) => {
      if (options.length === 0) return;
      if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if (event.key === "ArrowDown") setActiveIndex((index) => (index + 1) % options.length);
      else if (event.key === "ArrowUp")
        setActiveIndex((index) => (index <= 0 ? options.length - 1 : index - 1));
      else if (event.key === "Home") setActiveIndex(0);
      else if (event.key === "End") setActiveIndex(options.length - 1);
      else if (event.key === "Enter" || event.key === " ") {
        const option = options[activeIndex];
        if (option) selectValue(option.value);
      }
    },
  });
  useEffect(() => {
    if (disabled || options.length === 0) close();
  }, [disabled, options.length, close]);
  useEffect(() => {
    if (open) setActiveIndex((index) => Math.min(Math.max(index, 0), options.length - 1));
  }, [options.length, open]);
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open]);
  return (
    <div
      className={cx(
        "ui-select",
        `ui-select--${variant}`,
        open && "is-open",
        disabled && "is-disabled",
        className,
      )}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={cx("ui-select-trigger", open && "is-open")}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        onClick={() => {
          if (open) close();
          else openMenu();
        }}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <span className={cx("ui-select-value", !selected && "is-placeholder")}>
          {selected ? (
            <>
              <span className="ui-select-value-label">{selected.label}</span>
              {selected.hint ? <span className="ui-select-value-hint">{selected.hint}</span> : null}
            </>
          ) : (
            placeholder
          )}
        </span>
        <ChevronDownIcon size={12} className="ui-select-chevron" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={listboxId}
              role="listbox"
              aria-label={label}
              className={cx("ui-select-menu", position?.above && "is-above")}
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
              {options.map((option, index) => (
                <button
                  key={option.value}
                  id={`${listboxId}-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={option.value === value}
                  data-option-index={index}
                  className={cx(
                    "ui-select-option",
                    option.value === value && "is-selected",
                    index === activeIndex && "is-active",
                  )}
                  onPointerDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => selectValue(option.value)}
                >
                  <span className="ui-select-option-copy">
                    <span className="ui-select-option-label">{option.label}</span>
                    {option.hint ? (
                      <span className="ui-select-option-hint">{option.hint}</span>
                    ) : null}
                  </span>
                  {option.value === value ? (
                    <CheckIcon size={12} className="ui-select-option-check" />
                  ) : null}
                </button>
              ))}
            </div>,
            owner.portalHost ?? document.body,
          )
        : null}
    </div>
  );
}
