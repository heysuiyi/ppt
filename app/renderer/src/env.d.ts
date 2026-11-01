import type { DesktopApi } from "@app/shared/ipc";

declare global {
  interface Window {
    desktopApi: DesktopApi;
  }
}
