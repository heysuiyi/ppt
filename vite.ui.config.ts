// 独立浏览器预览只服务新 UI；缓存和产物不进入 Electron 的 out/dist。

import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const localPath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  root: localPath("./app/renderer/src/ui-preview/"),
  base: "./",
  publicDir: false,
  plugins: [react()],
  cacheDir: localPath("./.vite/ui-preview/cache/"),
  server: {
    host: "127.0.0.1",
    port: 5178,
    strictPort: true,
    fs: {
      strict: true,
      allow: [
        localPath("./app/renderer/src/ui/"),
        localPath("./app/renderer/src/ui-preview/"),
        localPath("./node_modules/react/"),
        localPath("./node_modules/react-dom/"),
        localPath("./node_modules/scheduler/"),
        localPath("./node_modules/vite/"),
      ],
    },
  },
  preview: { host: "127.0.0.1", port: 5178, strictPort: true },
  build: {
    outDir: localPath("./.vite/ui-preview/build/"),
    emptyOutDir: true,
  },
});
