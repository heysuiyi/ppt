import { createContext, useContext } from "react";

/** 私有环境只传递所属 Portal 与模态栈；页面不能据此绕过组件公开入口。 */
export interface UiEnvironment {
  portalHost: HTMLElement | null;
  registerModal: (dialog: HTMLDialogElement) => () => void;
  isTopModal: (dialog: HTMLDialogElement) => boolean;
}

export const UiEnvironmentContext = createContext<UiEnvironment | null>(null);

export function useUiEnvironment(): UiEnvironment {
  const environment = useContext(UiEnvironmentContext);
  if (!environment) {
    throw new Error("UI 组件必须在所属 UiProvider 内使用。");
  }
  return environment;
}
