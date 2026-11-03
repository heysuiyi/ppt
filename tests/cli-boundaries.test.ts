import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const checker = new URL("../scripts/check-cli-boundaries.mjs", import.meta.url).href;
let root: string;
function put(file: string, content: string) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}
function check(): { ok: boolean; failures: string[] } {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { checkCliBoundaries } from ${JSON.stringify(checker)}; process.stdout.write(JSON.stringify(checkCliBoundaries(process.argv[1])));`,
        root,
      ],
      { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8" },
    ),
  );
}
function rejected(boundary: string, ...files: string[]) {
  const result = check();
  expect(result.ok).toBe(false);
  const failure = result.failures.find((item) => item.includes(boundary));
  expect(failure, result.failures.join("\n")).toBeDefined();
  for (const file of files) expect(failure).toContain(file);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cli-boundary-regression-"));
  put("package.json", JSON.stringify({ type: "module" }));
  const paths: Record<string, string[]> = { "@bridge/*": ["bridges/*.ts"] };
  for (const folder of ["configuration", "harness", "logs", "models", "tools"]) {
    const name = folder === "harness" ? "core" : folder;
    put(
      `packages/${folder}/package.json`,
      JSON.stringify({
        name: `@agent-harness/${name}`,
        type: "module",
        exports: { "./public": { types: "./src/public.ts", import: "./src/public.ts" } },
      }),
    );
    put(`packages/${folder}/src/public.ts`, "export interface PublicValue { id: string; }");
    paths[`@agent-harness/${name}/*`] = [`packages/${folder}/src/*.ts`];
  }
  // 只检查显式模块图，不做类型检查；无需重复加载默认标准库或自动发现 @types。
  const compilerOptions = {
    module: "ESNext",
    moduleResolution: "Bundler",
    baseUrl: root,
    paths,
    noLib: true,
    types: [],
  };
  put(
    "cli/tsconfig.json",
    JSON.stringify({
      compilerOptions: { ...compilerOptions, module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["**/*.ts"],
    }),
  );
  put(
    "packages/configuration/tsconfig.json",
    JSON.stringify({ compilerOptions, include: ["src/**/*.ts"] }),
  );
  put(
    "tsconfig.node.json",
    JSON.stringify({
      compilerOptions,
      include: ["cli/**/*.ts", "app/main/**/*.ts", "app/shared/**/*.ts"],
    }),
  );
  put(
    "tsconfig.web.json",
    JSON.stringify({
      compilerOptions,
      include: ["app/renderer/**/*.ts", "app/preload/**/*.ts", "app/shared/**/*.ts"],
    }),
  );
  put("cli/host/host-contract.ts", "export interface NodeHost { close(): Promise<void>; }");
  put(
    "cli/host/node-host.ts",
    'import type { NodeHost } from "./host-contract.js"; export type Host = NodeHost;',
  );
  put(
    "cli/host/safe-display-text.ts",
    "export const escapeDisplayControls = (text: string) => text;",
  );
  put(
    "cli/host/host-projection.ts",
    'import { escapeDisplayControls } from "./safe-display-text.js"; export const projectHostError = escapeDisplayControls;',
  );
  put(
    "cli/host/tool-display.ts",
    'import { escapeDisplayControls } from "./safe-display-text.js"; export const projectToolDisplay = escapeDisplayControls;',
  );
  put(
    "cli/host/terminal-host-contract.ts",
    "export interface TerminalHost { configureModel(): void; }",
  );
  put("cli/host/terminal-host.ts", "export const createTerminalHost = () => ({});");
  put("cli/host/model-setup.ts", "export interface Setup { secret: string; }");
  put("cli/terminal/output.ts", "export interface TerminalOutput { write(): void; }");
  put("cli/commands/terminal-command.ts", "export const help = 'help';");
  put("app/shared/harness-ipc.ts", "export interface HarnessReply { ok: boolean; }");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolved CLI and neutral host boundaries", () => {
  it("accepts neutral desktop consumption and exact pure terminal runtime entries", () => {
    put(
      "app/main/agent-host/desktop-host.ts",
      'import type { NodeHost } from "../../../cli/host/host-contract"; import { projectHostError } from "../../../cli/host/host-projection"; import type { HarnessReply } from "../../shared/harness-ipc"; export type DesktopHost = NodeHost; void projectHostError;',
    );
    put(
      "cli/terminal/output.ts",
      'import { projectHostError } from "../host/host-projection.js"; import { escapeDisplayControls } from "../host/safe-display-text.js"; import { projectToolDisplay } from "../host/tool-display.js"; import type { TerminalHost } from "../host/terminal-host-contract.js"; export { type NodeHost } from "../host/host-contract.js"; export { projectHostError, escapeDisplayControls, projectToolDisplay };',
    );
    put(
      "app/renderer/main.ts",
      'import type { HarnessReply } from "../shared/harness-ipc"; export type Reply = HarnessReply;',
    );
    expect(check()).toEqual({ ok: true, failures: [] });
  });

  it.each(["node-host", "host-contract", "safe-display-text", "host-projection", "tool-display"])(
    "protects the %s entry's transitive type graph",
    (entry) => {
      put(`cli/host/${entry}.ts`, 'export type { Leak } from "../../bridges/neutral.js";');
      put(
        "bridges/neutral.ts",
        'export type { TerminalOutput as Leak } from "../cli/terminal/output.js";',
      );
      rejected(
        "neutral host reaches",
        `cli/host/${entry}.ts`,
        "bridges/neutral.ts",
        "cli/terminal/output.ts",
      );
    },
  );

  it.each([
    'import type { TerminalOutput } from "../terminal/output.js";',
    'import { type TerminalOutput } from "../terminal/output.js";',
    'export type { TerminalOutput } from "../terminal/output.js";',
    'export { type TerminalOutput } from "../terminal/output.js";',
    'export * from "../terminal/output.js";',
    'export type Leak = import("../terminal/output.js").TerminalOutput;',
    'const leak = import("../terminal/output.js");',
    'const leak = require("../terminal/output.js");',
    'import leak = require("../terminal/output.js");',
  ])("rejects neutral graph dependency syntax: %s", (source) => {
    put("cli/host/node-host.ts", source);
    rejected("neutral host reaches", "cli/host/node-host.ts", "cli/terminal/output.ts");
  });

  it("follows literal require through a module outside the configured source roots", () => {
    put("bridges/required.cts", 'export * from "../cli/terminal/output.js";');
    put("cli/host/node-host.ts", 'const leak = require("../../bridges/required.cjs");');
    rejected("neutral host reaches", "bridges/required.cts", "cli/terminal/output.ts");
  });

  it.each([
    ["../commands/terminal-command.js", "cli/commands/terminal-command.ts"],
    ["./terminal-host.js", "cli/host/terminal-host.ts"],
    ["./terminal-host-contract.js", "cli/host/terminal-host-contract.ts"],
    ["./model-setup.js", "cli/host/model-setup.ts"],
    ["../../app/shared/harness-ipc.js", "app/shared/harness-ipc.ts"],
  ])("rejects neutral dependencies on %s", (specifier, target) => {
    put("cli/host/node-host.ts", `export * from ${JSON.stringify(specifier)};`);
    rejected("neutral host reaches", target);
  });

  it("resolves aliases and real paths rather than trusting an import spelling", () => {
    symlinkSync(path.join(root, "cli/host"), path.join(root, "linked-host"), "junction");
    put("bridges/adapter.ts", 'export * from "../linked-host/terminal-host.js";');
    put("app/main/agent-host/desktop-host.ts", 'export * from "@bridge/adapter";');
    rejected("desktop host reaches", "bridges/adapter.ts", "cli/host/terminal-host.ts");
  });

  it.each([
    ["terminal/output", "TerminalOutput"],
    ["host/terminal-host-contract", "TerminalHost"],
    ["host/model-setup", "Setup"],
  ])("rejects desktop type-only barrel bypass through %s", (target, type) => {
    put("bridges/desktop.ts", `export type { ${type} } from "../cli/${target}.js";`);
    put("app/main/agent-host/desktop-host.ts", `export type { ${type} } from "@bridge/desktop";`);
    rejected("desktop host reaches", "bridges/desktop.ts", `cli/${target}.ts`);
  });

  it.each([
    'import { createTerminalHost } from "../host/terminal-host.js";',
    'export * from "../../bridges/runtime.js";',
    'const host = import("../host/node-host.js");',
  ])("rejects terminal runtime host dependency: %s", (source) => {
    put("bridges/runtime.ts", 'export * from "../cli/host/node-host.js";');
    put("cli/terminal/output.ts", source);
    rejected("terminal depends on host implementation", "cli/terminal/output.ts");
  });

  it.each(["host-projection", "tool-display"])(
    "does not let pure entry %s reexport the Node host",
    (entry) => {
      put(`cli/host/${entry}.ts`, 'export * from "./node-host.js";');
      put("cli/terminal/output.ts", `export * from "../host/${entry}.js";`);
      rejected("terminal depends on host implementation", `${entry}.ts`, "node-host.ts");
    },
  );

  it("distinguishes inline type reexports from runtime exports", () => {
    put("cli/terminal/output.ts", 'export { type NodeHost } from "../host/host-contract.js";');
    expect(check()).toEqual({ ok: true, failures: [] });
  });

  it.each(["node:path", "path"])(
    "allows lexical path calculations through %s without admitting I/O",
    (specifier) => {
      put(
        "cli/host/tool-display.ts",
        `import { posix } from "${specifier}"; export const projectToolDisplay = (value: string) => posix.normalize(value);`,
      );
      expect(check()).toEqual({ ok: true, failures: [] });
    },
  );

  it("keeps pure safety entries free of Node I/O", () => {
    put("cli/host/safe-display-text.ts", 'export { readFile } from "node:fs/promises";');
    rejected("pure host projection/text reaches", "node:fs/promises");
  });

  it.each(["app/renderer/main.ts", "app/preload/index.ts", "app/shared/harness-ipc.ts"])(
    "rejects host implementation types exposed through %s",
    (consumer) => {
      put("bridges/browser.ts", 'export type { Host } from "../cli/host/node-host.js";');
      put(consumer, 'export type { Host } from "../../bridges/browser";');
      rejected("browser/preload/shared contract reaches", consumer, "cli/host/node-host.ts");
    },
  );

  it.each([
    'export { readFile } from "node:fs/promises";',
    'export type { NodeHost } from "../../cli/host/host-contract";',
    'export * from "../main/private";',
  ])("keeps shared desktop DTOs independent: %s", (source) => {
    put("app/main/private.ts", "export const privateValue = 1;");
    put("app/shared/harness-ipc.ts", source);
    rejected("shared desktop contract reaches", "app/shared/harness-ipc.ts");
  });

  it.each(["app/shared/harness-ipc", "src/private"])(
    "preserves CLI application-private protection: %s",
    (target) => {
      put("src/private.ts", "export const privateValue = 1;");
      put("cli/main.ts", `export * from "../${target}.js";`);
      rejected("CLI depends on application-private", target);
    },
  );

  it("preserves public package entries and rejects private relative entry bypasses", () => {
    put("cli/main.ts", 'export type { PublicValue } from "@agent-harness/configuration/public";');
    expect(check()).toEqual({ ok: true, failures: [] });
    put(
      "cli/main.ts",
      'export type { PublicValue } from "../packages/configuration/src/public.js";',
    );
    rejected("unsupported package source/private entry", "cli/main.ts");
  });

  it("preserves the terminal ban on implementation package type edges", () => {
    put(
      "cli/terminal/output.ts",
      'export type { PublicValue } from "@agent-harness/configuration/public";',
    );
    rejected("terminal depends on host implementation", "cli/terminal/output.ts");
  });
});
