import type { BrowserWindow } from "electron";
import type { DesktopHarnessRegistration } from "./ipc";

/** Only committed cross-document navigation changes ownership; starts and hash routing do not. */
export function attachDesktopHarnessWindowLifecycle(
  window: BrowserWindow,
  registration: DesktopHarnessRegistration,
  reportFailure: (stage: "document" | "renderer" | "window", webContentsId: number) => void,
): void {
  const webContentsId = window.webContents.id;
  let closeRequested: Promise<void> | undefined;
  let allowClose = false;
  window.webContents.on("did-navigate", () => {
    void registration.documentCommitted(webContentsId).catch(() => {
      reportFailure("document", webContentsId);
    });
  });
  window.webContents.on("render-process-gone", () => {
    void registration.invalidateDocument(webContentsId).catch(() => {
      reportFailure("renderer", webContentsId);
    });
  });
  window.on("close", (event) => {
    if (allowClose) return;
    event.preventDefault();
    if (closeRequested) return;
    // 原生选择器可能在父窗口销毁后存活；先归还窗口拥有的资源，再销毁其原生父窗口。
    closeRequested = registration.closeWindow(webContentsId);
    const finish = () => {
      allowClose = true;
      if (!window.isDestroyed()) window.close();
    };
    void closeRequested.then(finish, () => {
      reportFailure("window", webContentsId);
      finish();
    });
  });
  window.on("closed", () => {
    if (closeRequested) return;
    void registration.closeWindow(webContentsId).catch(() => {
      reportFailure("window", webContentsId);
    });
  });
}
