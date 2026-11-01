import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UiEnvironmentContext } from "../internal/UiEnvironment";

/** 主题仅属于本实例的 DOM 根，不改写 document 或其他 UI 实例。 */
export type UiTheme = "light" | "dark";

export interface UiProviderProps {
  theme: UiTheme;
  children: ReactNode;
}

/** 每个 Provider 拥有独立 Portal 宿主和模态注册栈；嵌套弹层可覆盖内部宿主。 */
export function UiProvider({ theme, children }: UiProviderProps) {
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null);
  const modalStack = useRef<{ dialog: HTMLDialogElement }[]>([]);

  const registerModal = useCallback((dialog: HTMLDialogElement) => {
    const registration = { dialog };
    modalStack.current.push(registration);
    return () => {
      const index = modalStack.current.indexOf(registration);
      if (index !== -1) modalStack.current.splice(index, 1);
    };
  }, []);

  const isTopModal = useCallback((dialog: HTMLDialogElement) => {
    const stack = modalStack.current;
    return stack[stack.length - 1]?.dialog === dialog;
  }, []);

  useEffect(
    () => () => {
      modalStack.current.length = 0;
    },
    [],
  );

  const environment = useMemo(
    () => ({ portalHost, registerModal, isTopModal }),
    [portalHost, registerModal, isTopModal],
  );

  return (
    <div className="ui-root" data-ui-theme={theme}>
      <UiEnvironmentContext.Provider value={environment}>
        {children}
        <div className="ui-portal-host" ref={setPortalHost} />
      </UiEnvironmentContext.Provider>
    </div>
  );
}
