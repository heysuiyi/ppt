import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve("app/main/index.ts"),
      },
    },
    plugins: [
      externalizeDepsPlugin(),
      {
        name: "watch-workspace-artifacts",
        buildStart() {
          // The dependency remains external; watch its emitted files to restart Main in dev.
          for (const name of ["harness", "logs", "models", "tools", "configuration"]) {
            const directory = resolve(`packages/${name}/dist`);
            for (const file of readdirSync(directory, { recursive: true })) {
              if (typeof file === "string" && file.endsWith(".js")) {
                this.addWatchFile(resolve(directory, file));
              }
            }
          }
        },
      },
    ],
    resolve: {
      alias: {
        "@app": resolve("app"),
        "@shared": resolve("src/shared"),
        "@ppt": resolve("src/ppt"),
        "@design-system": resolve("src/design-system"),
        "@main": resolve("app/main"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve("app/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
    resolve: {
      alias: {
        "@app": resolve("app"),
        "@shared": resolve("src/shared"),
        "@ppt": resolve("src/ppt"),
        "@design-system": resolve("src/design-system"),
      },
    },
  },
  renderer: {
    root: resolve("app/renderer"),
    build: {
      rollupOptions: {
        input: resolve("app/renderer/index.html"),
      },
    },
    resolve: {
      alias: {
        "@app": resolve("app"),
        "@shared": resolve("src/shared"),
        "@ppt": resolve("src/ppt"),
        "@design-system": resolve("src/design-system"),
      },
    },
    plugins: [react()],
  },
});
