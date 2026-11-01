import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Match tsconfig `jsx: "react-jsx"` so test files do not need a React default import.
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@shared": resolve("src/shared"),
      "@ppt": resolve("src/ppt"),
      "@design-system": resolve("src/design-system"),
      "@main": resolve("src/main"),
    },
  },
  test: {
    environment: "node",
    server: {
      // Public entries and exact white-box dist imports share one emitted module graph.
      deps: {
        inline: [/\/packages\/(?:harness|logs)\/dist\//, /^@agent-harness\/(?:core|logs)(?:\/|$)/],
      },
    },
    maxWorkers: 4,
    setupFiles: [resolve("tests/setup.ts")],
  },
});
