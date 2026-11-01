// 新 UI 的静态依赖门禁：解析真实模块/CSS 图，预览只能消费公开入口，不接入旧桌面链路。
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Vite 已依赖 PostCSS；从 Vite 的解析环境取得同一实例，不增加直接依赖或锁文件。
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite/package.json"));
const postcss = viteRequire("postcss");
const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
const browserPackages = new Set([
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
]);
const configurationPackages = new Set(["node:url", "node:path", "vite", "@vitejs/plugin-react"]);
const sourceExtension = /\.(?:[cm]?[jt]sx?|css)$/i;
const inside = (directory, file) => file === directory || file.startsWith(`${directory}/`);

function identity(file) {
  const absolute = path.resolve(file);
  const real = existsSync(absolute) ? realpathSync.native(absolute) : absolute;
  return (ts.sys.useCaseSensitiveFileNames ? real : real.toLowerCase()).replaceAll("\\", "/");
}

// 保守词法器处理 CSS 转义、注释、字符串及嵌套括号；不靠正则切逗号或匹配 url()。
// 未安装 selector/value parser 时，不接受无法证明作用域的 nesting / selector 宏。
function cssTokens(text) {
  const tokens = [];
  let index = 0;
  function escaped() {
    index++;
    const start = index;
    while (index < text.length && /[\da-f]/i.test(text[index]) && index - start < 6) index++;
    if (index > start) {
      const code = Number.parseInt(text.slice(start, index), 16);
      if (/\s/.test(text[index] ?? "")) index++;
      return code === 0 || code > 0x10ffff ? "\ufffd" : String.fromCodePoint(code);
    }
    if (text[index] === "\r" || text[index] === "\n" || text[index] === "\f") {
      if (text[index++] === "\r" && text[index] === "\n") index++;
      return "";
    }
    return text[index++] ?? "";
  }
  while (index < text.length) {
    const character = text[index];
    if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) throw new Error("unterminated CSS comment");
      index = end + 2;
      continue;
    }
    if (/\s/.test(character)) {
      while (/\s/.test(text[++index] ?? "") && index < text.length) {}
      tokens.push({ kind: "space", value: " " });
    } else if (character === '"' || character === "'") {
      const quote = text[index++];
      let value = "";
      while (index < text.length && text[index] !== quote) {
        if (/\r|\n|\f/.test(text[index])) throw new Error("newline in CSS string");
        value += text[index] === "\\" ? escaped() : text[index++];
      }
      if (text[index++] !== quote) throw new Error("unterminated CSS string");
      tokens.push({ kind: "string", value });
    } else if (/[\w-]/.test(character) || character === "\\" || character.charCodeAt(0) >= 128) {
      let value = "";
      while (index < text.length) {
        const current = text[index];
        if (current === "\\") value += escaped();
        else if (/[\w-]/.test(current) || current.charCodeAt(0) >= 128) value += text[index++];
        else break;
      }
      tokens.push({ kind: "word", value });
    } else {
      tokens.push({ kind: "symbol", value: character });
      index++;
    }
  }
  return tokens;
}

function cssReferences(text) {
  const tokens = cssTokens(text);
  const references = [];
  for (let index = 0; index < tokens.length; index++) {
    if (
      tokens[index].kind === "word" &&
      ["image-set", "-webkit-image-set"].includes(tokens[index].value.toLowerCase()) &&
      tokens[index + 1]?.value === "("
    )
      throw new Error("CSS image-set() is not supported at this boundary; use a literal url()");
    if (tokens[index].kind !== "word" || tokens[index].value.toLowerCase() !== "url") continue;
    // 函数名与左括号之间不能有空格；注释由词法器移除。
    if (tokens[index + 1]?.value !== "(") continue;
    let end = index + 2;
    while (end < tokens.length && tokens[end].value !== ")") end++;
    if (end === tokens.length) throw new Error("unterminated CSS url()");
    const value = tokens.slice(index + 2, end).filter((token) => token.kind !== "space");
    if (value.length === 1 && value[0].kind === "string") references.push(value[0].value);
    else {
      if (value.some((token) => token.kind === "string" || token.value === "("))
        throw new Error("computed CSS url() is not supported");
      references.push(value.map((token) => token.value).join(""));
    }
    index = end;
  }
  return { tokens, references };
}

function scopedSelector(selector) {
  const tokens = cssTokens(selector);
  const selectors = [[]];
  const stack = [];
  for (const token of tokens) {
    if (token.kind === "symbol" && ["(", "["].includes(token.value)) stack.push(token.value);
    else if (token.kind === "symbol" && [")", "]"].includes(token.value)) {
      const opening = stack.pop();
      if (opening !== (token.value === ")" ? "(" : "[")) return false;
    }
    if (token.value === "," && token.kind === "symbol" && stack.length === 0) selectors.push([]);
    else selectors[selectors.length - 1].push(token);
  }
  if (stack.length) return false;
  return selectors.every((selectorTokens) => {
    const first = selectorTokens.findIndex((token) => token.kind !== "space");
    if (
      first < 0 ||
      selectorTokens[first].value !== "." ||
      selectorTokens[first + 1]?.kind !== "word" ||
      selectorTokens[first + 1].value !== "ui-root"
    )
      return false;
    const nesting = [];
    let contained = false;
    for (let index = first + 2; index < selectorTokens.length; index++) {
      const token = selectorTokens[index];
      if (token.kind === "symbol" && token.value === "&") return false;
      if (token.kind === "symbol" && ["(", "["].includes(token.value)) nesting.push(token.value);
      else if (token.kind === "symbol" && [")", "]"].includes(token.value)) nesting.pop();
      else if (nesting.length === 0 && !contained) {
        if (token.kind === "symbol" && ["+", "~", "|"].includes(token.value)) return false;
        if (token.value === ">") contained = true;
        if (token.kind === "space") {
          const next = selectorTokens.slice(index + 1).find((part) => part.kind !== "space");
          if (next && !["+", "~", "|"].includes(next.value)) contained = true;
        }
      }
    }
    return true;
  });
}

/** 供 CLI 与临时项目行为测试共用；只读取文件，不构建、不写入缓存。 */
export function checkUiBoundaries(root = defaultRoot) {
  const absoluteRoot = path.resolve(root);
  const base = identity(absoluteRoot);
  const ui = identity(path.join(absoluteRoot, "app/renderer/src/ui"));
  const preview = identity(path.join(absoluteRoot, "app/renderer/src/ui-preview"));
  const configuration = identity(path.join(absoluteRoot, "vite.ui.config.ts"));
  const failures = new Set();
  const queue = [];
  const visited = new Set();
  const cssFiles = new Set();
  const dependencyRoots = new Map();
  const configFile = path.join(absoluteRoot, "tsconfig.ui.json");
  const loaded = ts.readConfigFile(configFile, ts.sys.readFile);
  const report = (file, message) => failures.add(`${file.replaceAll(base, ".")}: ${message}`);
  if (ui !== `${base}/app/renderer/src/ui` || preview !== `${base}/app/renderer/src/ui-preview`)
    report(base, "UI source roots must not be redirected through symlinks");
  if (loaded.error) {
    report(configFile, "cannot read tsconfig.ui.json");
    return { ok: false, failures: [...failures] };
  }
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, absoluteRoot);
  for (const diagnostic of parsed.errors) {
    if (diagnostic.code !== 18003)
      report(configFile, ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  }
  for (const file of parsed.fileNames) {
    const target = identity(file);
    if (target !== configuration && !inside(ui, target) && !inside(preview, target))
      report(
        configFile,
        `type configuration includes non-UI source/global declarations: ${target}`,
      );
  }
  if (
    parsed.options.typeRoots?.length ||
    parsed.options.types?.some((name) => !["vite/client", "node"].includes(name))
  )
    report(configFile, "type configuration must not inject additional global type roots/types");
  const options = parsed.options;
  const projectRequire = createRequire(path.join(absoluteRoot, "package.json"));
  for (const name of [
    "react",
    "react-dom",
    "vite",
    "@vitejs/plugin-react",
    "@types/react",
    "@types/react-dom",
  ]) {
    try {
      let directory;
      try {
        directory = path.dirname(projectRequire.resolve(`${name}/package.json`));
      } catch {
        // 有些合法包不导出 package.json；从真实运行入口向上核对包身份。
        directory = path.dirname(projectRequire.resolve(name));
        while (true) {
          const manifest = path.join(directory, "package.json");
          if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name)
            break;
          const parent = path.dirname(directory);
          if (parent === directory) throw new Error(`Cannot locate installed package ${name}`);
          directory = parent;
        }
      }
      dependencyRoots.set(name, identity(directory));
    } catch {
      // 缺失包将由具体导入给出 unresolved 错误；临时项目不必复制整套 node_modules。
    }
  }

  function collect(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (entry.isSymbolicLink()) {
        // 不递归未知目录软链接，以免循环；文件软链接仍由真实目标边界判定。
        if (sourceExtension.test(entry.name)) queue.push(file);
        else report(identity(file), "directory symlinks are not supported in UI sources");
      } else if (sourceExtension.test(entry.name)) queue.push(file);
    }
  }
  collect(path.join(absoluteRoot, "app/renderer/src/ui"));
  collect(path.join(absoluteRoot, "app/renderer/src/ui-preview"));
  if (existsSync(configuration)) queue.push(configuration);
  else report(configuration, "missing independent Vite configuration");

  function publicUiEntry(target) {
    const relative = target.slice(ui.length + 1);
    const normalized = relative.toLowerCase();
    const component = /^components\/([^/]+)\/([^/]+)\.tsx$/.exec(normalized);
    return (
      normalized === "styles.css" ||
      normalized === "provider/uiprovider.tsx" ||
      Boolean(component && component[2] === component[1].replaceAll("-", "")) ||
      /^patterns\/[a-z][a-z0-9]*\.tsx$/.test(normalized)
    );
  }

  function edge(importer, target, name) {
    const isConfig = importer === configuration;
    if (isConfig) {
      report(importer, `configuration cannot enter application/source graph: ${name}`);
      return;
    }
    const allowed = inside(ui, target) || (inside(preview, importer) && inside(preview, target));
    if (!allowed) {
      report(
        importer,
        `dependency escapes new UI boundary: ${name} -> ${target.replaceAll(base, ".")}`,
      );
      return;
    }
    if (inside(preview, importer) && inside(ui, target) && !publicUiEntry(target)) {
      report(importer, `preview must use a public UI entry: ${name}`);
      return;
    }
    if (sourceExtension.test(target)) queue.push(target);
    return true;
  }

  function localReference(importer, name, stylesheet = false) {
    if (!name || name.startsWith("#")) return;
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(name)) {
      report(importer, `external CSS/asset dependency is forbidden: ${name}`);
      return;
    }
    let clean;
    try {
      clean = decodeURIComponent(name.split(/[?#]/, 1)[0]);
    } catch {
      report(importer, `invalid asset URL: ${name}`);
      return;
    }
    const file = path.resolve(path.dirname(importer), clean);
    if (!existsSync(file)) {
      report(importer, `unresolved CSS/asset dependency: ${name}`);
      return;
    }
    const target = identity(file);
    if (edge(importer, target, name) && stylesheet) {
      cssFiles.add(target);
      queue.push(target);
    }
  }

  function moduleReference(source, specifier) {
    const importer = identity(source.fileName);
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      report(importer, "computed module loads are forbidden");
      return;
    }
    const name = specifier.text;
    const isConfig = importer === configuration;
    const allowedPackages = isConfig ? configurationPackages : browserPackages;
    if (isBuiltin(name)) {
      if (!isConfig || !configurationPackages.has(name))
        report(importer, `Node module is forbidden: ${name}`);
      return;
    }
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(name)) {
      report(importer, `remote/protocol module is forbidden: ${name}`);
      return;
    }
    const clean = name.split(/[?#]/, 1)[0];
    let resolution = ts.resolveModuleName(clean, source.fileName, options, ts.sys).resolvedModule;
    // TS 不解析副作用 CSS；沿用 TS paths/baseUrl 规则解析文件，而不是漏掉样式边。
    if (/\.css$/i.test(clean)) {
      const host = {
        ...ts.sys,
        fileExists: (candidate) =>
          /(?:\.d)?\.css\.ts$/i.test(candidate)
            ? ts.sys.fileExists(candidate.replace(/(?:\.d)?\.css\.ts$/i, ".css"))
            : ts.sys.fileExists(candidate),
      };
      resolution = ts.resolveModuleName(clean, source.fileName, options, host).resolvedModule;
      if (resolution)
        resolution = {
          ...resolution,
          resolvedFileName: resolution.resolvedFileName.replace(/(?:\.d)?\.css\.ts$/i, ".css"),
        };
      if (!resolution && clean.startsWith(".")) {
        const candidate = path.resolve(path.dirname(source.fileName), clean);
        if (existsSync(candidate)) resolution = { resolvedFileName: candidate };
      }
    }
    if (
      !resolution &&
      clean.startsWith(".") &&
      /\.(?:png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|svg|json|txt)$/i.test(clean)
    ) {
      const candidate = path.resolve(path.dirname(source.fileName), clean);
      if (existsSync(candidate)) resolution = { resolvedFileName: candidate };
    }
    if (!resolution) {
      report(importer, `unresolved module: ${name}`);
      return;
    }
    const target = identity(resolution.resolvedFileName);
    if (allowedPackages.has(name)) {
      const packageName = name.startsWith("@vitejs/") ? "@vitejs/plugin-react" : name.split("/")[0];
      const expected = [
        dependencyRoots.get(packageName),
        dependencyRoots.get(`@types/${packageName}`),
      ].filter(Boolean);
      if (expected.some((directory) => inside(directory, target))) return;
      // 同名 paths alias 不能冒充获准第三方包。
      report(
        importer,
        `browser/config package name resolves outside its installed package: ${name}`,
      );
      return;
    }
    if (target.includes("/node_modules/") || name.startsWith("@agent-harness/")) {
      report(importer, `unapproved package dependency: ${name}`);
      return;
    }
    edge(importer, target, name);
  }

  function inspectCss(file) {
    const css = postcss.parse(readFileSync(file, "utf8"), { from: file });
    css.walkRules((rule) => {
      let ancestor = rule.parent;
      let keyframes = false;
      let nested = false;
      while (ancestor) {
        if (ancestor.type === "atrule" && /^(?:-webkit-)?keyframes$/i.test(ancestor.name))
          keyframes = true;
        if (ancestor.type === "rule") nested = true;
        ancestor = ancestor.parent;
      }
      if (!keyframes && (nested || !scopedSelector(rule.selector)))
        report(file, `CSS selector must be explicitly scoped by .ui-root: ${rule.selector}`);
    });
    css.walkAtRules((rule) => {
      const { tokens, references } = cssReferences(rule.params);
      const ruleName = cssTokens(rule.name)
        .map((token) => token.value)
        .join("")
        .toLowerCase();
      if (ruleName === "import") {
        const first = tokens.find((token) => token.kind !== "space");
        if (first?.kind === "string") references.unshift(first.value);
        else if (
          first?.kind !== "word" ||
          first.value.toLowerCase() !== "url" ||
          !references.length
        )
          report(file, "CSS @import requires a literal local path");
      }
      for (const reference of references) localReference(file, reference, ruleName === "import");
    });
    css.walkDecls((declaration) => {
      for (const reference of cssReferences(declaration.value).references)
        localReference(file, reference);
    });
  }

  function constantText(node, constants, seen = new Set()) {
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return constantText(node.expression, constants, seen);
    if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text)) {
      seen.add(node.text);
      return constantText(constants.get(node.text), constants, seen);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = constantText(node.left, constants, new Set(seen));
      const right = constantText(node.right, constants, new Set(seen));
      if (left !== undefined && right !== undefined) return left + right;
    }
    return undefined;
  }

  function inspectSource(file) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const isConfig = file === configuration;
    const constants = new Map();
    function collectConstants(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        constants.set(node.name.text, node.initializer);
      ts.forEachChild(node, collectConstants);
    }
    collectConstants(source);
    for (const reference of source.referencedFiles) {
      const target = path.resolve(path.dirname(file), reference.fileName);
      if (existsSync(target)) edge(file, identity(target), `/// reference ${reference.fileName}`);
      else report(file, `unresolved triple-slash reference: ${reference.fileName}`);
    }
    for (const reference of source.typeReferenceDirectives) {
      // 不允许通过 Node 或旧全局声明扩充浏览器执行面；vite/client 由独立 tsconfig 提供。
      report(file, `triple-slash type/global references are forbidden: ${reference.fileName}`);
    }
    for (const reference of source.libReferenceDirectives)
      report(file, `triple-slash lib references are forbidden: ${reference.fileName}`);
    function visit(node) {
      if (isConfig) {
        // 不能只检查 TS 原始路径，却允许 Vite 别名在构建时换成另一份源码。
        if ((ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) && node.name) {
          const name = ts.isComputedPropertyName(node.name)
            ? constantText(node.name.expression, constants)
            : ts.isIdentifier(node.name)
              ? node.name.text
              : constantText(node.name, constants);
          if (name === undefined || name === "alias" || name === "resolve")
            report(file, "Vite resolver overrides/computed configuration keys are not supported");
        }
        if (ts.isSpreadAssignment(node))
          report(file, "Vite configuration spreads are not supported by the checked graph");
        if (
          (ts.isPropertyAccessExpression(node) && ["resolve", "alias"].includes(node.name.text)) ||
          (ts.isElementAccessExpression(node) &&
            ["resolve", "alias"].includes(constantText(node.argumentExpression, constants)))
        )
          report(file, "Vite resolver mutation is not supported by the checked graph");
      }
      if (ts.isImportDeclaration(node)) moduleReference(source, node.moduleSpecifier);
      else if (ts.isExportDeclaration(node) && node.moduleSpecifier)
        moduleReference(source, node.moduleSpecifier);
      else if (ts.isImportTypeNode(node))
        moduleReference(
          source,
          ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined,
        );
      else if (ts.isImportEqualsDeclaration(node)) {
        if (ts.isExternalModuleReference(node.moduleReference))
          moduleReference(source, node.moduleReference.expression);
      } else if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (
          expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(expression) && expression.text === "require")
        ) {
          if (node.arguments.length !== 1)
            report(file, "module load requires exactly one literal argument");
          moduleReference(source, node.arguments[0]);
        }
        if (
          !isConfig &&
          ts.isPropertyAccessExpression(expression) &&
          ts.isMetaProperty(expression.expression)
        )
          report(file, "import.meta module loaders are forbidden; use explicit imports");
      }
      if (
        ts.isIdentifier(node) &&
        ["require", "importScripts", "eval", "Function"].includes(node.text)
      ) {
        const directRequire =
          node.text === "require" &&
          ts.isCallExpression(node.parent) &&
          node.parent.expression === node;
        if (!directRequire) report(file, `indirect/dynamic loader is forbidden: ${node.text}`);
      }
      const member = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isElementAccessExpression(node)
          ? constantText(node.argumentExpression, constants)
          : undefined;
      if (["require", "createRequire", "importScripts", "eval", "Function"].includes(member))
        report(file, `indirect/dynamic loader member is forbidden: ${member}`);
      if (ts.isMetaProperty(node)) {
        const parent = node.parent;
        if (!ts.isPropertyAccessExpression(parent) || !["url", "env"].includes(parent.name.text))
          report(file, "indirect import.meta module loading is forbidden");
      }
      if (!isConfig) {
        if (ts.isIdentifier(node) && node.text === "desktopApi")
          report(file, "desktopApi is forbidden in browser UI");
        if (
          ts.isElementAccessExpression(node) &&
          constantText(node.argumentExpression, constants) === "desktopApi"
        )
          report(file, "computed desktopApi access is forbidden in browser UI");
        if (
          ts.isBindingElement(node) &&
          node.propertyName &&
          constantText(node.propertyName, constants) === "desktopApi"
        )
          report(file, "destructured desktopApi access is forbidden in browser UI");
        if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "URL" &&
          node.arguments?.[1] &&
          ts.isPropertyAccessExpression(node.arguments[1]) &&
          ts.isMetaProperty(node.arguments[1].expression)
        ) {
          const value = constantText(node.arguments[0], constants);
          if (value === undefined) report(file, "computed module-relative asset URL is forbidden");
          else localReference(file, value);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  for (let index = 0; index < queue.length; index++) {
    const file = identity(queue[index]);
    const css = /\.css$/i.test(file) || cssFiles.has(file);
    const visitKey = `${css ? "css" : "source"}:${file}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    if (file !== configuration && !inside(ui, file) && !inside(preview, file)) {
      report(file, "source realpath escapes new UI directories");
      continue;
    }
    try {
      if (css) inspectCss(file);
      else inspectSource(file);
    } catch (error) {
      report(
        file,
        `cannot inspect dependency: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { ok: failures.size === 0, failures: [...failures].sort() };
}

if (process.argv[1] && identity(process.argv[1]) === identity(fileURLToPath(import.meta.url))) {
  const result = checkUiBoundaries();
  if (result.ok)
    console.log(
      "UI boundaries passed (resolved browser/config module graph and scoped CSS graph).",
    );
  else {
    for (const failure of result.failures) console.error(failure);
    process.exitCode = 1;
  }
}
