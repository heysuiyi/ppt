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
      include: ["app/**/*.ts", "app/**/*.tsx", "vite.ui.config.ts"],
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
});
