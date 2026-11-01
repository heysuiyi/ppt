import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const identity = (file) => {
  const absolute = path.resolve(file);
  const real = ts.sys.realpath?.(absolute) ?? absolute;
  return (ts.sys.useCaseSensitiveFileNames ? real : real.toLowerCase()).replaceAll("\\", "/");
};
const base = identity(root);
const inside = (directory, file) => file === directory || file.startsWith(`${directory}/`);
const cli = `${base}/cli`;
const configuration = `${base}/packages/configuration`;
const legacyConfiguration = `${base}/app/main/agent-configuration`;
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
  for (const source of program.getSourceFiles()) {
    const importer = identity(source.fileName);
    if (
      !inside(base, importer) ||
      importer.includes("/node_modules/") ||
      importer.includes("/cli/dist/")
    )
      continue;
    const isCli = inside(cli, importer);
    const isConfiguration = inside(configuration, importer);
    const browser =
      inside(`${base}/app/renderer`, importer) || inside(`${base}/app/preload`, importer);
    const terminal = inside(`${cli}/terminal`, importer);
    function inspect(specifier, typeOnly) {
      if (!specifier || !ts.isStringLiteralLike(specifier)) {
        if (isCli || isConfiguration)
          failures.add(`${importer}: computed module loads are not supported at this boundary`);
        return;
      }
      const name = specifier.text;
      if (isBuiltin(name)) return;
      const resolution = ts.resolveModuleName(
        name,
        source.fileName,
        parsed.options,
        ts.sys,
      ).resolvedModule;
      if (!resolution) {
        if (isCli || isConfiguration) failures.add(`${importer}: unresolved module ${name}`);
        return;
      }
      const target = identity(resolution.resolvedFileName);
      if (
        isCli &&
        (name === "electron" || inside(`${base}/app`, target) || inside(`${base}/src`, target))
      )
        failures.add(`${importer}: CLI depends on application-private ${name}`);
      if (
        isConfiguration &&
        (name === "electron" ||
          inside(`${base}/app`, target) ||
          inside(`${base}/src`, target) ||
          inside(cli, target))
      )
        failures.add(`${importer}: configuration depends on host-private ${name}`);
      if (
        terminal &&
        ((inside(`${cli}/host`, target) && !typeOnly) ||
          ["configuration", "tools", "models", "logs"].some((folder) =>
            inside(`${base}/packages/${folder}`, target),
          ))
      )
        failures.add(`${importer}: terminal depends on host implementation ${name}`);
      if (isCli && inside(legacyConfiguration, target))
        failures.add(`${importer}: legacy configuration import ${name}`);
      const pureConfig = new Set([
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
      if (
        browser &&
        name.startsWith("@agent-harness/configuration/") &&
        !pureConfig.has(name.slice("@agent-harness/configuration/".length))
      )
        failures.add(`${importer}: Node configuration exposed to browser/preload ${name}`);
      for (const value of manifests.values()) {
        if (!inside(value.directory, target) || inside(value.directory, importer)) continue;
        // Existing packages own their white-box grants; this checker owns all
        // CLI/configuration edges and the new configuration public boundary.
        if (!isCli && !isConfiguration && value.directory !== configuration) continue;
        if (value.exports.get(name)?.has(target)) continue;
        const stem = path.basename(target).replace(/\.(?:d\.ts|[cm]?js|tsx?)$/, "");
        if (inside(`${configuration}/dist/internal`, target) && whiteBox.get(importer)?.has(stem))
          continue;
        failures.add(`${importer}: unsupported package source/private entry ${name}`);
      }
    }
    function visit(node) {
      if (ts.isImportDeclaration(node))
        inspect(
          node.moduleSpecifier,
          Boolean(
            node.importClause?.isTypeOnly ||
              (node.importClause?.namedBindings &&
                ts.isNamedImports(node.importClause.namedBindings) &&
                !node.importClause.name &&
                node.importClause.namedBindings.elements.every((item) => item.isTypeOnly)),
          ),
        );
      else if (ts.isExportDeclaration(node) && node.moduleSpecifier)
        inspect(node.moduleSpecifier, node.isTypeOnly);
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
if (failures.size) {
  for (const failure of failures) console.error(failure.replaceAll(base, "."));
  process.exitCode = 1;
} else
  console.log(
    "CLI and configuration boundaries passed (independent NodeNext + node/web resolved graphs).",
  );
