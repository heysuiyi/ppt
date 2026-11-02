import {
  type CSSProperties,
  type KeyboardEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { HarnessToolsMode } from "../../../shared/harness-ipc";
import "./composer-tools.css";

export interface ComposerToolsProps {
  mode: HarnessToolsMode;
  disabled: boolean;
  workspaceMissing: boolean;
  onNewSession: () => void;
  onChooseWorkspace: () => void;
  onSettings: () => void;
}

const permissionLabels: Record<HarnessToolsMode, string> = {
  "read-write": "工作区内修改",
  "read-only": "只读工作区",
  none: "仅对话",
};

const permissionDescriptions: Record<HarnessToolsMode, string> = {
  "read-write":
    "可读取并修改所选工作区内的文件；文件访问受工作区边界约束，不代表可访问工作区外的文件。",
  "read-only": "仅可读取所选工作区内的文件，不能写入或修改；文件访问受工作区边界约束。",
  none: "当前仅进行对话，不提供工作区文件工具，不会读取或修改工作区文件。",
};

export function ComposerTools({
  mode,
  disabled,
  workspaceMissing,
  onNewSession,
  onChooseWorkspace,
  onSettings,
}: ComposerToolsProps) {
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const menuId = `composer-actions-${instanceId}`;
  const permissionId = `composer-permissions-${instanceId}`;
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const permissionTriggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const permissionRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const permissionLabel = workspaceMissing ? "未选择工作区" : permissionLabels[mode];
  const anchorStyle = {
    "--desktop-composer-actions-anchor": `--composer-actions-${instanceId}`,
    "--desktop-composer-permissions-anchor": `--composer-permissions-${instanceId}`,
  } as CSSProperties;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const permission = permissionRef.current;
    if (!menu || !permission) return;
    const synchronizeMenu = (event: Event) => {
      setMenuOpen((event as Event & { newState: string }).newState === "open");
    };
    const synchronizePermission = (event: Event) => {
      setPermissionOpen((event as Event & { newState: string }).newState === "open");
    };
    // Native Escape, light-dismiss and another auto popover opening share this lifecycle.
    menu.addEventListener("beforetoggle", synchronizeMenu);
    menu.addEventListener("toggle", synchronizeMenu);
    permission.addEventListener("beforetoggle", synchronizePermission);
    permission.addEventListener("toggle", synchronizePermission);
    return () => {
      menu.removeEventListener("beforetoggle", synchronizeMenu);
      menu.removeEventListener("toggle", synchronizeMenu);
      permission.removeEventListener("beforetoggle", synchronizePermission);
      permission.removeEventListener("toggle", synchronizePermission);
    };
  }, []);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu?.matches(":popover-open")) return;
    if (disabled) menu.hidePopover();
    else if (
      document.activeElement instanceof HTMLButtonElement &&
      document.activeElement.disabled
    ) {
      menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    }
  }, [disabled, workspaceMissing]);

  function closeMenu(restoreFocus = false) {
    if (menuRef.current?.matches(":popover-open")) menuRef.current.hidePopover();
    if (restoreFocus) menuTriggerRef.current?.focus({ preventScroll: true });
  }

  function openMenu(edge: "first" | "last" = "first") {
    if (disabled) return;
    const menu = menuRef.current;
    if (!menu) return;
    if (!menu.matches(":popover-open")) menu.showPopover();
    const items = menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    items[edge === "last" ? items.length - 1 : 0]?.focus({ preventScroll: true });
  }

  function closePermission(restoreFocus = false) {
    if (permissionRef.current?.matches(":popover-open")) permissionRef.current.hidePopover();
    if (restoreFocus) permissionTriggerRef.current?.focus({ preventScroll: true });
  }

  function handleMenuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    );
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  }

  function act(action: () => void) {
    closeMenu(true);
    action();
  }

  return (
    <div
      className="desktop-composer-tools"
      style={anchorStyle}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        ref={menuTriggerRef}
        type="button"
        className="desktop-composer-tools-add"
        aria-label="会话操作"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuId}
        popoverTarget={menuId}
        disabled={disabled}
        onClick={(event) => {
          event.preventDefault();
          if (menuRef.current?.matches(":popover-open")) closeMenu(true);
          else openMenu();
        }}
        onBlur={(event) => {
          if (!menuRef.current?.contains(event.relatedTarget)) closeMenu();
        }}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            openMenu(event.key === "ArrowUp" || event.key === "End" ? "last" : "first");
          }
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 2v12M2 8h12" />
        </svg>
      </button>
      <div
        ref={menuRef}
        id={menuId}
        className="desktop-composer-tools-popup desktop-composer-tools-menu"
        popover="auto"
        data-ui-popup="composer-actions"
        role="menu"
        aria-label="会话操作"
        onKeyDown={handleMenuKeys}
        onBlur={(event) => {
          if (
            event.relatedTarget !== menuTriggerRef.current &&
            !event.currentTarget.contains(event.relatedTarget)
          )
            closeMenu();
        }}
      >
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={disabled || workspaceMissing}
          onClick={() => act(onNewSession)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M11 4H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V9M12 3h5m-2.5-2.5v5M7 9h3m-3 4h6" />
          </svg>
          新会话
        </button>
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={disabled}
          onClick={() => act(onChooseWorkspace)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M2.5 6V4.5h5L9 6h8.5v10h-15zM2.5 6h15" />
          </svg>
          选择工作区
        </button>
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={disabled}
          onClick={() => act(onSettings)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M4 3v14M10 3v14M16 3v14M2 7h4m2 6h4m2-7h4" />
          </svg>
          模型设置
        </button>
      </div>
      <button
        ref={permissionTriggerRef}
        type="button"
        className="desktop-composer-tools-permission"
        aria-label={`当前权限：${permissionLabel}`}
        aria-haspopup="dialog"
        aria-expanded={permissionOpen}
        aria-controls={permissionId}
        popoverTarget={permissionId}
        onClick={(event) => {
          event.preventDefault();
          const permission = permissionRef.current;
          if (!permission) return;
          if (permission.matches(":popover-open")) closePermission(true);
          else {
            permission.showPopover();
            permission.focus({ preventScroll: true });
          }
        }}
        onBlur={(event) => {
          if (!permissionRef.current?.contains(event.relatedTarget)) closePermission();
        }}
      >
        <svg className="desktop-composer-tools-shield" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 1.5 13 3v4.2c0 3.1-2.1 5.6-5 7.3-2.9-1.7-5-4.2-5-7.3V3z" />
        </svg>
        <span className="desktop-composer-tools-permission-label">{permissionLabel}</span>
        <svg className="desktop-composer-tools-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4.5 6 3.5 3.5L11.5 6" />
        </svg>
      </button>
      <div
        ref={permissionRef}
        id={permissionId}
        className="desktop-composer-tools-popup desktop-composer-tools-permission-popup"
        popover="auto"
        data-ui-popup="composer-permissions"
        role="dialog"
        aria-labelledby={`${permissionId}-title`}
        aria-describedby={`${permissionId}-scope ${permissionId}-approval ${permissionId}-binding`}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closePermission(true);
          }
        }}
        onBlur={(event) => {
          if (
            event.relatedTarget !== permissionTriggerRef.current &&
            !event.currentTarget.contains(event.relatedTarget)
          )
            closePermission();
        }}
      >
        <div className="desktop-composer-tools-permission-heading">
          <h3 id={`${permissionId}-title`}>{permissionLabel}</h3>
          <button type="button" aria-label="关闭权限说明" onClick={() => closePermission(true)}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4 4 8 8m0-8-8 8" />
            </svg>
          </button>
        </div>
        <p id={`${permissionId}-scope`}>
          {workspaceMissing
            ? "尚未选择工作区，当前没有可用的工作区文件访问权限。选择工作区并不代表自动获得文件访问权限。"
            : permissionDescriptions[mode]}
        </p>
        <p id={`${permissionId}-approval`}>
          宿主审批独立执行；此说明不会自动批准操作或授予额外权限。
        </p>
        <p id={`${permissionId}-binding`}>
          权限由新会话默认配置或当前会话绑定决定，已绑定的权限不能在当前会话中更改。
        </p>
      </div>
    </div>
  );
}
