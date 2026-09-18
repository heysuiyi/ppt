import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Electron/Chromium inherits the console independently of the application logger.
// Configure its code page before either electron-vite or Electron starts.
if (process.platform === "win32") {
  try {
    execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", "chcp 65001"], {
      stdio: ["inherit", "ignore", "pipe"],
      windowsHide: true,
    });
  } catch {
    console.warn("[launcher] Could not set console UTF-8; use a UTF-8 terminal. Log files use UTF-8.");
  }
}

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("electron-vite/package.json"));
await import(pathToFileURL(join(packageRoot, "bin/electron-vite.js")).href);
