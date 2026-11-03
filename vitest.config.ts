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
          /\/packages\/(?:harness|logs|models|tools|configuration)\/dist\//,
          /^@agent-harness\/(?:core|logs|models|tools|configuration)(?:\/|$)/,
        ],
      },
    },
    // 默认套件包含真实文件、SQLite、HTTP 和子进程，不以五秒单测时限约束共享 CI I/O。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 限制共享 runner 上的编译器/SQLite/PowerShell 争用；本地保留现有并发。
    maxWorkers: process.env.CI ? 2 : 4,
    setupFiles: [resolve("tests/setup.ts")],
  },
});
