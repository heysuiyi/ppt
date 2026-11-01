import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      {
        name: "watch-workspace-artifacts",
        buildStart() {
          // The dependency remains external; watch its emitted files to restart Main in dev.
          for (const name of ["harness", "logs", "models"]) {
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
        "@shared": resolve("src/shared"),
        "@ppt": resolve("src/ppt"),
        "@design-system": resolve("src/design-system"),
        "@main": resolve("src/main"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
        "@ppt": resolve("src/ppt"),
        "@design-system": resolve("src/design-system"),
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
        "@ppt": resolve("src/ppt"),
        "@design-system": resolve("src/design-system"),
      },
    },
    plugins: [react()],
  },
});
