import {
  type ComponentPropsWithRef,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { cx } from "../lib/cx";

export interface TabsItem<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  items: readonly TabsItem<T>[];
  children: ReactNode;
}

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  items: readonly TabsItem<string>[];
  id: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs() {
  const context = useContext(TabsContext);
  if (!context) throw new Error("TabsList and TabsPanel must be rendered inside Tabs");
  return context;
}

function tabId(id: string, value: string) {
  return `${id}-tab-${encodeURIComponent(value)}`;
}

function panelId(id: string, value: string) {
  return `${id}-panel-${encodeURIComponent(value)}`;
}

export function Tabs<T extends string>({ value, onValueChange, items, children }: TabsProps<T>) {
  const id = useId();
  return (
    <TabsContext.Provider
      value={{ value, onValueChange: (next) => onValueChange(next as T), items, id }}
    >
      {children}
    </TabsContext.Provider>
  );
}

export interface TabsListProps {
  label: string;
  variant?: "inset" | "plain";
  className?: string;
}

export function TabsList({ label, variant = "inset", className }: TabsListProps) {
  const { value, onValueChange, items, id } = useTabs();
  const listRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef(new Map<string, HTMLButtonElement>());
  const focusedRef = useRef<{ value: string; element: HTMLButtonElement } | null>(null);
  const availableItems = items.filter((item) => !item.disabled);
  const rovingValue =
    availableItems.find((item) => item.value === value)?.value ?? availableItems[0]?.value;

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const forgetOutsideFocus = (event: FocusEvent | PointerEvent) => {
      if (event.target instanceof Node && !list.contains(event.target)) focusedRef.current = null;
    };
    const document = list.ownerDocument;
    document.addEventListener("focusin", forgetOutsideFocus);
    document.addEventListener("pointerdown", forgetOutsideFocus);
    return () => {
      document.removeEventListener("focusin", forgetOutsideFocus);
      document.removeEventListener("pointerdown", forgetOutsideFocus);
    };
  }, []);

  useLayoutEffect(() => {
    const focused = focusedRef.current;
    const list = listRef.current;
    if (!focused || !list || availableItems.some((item) => item.value === focused.value)) return;
    const active = list.ownerDocument.activeElement;
    const focusWasRemoved = active === list.ownerDocument.body && !focused.element.isConnected;
    focusedRef.current = null;
    if (list.contains(active) || focusWasRemoved) {
      if (rovingValue !== undefined) buttonsRef.current.get(rovingValue)?.focus();
    }
  });

  const activate = (next: string) => {
    const item = items.find((candidate) => candidate.value === next);
    if (!item || item.disabled) return;
    buttonsRef.current.get(next)?.focus();
    if (next !== value) onValueChange(next);
  };

  const navigate = (event: KeyboardEvent<HTMLButtonElement>, current: string) => {
    if (availableItems.length === 0) return;
    const index = availableItems.findIndex((item) => item.value === current);
    let next: TabsItem<string> | undefined;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = availableItems[(index + 1) % availableItems.length];
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = availableItems[index <= 0 ? availableItems.length - 1 : index - 1];
        break;
      case "Home":
        next = availableItems[0];
        break;
      case "End":
        next = availableItems[availableItems.length - 1];
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next) activate(next.value);
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      data-ui-tabs=""
      data-variant={variant}
      className={cx("ui-tabs-list", className)}
    >
      {items.map((item) => (
        <button
          key={item.value}
          ref={(element) => {
            if (element) buttonsRef.current.set(item.value, element);
            else buttonsRef.current.delete(item.value);
          }}
          type="button"
          role="tab"
          id={tabId(id, item.value)}
          aria-controls={panelId(id, item.value)}
          aria-selected={value === item.value}
          disabled={item.disabled}
          tabIndex={rovingValue === item.value ? 0 : -1}
          data-ui-tab=""
          onFocus={(event) => {
            focusedRef.current = { value: item.value, element: event.currentTarget };
          }}
          onClick={() => activate(item.value)}
          onKeyDown={(event) => navigate(event, item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export interface TabsPanelProps extends ComponentPropsWithRef<"div"> {
  value: string;
}

export function TabsPanel({ value, children, ...props }: TabsPanelProps) {
  const context = useTabs();
  const active = context.value === value;
  return (
    <div
      {...props}
      role="tabpanel"
      id={panelId(context.id, value)}
      aria-labelledby={tabId(context.id, value)}
      hidden={!active}
      tabIndex={0}
    >
      {active ? children : null}
    </div>
  );
}
