import type { DesktopApi } from "@app/shared/ipc";
import type { HarnessDesktopApi } from "../../shared/harness-ipc";

declare global {
  interface Window {
    desktopApi: DesktopApi;
    harnessDesktop: HarnessDesktopApi;
  }
}
