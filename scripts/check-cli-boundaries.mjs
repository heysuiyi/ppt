import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const inside = (directory, file) => file === directory || file.startsWith(`${directory}/`);
const pureConfigurationEntries = new Set([
  "configuration-contract",
  "credential-contract",
  "settings",
  "model-contract",
  "gateway-settings",
  "step-limits",
  "model-reasoning",
  "model-catalog",
  "remote-models",
]);

function importIsTypeOnly(node) {
  const clause = node.importClause;
  const bindings = clause?.namedBindings;
  return Boolean(
    clause?.isTypeOnly ||
      (!clause?.name &&
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((item) => item.isTypeOnly)),
  );
}

function exportIsTypeOnly(node) {
  return Boolean(
    node.isTypeOnly ||
      (node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((item) => item.isTypeOnly)),
  );
}

/** Resolve each consumer's graph without emitting or typechecking. */
export function checkCliBoundaries(rootDir = repositoryRoot) {
  const root = path.resolve(rootDir);
  const identity = (file) => {
    const absolute = path.resolve(file);
    const real = ts.sys.realpath?.(absolute) ?? absolute;
    return (ts.sys.useCaseSensitiveFileNames ? real : real.toLowerCase()).replaceAll("\\", "/");
  };
  const base = identity(root);
  const cli = `${base}/cli`;
  const host = `${cli}/host`;
  const configuration = `${base}/packages/configuration`;
  const legacyConfiguration = `${base}/app/main/agent-configuration`;
  const pureHostEntries = new Set([
    `${host}/host-projection.ts`,
    `${host}/safe-display-text.ts`,
    `${host}/tool-display.ts`,
  ]);
  const neutralEntries = new Set([
    `${host}/node-host.ts`,
    `${host}/host-contract.ts`,
    ...pureHostEntries,
  ]);
  const cliAdapter = (file) =>
    inside(`${cli}/terminal`, file) ||
    inside(`${cli}/commands`, file) ||
    ["terminal-host.ts", "terminal-host-contract.ts", "model-setup.ts"].some(
      (name) => file === `${host}/${name}`,
    );
  const manifests = new Map();
  for (const folder of ["configuration", "harness", "logs", "models", "tools"]) {
    const directory = path.join(root, "packages", folder);
    const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
    const exports = new Map();
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      exports.set(
        `${manifest.name}/${subpath.slice(2)}`,
        new Set(Object.values(target).map((file) => identity(path.join(directory, file)))),
      );
    }
    manifests.set(manifest.name, { directory: identity(directory), exports });
  }
  const whiteBox = new Map([
    [`${base}/tests/credential-store.test.ts`, new Set(["credential-store", "credential-types"])],
    [`${base}/tests/remote-models.test.ts`, new Set(["model-discovery"])],
  ]);
  const failures = new Set();
  const graph = new Map();
  const display = (file) => file.replaceAll(base, ".");
  for (const configName of [
    "cli/tsconfig.json",
    "packages/configuration/tsconfig.json",
    "tsconfig.node.json",
    "tsconfig.web.json",
  ]) {
    const file = path.join(root, configName);
    const loaded = ts.readConfigFile(file, ts.sys.readFile);
    if (loaded.error) throw new Error(`Cannot read ${configName}`);
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(file));
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const queue = [...program.getSourceFiles()];
    const seen = new Set();
    for (let index = 0; index < queue.length; index++) {
      const source = queue[index];
      const importer = identity(source.fileName);
      if (
        seen.has(importer) ||
        !inside(base, importer) ||
        importer.includes("/node_modules/") ||
        inside(`${cli}/dist`, importer)
      )
        continue;
      seen.add(importer);
      if (!graph.has(importer)) graph.set(importer, new Map());
      const isCli = inside(cli, importer);
      const isConfiguration = inside(configuration, importer);
      const browser =
        inside(`${base}/app/renderer`, importer) || inside(`${base}/app/preload`, importer);
      const shared = inside(`${base}/app/shared`, importer);
      const desktopHost = inside(`${base}/app/main/agent-host`, importer);
      function inspect(specifier, typeOnly) {
        const position = source.getLineAndCharacterOfPosition(
          (specifier ?? source).getStart(source),
        );
        const location = `${display(importer)}:${position.line + 1}:${position.character + 1}`;
        const name = specifier && ts.isStringLiteralLike(specifier) ? specifier.text : undefined;
        const builtin = name !== undefined && isBuiltin(name);
        const resolution =
          name !== undefined && !builtin
            ? ts.resolveModuleName(name, source.fileName, parsed.options, ts.sys).resolvedModule
            : undefined;
        const target = resolution ? identity(resolution.resolvedFileName) : undefined;
        const edge = { target, name, builtin, typeOnly, location };
        graph.get(importer).set(`${location}:${name}:${target}:${typeOnly}`, edge);
        if (name === undefined) {
          if (isCli || isConfiguration || browser || shared || desktopHost)
            failures.add(`${location}: computed module loads are not supported at this boundary`);
          return;
        }
        if (builtin) return;
        if (!target) {
          if (isCli || isConfiguration || desktopHost)
            failures.add(`${location}: unresolved module ${name}`);
          return;
        }
        // Literal require() and dynamic imports need not be part of TS's initial
        // program. Visit their resolved files as well, including barrel modules.
        if (
          inside(base, target) &&
          !target.includes("/node_modules/") &&
          /\.(?:[cm]?[jt]sx?)$/i.test(target) &&
          !seen.has(target)
        ) {
          const dependency = program.getSourceFile(resolution.resolvedFileName);
          const text = dependency ? undefined : ts.sys.readFile(resolution.resolvedFileName);
          if (dependency) queue.push(dependency);
          else if (text !== undefined)
            queue.push(
              ts.createSourceFile(resolution.resolvedFileName, text, ts.ScriptTarget.Latest, true),
            );
        }
        if (
          isCli &&
          (name === "electron" || inside(`${base}/app`, target) || inside(`${base}/src`, target))
        )
          failures.add(`${location}: CLI depends on application-private ${name}`);
        if (
          isConfiguration &&
          (name === "electron" ||
            inside(`${base}/app`, target) ||
            inside(`${base}/src`, target) ||
            inside(cli, target))
        )
          failures.add(`${location}: configuration depends on host-private ${name}`);
        if (isCli && inside(legacyConfiguration, target))
          failures.add(`${location}: legacy configuration import ${name}`);
        if (
          inside(`${cli}/terminal`, importer) &&
          ["configuration", "tools", "models", "logs"].some((folder) =>
            inside(`${base}/packages/${folder}`, target),
          )
        )
          failures.add(`${location}: terminal depends on host implementation ${name}`);
        if (
          browser &&
          name.startsWith("@agent-harness/configuration/") &&
          !pureConfigurationEntries.has(name.slice("@agent-harness/configuration/".length))
        )
          failures.add(`${location}: Node configuration exposed to browser/preload ${name}`);
        for (const value of manifests.values()) {
          if (!inside(value.directory, target) || inside(value.directory, importer)) continue;
          // Existing packages own their white-box grants; this checker owns all
          // CLI/configuration edges and the configuration public boundary.
          if (!isCli && !isConfiguration && value.directory !== configuration) continue;
          if (value.exports.get(name)?.has(target)) continue;
          const stem = path.basename(target).replace(/\.(?:d\.ts|[cm]?js|tsx?)$/, "");
          if (inside(`${configuration}/dist/internal`, target) && whiteBox.get(importer)?.has(stem))
            continue;
          failures.add(`${location}: unsupported package source/private entry ${name}`);
        }
      }
      function visit(node) {
        if (ts.isImportDeclaration(node)) inspect(node.moduleSpecifier, importIsTypeOnly(node));
        else if (ts.isExportDeclaration(node) && node.moduleSpecifier)
          inspect(node.moduleSpecifier, exportIsTypeOnly(node));
        else if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference)
        )
          inspect(node.moduleReference.expression, node.isTypeOnly);
        else if (ts.isImportTypeNode(node))
          inspect(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, true);
        else if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        )
          inspect(node.arguments[0], false);
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }

  function protect(entry, label, forbidden, runtimeOnly = false) {
    const visited = new Set([entry]);
    const queue = [{ file: entry, previous: undefined, edge: undefined }];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      for (const edge of graph.get(current.file)?.values() ?? []) {
        if (runtimeOnly && edge.typeOnly) continue;
        if (forbidden(edge)) {
          const chain = [];
          for (let step = current; step.previous; step = step.previous) chain.push(step.edge);
          chain.reverse().push(edge);
          failures.add(
            `${display(entry)}: ${label}\n  ${chain
              .map(
                (item) =>
                  `${item.location} --${item.typeOnly ? "type " : ""}${item.name ?? "<computed>"}--> ${item.target ? display(item.target) : item.builtin ? item.name : "<unresolved>"}`,
              )
              .join("\n  ")}`,
          );
          continue;
        }
        if (edge.target && !visited.has(edge.target)) {
          visited.add(edge.target);
          queue.push({ file: edge.target, previous: current, edge });
        }
      }
    }
  }
  const unknown = (edge) => edge.name === undefined || (!edge.target && !edge.builtin);
  for (const entry of graph.keys()) {
    if (neutralEntries.has(entry))
      protect(
        entry,
        "neutral host reaches CLI adapter/application dependency",
        (edge) =>
          unknown(edge) ||
          (edge.target && (cliAdapter(edge.target) || inside(`${base}/app`, edge.target))),
      );
    if (pureHostEntries.has(entry))
      protect(
        entry,
        "pure host projection/text reaches Node I/O or configuration implementation",
        // node:path only performs lexical calculations; filesystem and other platform ports stay forbidden.
        (edge) =>
          (edge.builtin && edge.name !== "node:path" && edge.name !== "path") ||
          (edge.target && inside(configuration, edge.target)),
      );
    if (inside(`${base}/app/main/agent-host`, entry))
      protect(
        entry,
        "desktop host reaches CLI adapter/terminal dependency",
        (edge) => unknown(edge) || (edge.target && cliAdapter(edge.target)),
      );
    if (inside(`${cli}/terminal`, entry))
      protect(
        entry,
        "terminal depends on host implementation (only pure projection/text runtime entries are allowed)",
        (edge) =>
          unknown(edge) ||
          (edge.target &&
            ((inside(host, edge.target) && !pureHostEntries.has(edge.target)) ||
              ["configuration", "tools", "models", "logs"].some((folder) =>
                inside(`${base}/packages/${folder}`, edge.target),
              ))),
        true,
      );
    if (
      inside(`${base}/app/renderer`, entry) ||
      inside(`${base}/app/preload`, entry) ||
      inside(`${base}/app/shared`, entry)
    )
      protect(
        entry,
        "browser/preload/shared contract reaches host Node implementation",
        (edge) =>
          edge.target &&
          (inside(host, edge.target) || inside(`${base}/app/main/agent-host`, edge.target)),
      );
    if (inside(`${base}/app/shared`, entry))
      protect(
        entry,
        "shared desktop contract reaches Node/application implementation",
        (edge) =>
          unknown(edge) ||
          edge.builtin ||
          edge.name === "electron" ||
          (edge.target && (inside(cli, edge.target) || inside(`${base}/app/main`, edge.target))),
      );
  }
  return { ok: failures.size === 0, failures: [...failures] };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = checkCliBoundaries();
  if (!result.ok) {
    for (const failure of result.failures) console.error(failure);
    process.exitCode = 1;
  } else
    console.log(
      "CLI and configuration boundaries passed (independent NodeNext + node/web resolved graphs).",
    );
}
