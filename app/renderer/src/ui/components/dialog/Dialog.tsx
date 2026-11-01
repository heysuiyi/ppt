import { type ReactNode, type RefObject, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { UiEnvironmentContext, useUiEnvironment } from "../../internal/UiEnvironment";
import { Button } from "../button/Button";

export type DialogCloseReason = "escape" | "outside" | "close-button" | "cancel";
export type DialogPurpose = "confirm" | "form" | "content" | "fullscreen";

export interface DialogProps {
  open: boolean;
  purpose: DialogPurpose;
  title: string;
  description?: string;
  onRequestClose: (reason: DialogCloseReason) => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  footer?: ReactNode;
}

/** 受控模态；关闭只请求决定，不提交表单、不解释业务结果。 */
export function Dialog({ open, ...props }: DialogProps) {
  const environment = useUiEnvironment();
  if (!open || !environment.portalHost) return null;
  return createPortal(<MountedDialog {...props} />, environment.portalHost);
}

function MountedDialog({
  purpose,
  title,
  description,
  onRequestClose,
  initialFocusRef,
  fallbackFocusRef,
  children,
  footer,
}: Omit<DialogProps, "open">) {
  const environment = useUiEnvironment();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [nestedHost, setNestedHost] = useState<HTMLDivElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const outsidePointer = useRef<number | null>(null);
  const latest = useRef({ initialFocusRef, fallbackFocusRef });
  latest.current = { initialFocusRef, fallbackFocusRef };
  const { registerModal, isTopModal } = environment;

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unregister = registerModal(dialog);
    dialog.showModal();
    latest.current.initialFocusRef?.current?.focus();
    return () => {
      unregister();
      dialog.close();
      // 先让嵌套模态卸载，再恢复尚有效的触发点；触发点消失由页面提供后备。
      queueMicrotask(() => {
        const target = previous?.isConnected ? previous : latest.current.fallbackFocusRef.current;
        if (!target?.isConnected || target.closest("[inert]")) return;
        const parentModal = target.closest<HTMLDialogElement>("dialog");
        if (parentModal && (!parentModal.open || !isTopModal(parentModal))) return;
        if (!parentModal && document.querySelector("dialog:modal")) return;
        target.focus();
      });
    };
  }, [registerModal, isTopModal]);

  const outside = (x: number, y: number) => {
    const bounds = dialogRef.current!.getBoundingClientRect();
    return x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom;
  };

  return (
    <dialog
      ref={dialogRef}
      className="ui-dialog"
      data-purpose={purpose}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (isTopModal(event.currentTarget)) onRequestClose("escape");
      }}
      onKeyDown={(event) => {
        const dialog = event.currentTarget;
        if (event.key !== "Tab" || !isTopModal(dialog)) return;
        // 遮罩点击可使原生 Dialog 自身获焦；与首尾控件一并处理，避免退到浏览器边界。
        const controls = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            "button, input, textarea, select, a[href], summary, [tabindex]",
          ),
        ).filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(":disabled") &&
            !element.closest("[inert]") &&
            element.closest("dialog") === dialog &&
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== "hidden",
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (
          document.activeElement === dialog ||
          (event.shiftKey && document.activeElement === first) ||
          (!event.shiftKey && document.activeElement === last)
        ) {
          event.preventDefault();
          event.stopPropagation();
          (event.shiftKey ? last : first)?.focus();
        }
      }}
      onPointerDown={(event) => {
        // 首个遮罩手势只收起所属自绘列表，不同时触发表单离开。
        const popupOpen = event.currentTarget.querySelector("[data-ui-popup]:popover-open");
        outsidePointer.current =
          !popupOpen &&
          event.target === event.currentTarget &&
          outside(event.clientX, event.clientY)
            ? event.pointerId
            : null;
      }}
      onPointerUp={(event) => {
        const startedOutside = outsidePointer.current === event.pointerId;
        outsidePointer.current = null;
        if (
          purpose !== "confirm" &&
          startedOutside &&
          event.target === event.currentTarget &&
          outside(event.clientX, event.clientY) &&
          isTopModal(event.currentTarget)
        ) {
          onRequestClose("outside");
        }
      }}
    >
      <UiEnvironmentContext.Provider value={{ ...environment, portalHost: nestedHost }}>
        <header className="ui-dialog-header">
          <div>
            <h2 id={titleId} className="ui-dialog-title">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="ui-dialog-description">
                {description}
              </p>
            )}
          </div>
          <Button onClick={() => onRequestClose("close-button")} aria-label={`关闭${title}`}>
            关闭
          </Button>
        </header>
        <div className="ui-dialog-body">{children}</div>
        {footer && <footer className="ui-dialog-footer">{footer}</footer>}
        <div ref={setNestedHost} className="ui-portal-host" />
      </UiEnvironmentContext.Provider>
    </dialog>
  );
}
