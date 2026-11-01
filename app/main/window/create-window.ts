import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { createModuleLogger } from "../agent/logger";
import { resolveExternalHttpUrl } from "../external-navigation";
import { getWindowBackgroundColor, getWindowTitleBarOverlay } from "./theme";

const logger = createModuleLogger("main.window");

function resolveAppIconPath(): string | undefined {
  const candidates = [
    join(process.cwd(), "build", "icon.ico"),
    join(process.cwd(), "build", "icon.png"),
    join(process.resourcesPath, "icon.ico"),
    join(process.resourcesPath, "icon.png"),
    join(app.getAppPath(), "build", "icon.ico"),
    join(app.getAppPath(), "build", "icon.png"),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

export function createWindow(onWindowCreated?: (window: BrowserWindow) => void): BrowserWindow {
  const icon = resolveAppIconPath();
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: "Agent PPT",
    titleBarStyle: "hidden",
    titleBarOverlay: getWindowTitleBarOverlay(),
    backgroundColor: getWindowBackgroundColor(),
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  window.webContents.on("did-fail-load", (_, errorCode, errorDescription, validatedUrl) => {
    logger.error("renderer.load.failed", { errorCode, errorDescription, validatedUrl });
  });
  window.webContents.on("did-finish-load", () => {
    logger.info("renderer.load.completed", { webContentsId: window.webContents.id });
  });
  // 应用菜单已被移除，默认的开发者工具快捷键随之失效，这里手动补回。
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const toggleDevTools =
      input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i");
    if (!toggleDevTools) return;
    event.preventDefault();
    window.webContents.toggleDevTools();
  });
  const openInSystemBrowser = (rawUrl: string) => {
    const externalUrl = resolveExternalHttpUrl(rawUrl);
    if (!externalUrl) return;
    void shell.openExternal(externalUrl).catch((error) => {
      logger.warn("renderer.external-link.open-failed", { externalUrl, error });
    });
  };
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    openInSystemBrowser(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openInSystemBrowser(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  onWindowCreated?.(window);
  return window;
}
