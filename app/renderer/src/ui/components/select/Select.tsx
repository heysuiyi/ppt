import { type KeyboardEvent, useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUiEnvironment } from "../../internal/UiEnvironment";
import { useAnchoredPosition } from "../../internal/useAnchoredPosition";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  variant?: "field" | "compact";
  align?: "start" | "end";
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

/** 值归调用方；活动项只承担导航，不因打开、搜索或选项变化提交值。 */
export function Select({
  value,
  onValueChange,
  options,
  variant = "field",
  align = "start",
  disabled = false,
  placeholder,
  id,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
}: SelectProps) {
  const { portalHost } = useUiEnvironment();
  const generatedId = useId();
  const triggerId = id ?? `${generatedId}-trigger`;
  const listboxId = `${generatedId}-listbox`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const typeahead = useRef({ text: "", time: 0 });
  const selected = options.find((option) => option.value === value);
  const unavailable = disabled || options.length === 0;
  const activeIndex = options.findIndex(
    (option) => option.value === activeValue && !option.disabled,
  );
  const activeId = activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;
  const firstEnabled = options.findIndex((option) => !option.disabled);
  let lastEnabled = options.length - 1;
  while (lastEnabled >= 0 && options[lastEnabled].disabled) lastEnabled -= 1;

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    typeahead.current = { text: "", time: 0 };
    const popup = popupRef.current;
    if (popup?.matches(":popover-open")) popup.hidePopover();
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);
  const closeHiddenAnchor = useCallback(() => close(), [close]);

  // 原生 light-dismiss（包括另一个 auto popover 打开）也必须同步到 React 状态。
  useLayoutEffect(() => {
    if (!portalHost) return;
    const popup = popupRef.current;
    if (!popup) return;
    const synchronize = (event: Event) => {
      const nextOpen = (event as Event & { newState: string }).newState === "open";
      setOpen(nextOpen);
      if (!nextOpen) typeahead.current = { text: "", time: 0 };
    };
    popup.addEventListener("beforetoggle", synchronize);
    popup.addEventListener("toggle", synchronize);
    return () => {
      popup.removeEventListener("beforetoggle", synchronize);
      popup.removeEventListener("toggle", synchronize);
    };
  }, [portalHost]);

  useLayoutEffect(() => {
    const popup = popupRef.current;
    if (!open || !popup || !portalHost) return;
    popup.showPopover();
    return () => {
      if (popup.matches(":popover-open")) popup.hidePopover();
    };
  }, [open, portalHost]);

  useAnchoredPosition({
    triggerRef,
    popupRef,
    open: open && portalHost !== null,
    align,
    minWidth: 200,
    onAnchorHidden: closeHiddenAnchor,
  });

  useLayoutEffect(() => {
    if (unavailable || !portalHost) close();
  }, [unavailable, portalHost, close]);

  useLayoutEffect(() => {
    if (!open || activeIndex >= 0) return;
    const selectedEnabled = options.find((option) => option.value === value && !option.disabled);
    setActiveValue(selectedEnabled?.value ?? options[firstEnabled]?.value ?? null);
  }, [open, activeIndex, options, value, firstEnabled]);

  useLayoutEffect(() => {
    const activeOption = options[activeIndex];
    if (!open || !activeOption) return;
    // 只滚动列表本身；scrollIntoView 会连带移动宿主页或模态滚动区。
    const popup = popupRef.current;
    const item = popup?.querySelector<HTMLElement>(
      `[data-option-value="${CSS.escape(activeOption.value)}"]`,
    );
    if (!popup || !item) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < popup.scrollTop) popup.scrollTop = top;
    else if (bottom > popup.scrollTop + popup.clientHeight) {
      popup.scrollTop = bottom - popup.clientHeight;
    }
  }, [open, activeIndex, options]);

  const openPopup = (edge?: "first" | "last") => {
    if (unavailable || !portalHost) return;
    const selectedEnabled = options.find((option) => option.value === value && !option.disabled);
    const initial =
      edge === "first"
        ? options[firstEnabled]
        : edge === "last"
          ? options[lastEnabled]
          : (selectedEnabled ?? options[firstEnabled]);
    setActiveValue(initial?.value ?? null);
    typeahead.current = { text: "", time: 0 };
    setOpen(true);
  };

  const choose = (option: SelectOption | undefined) => {
    if (!option || option.disabled || disabled) return;
    close(true);
    if (option.value !== value) onValueChange(option.value);
  };

  const search = (character: string) => {
    const now = Date.now();
    const previous = now - typeahead.current.time <= 700 ? typeahead.current.text : "";
    const text = previous + character.toLocaleLowerCase();
    typeahead.current = { text, time: now };
    let repeating = true;
    for (let index = 1; index < text.length; index += 1) {
      if (text[index] !== text[0]) {
        repeating = false;
        break;
      }
    }
    const query = repeating ? text[0] : text;
    const start = repeating ? activeIndex + 1 : Math.max(0, activeIndex);
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (start + offset) % options.length;
      const option = options[index];
      if (!option.disabled && option.label.trimStart().toLocaleLowerCase().startsWith(query)) {
        setActiveValue(option.value);
        break;
      }
    }
    if (!open) setOpen(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      if (open) close();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (!open) {
        openPopup(direction === -1 && (!selected || selected.disabled) ? "last" : undefined);
      } else {
        const start = activeIndex < 0 ? (direction === 1 ? -1 : 0) : activeIndex;
        for (let step = 1; step <= options.length; step += 1) {
          const index = (start + direction * step + options.length) % options.length;
          if (!options[index].disabled) {
            setActiveValue(options[index].value);
            break;
          }
        }
      }
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const edge = event.key === "Home" ? "first" : "last";
      if (!open) openPopup(edge);
      else setActiveValue(options[edge === "first" ? firstEnabled : lastEnabled]?.value ?? null);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (
        event.key === " " &&
        open &&
        typeahead.current.text &&
        Date.now() - typeahead.current.time <= 700
      ) {
        search(" ");
      } else if (!open) openPopup();
      else if (activeIndex >= 0) choose(options[activeIndex]);
      else close(true);
      return;
    }
    if (event.key.length === 1 && portalHost) {
      event.preventDefault();
      search(event.key);
    }
  };

  return (
    <span className={className ? `ui-choice ${className}` : "ui-choice"} data-variant={variant}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        popoverTarget={listboxId}
        value={value}
        className="ui-choice-trigger"
        disabled={unavailable}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={portalHost ? listboxId : undefined}
        aria-activedescendant={open ? activeId : undefined}
        onKeyDown={onKeyDown}
        onBlur={() => close()}
        onClick={(event) => {
          // 保留原生 invoker 关联，让触发器不被当作 outside；切换仍由受控状态持有。
          event.preventDefault();
          if (open) close();
          else openPopup();
        }}
      >
        <span className="ui-choice-value" data-placeholder={!selected || undefined}>
          {selected?.label ?? placeholder ?? ""}
        </span>
        <svg className="ui-choice-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {portalHost &&
        createPortal(
          <div
            ref={popupRef}
            id={listboxId}
            className="ui-choice-popup"
            popover="auto"
            data-ui-popup="select"
            role="listbox"
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy ?? (ariaLabel ? undefined : triggerId)}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${listboxId}-option-${index}`}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                className="ui-choice-option"
                data-option-value={option.value}
                data-active={(index === activeIndex && open) || undefined}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => {
                  if (!option.disabled) setActiveValue(option.value);
                }}
                onClick={() => choose(option)}
              >
                <span className="ui-choice-option-label">{option.label}</span>
                <svg className="ui-choice-check" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m3 8 3 3 7-7" />
                </svg>
              </div>
            ))}
          </div>,
          portalHost,
        )}
    </span>
  );
}
