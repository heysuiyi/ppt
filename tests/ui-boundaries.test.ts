import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const checker = new URL("../scripts/check-ui-boundaries.mjs", import.meta.url).href;
let root: string;
const ui = "app/renderer/src/ui/";
const preview = "app/renderer/src/ui-preview/";
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
        `import { checkUiBoundaries } from ${JSON.stringify(checker)}; process.stdout.write(JSON.stringify(checkUiBoundaries(process.argv[1])));`,
        root,
      ],
      { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8" },
    ),
  );
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ui-boundary-regression-"));
  put(
    "tsconfig.ui.json",
    JSON.stringify({
      compilerOptions: { moduleResolution: "Bundler", module: "ESNext", jsx: "react-jsx" },
      include: [`${ui}**/*.ts`, `${ui}**/*.tsx`, `${preview}**/*.ts`, "vite.ui.config.ts"],
    }),
  );
  put("vite.ui.config.ts", "export default {};");
  put(`${ui}components/button/Button.tsx`, "export const Button = 1;");
  put(`${ui}styles.css`, ".ui-root { color: black; }");
  put(
    `${preview}main.ts`,
    'import { Button } from "../ui/components/button/Button"; import "../ui/styles.css"; void Button;',
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("独立 UI 构建图边界", () => {
  it("接受公开组件和作用域内 CSS 的真实依赖图", () => {
    expect(check()).toEqual({ ok: true, failures: [] });
  });
  it("只授权 Markdown 的独立 micromark 入口，仍拒绝整包与其他引擎", () => {
    put("package.json", '{"type":"module"}');
    put(
      "node_modules/@incremark/core/package.json",
      JSON.stringify({
        name: "@incremark/core",
        exports: {
          ".": "./index.d.ts",
          "./engines/micromark": "./micromark.d.ts",
          "./engines/marked": "./marked.d.ts",
        },
      }),
    );
    for (const file of ["index", "micromark", "marked"]) {
      put(`node_modules/@incremark/core/${file}.d.ts`, "export declare const builder: unknown;");
    }
    put(
      `${ui}components/markdown/Markdown.tsx`,
      'import { builder } from "@incremark/core/engines/micromark"; void builder;',
    );
    expect(check()).toEqual({ ok: true, failures: [] });
    for (const entry of ["@incremark/core", "@incremark/core/engines/marked"]) {
      put(
        `${ui}components/markdown/Markdown.tsx`,
        `import { builder } from "${entry}"; void builder;`,
      );
      expect(check().ok).toBe(false);
    }
  });
  it("拒绝 Vite 将已检查入口重定向到旧全局样式", () => {
    put("app/renderer/src/styles.css", "body { color: red; }");
    put(
      "vite.ui.config.ts",
      'export default { resolve: { alias: { "../ui/styles.css": "./app/renderer/src/styles.css" } } };',
    );
    expect(check().ok).toBe(false);
  });
  it("拒绝通过 image-set 字符串绕过资源检查", () => {
    put(
      `${ui}styles.css`,
      '.ui-root { background: image-set("https://example.invalid/background.png" 1x); }',
    );
    expect(check().ok).toBe(false);
  });
  it("允许桌面消费公开组件与纯样式，但不能带入旧界面实现", () => {
    const desktop = "app/renderer/src/desktop/";
    put(`${preview}workspace.css`, ".ui-root .workspace { display: grid; }");
    put("app/shared/harness-ipc.ts", "export interface HarnessDesktopApi { snapshot(): void; }");
    put(
      `${desktop}DesktopApp.tsx`,
      'import { Button } from "../ui/components/button/Button"; import "../ui-preview/workspace.css"; import type { HarnessDesktopApi } from "../../../shared/harness-ipc"; void Button;',
    );
    expect(check()).toEqual({ ok: true, failures: [] });
    put("app/renderer/src/components/OldWorkspace.tsx", "export const OldWorkspace = 1;");
    put(
      `${desktop}DesktopApp.tsx`,
      'import { OldWorkspace } from "../components/OldWorkspace"; void OldWorkspace;',
    );
    expect(check().ok).toBe(false);
  });
  it("拒绝桌面把跨进程契约作为运行实现或读取组件私有入口", () => {
    const desktop = "app/renderer/src/desktop/";
    put("app/shared/harness-ipc.ts", "export const unsafe = 1;");
    put(`${desktop}DesktopApp.tsx`, 'import { unsafe } from "../../../shared/harness-ipc";');
    expect(check().ok).toBe(false);
    put(`${ui}internal/private.ts`, "export const privateValue = 1;");
    put(`${desktop}DesktopApp.tsx`, 'import { privateValue } from "../ui/internal/private";');
    expect(check().ok).toBe(false);
  });
});
