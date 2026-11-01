import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Match tsconfig `jsx: "react-jsx"` so test files do not need a React default import.
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@app": resolve("app"),
      "@shared": resolve("src/shared"),
      "@ppt": resolve("src/ppt"),
      "@design-system": resolve("src/design-system"),
      "@main": resolve("app/main"),
    },
  },
  test: {
    environment: "node",
    server: {
      // Public entries and exact white-box dist imports share one emitted module graph.
      deps: {
        inline: [
          /\/packages\/(?:harness|logs|models|tools)\/dist\//,
          /^@agent-harness\/(?:core|logs|models|tools)(?:\/|$)/,
        ],
      },
    },
    maxWorkers: 4,
    setupFiles: [resolve("tests/setup.ts")],
  },
});
