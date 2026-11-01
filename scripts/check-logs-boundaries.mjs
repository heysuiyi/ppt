import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entries = ["log-contract", "logs", "node-logs"];
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

// Include type imports, import expressions, require and ambient reference directives:
// erased imports are just as capable of breaching a declaration boundary.
function dependencies(source) {
  const result = [];
  function visit(node) {
    let argument;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      argument = node.moduleSpecifier;
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      argument = node.moduleReference.expression;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      argument = node.argument.literal;
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      argument = node.arguments[0];
      if (!argument || !ts.isStringLiteralLike(argument)) result.push({ node, dynamic: true });
    }
    if (argument && ts.isStringLiteralLike(argument))
      result.push({ node, argument, specifier: argument.text });
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const [kind, references] of [
    ["types", source.typeReferenceDirectives],
    ["path", source.referencedFiles],
    ["lib", source.libReferenceDirectives],
  ]) {
    for (const reference of references)
      result.push({ node: { getStart: () => reference.pos }, kind, specifier: reference.fileName });
  }
  return result;
}

export function checkLogsBoundaries(rootDir = repositoryRoot) {
  function identity(file) {
    const absolute = path.normalize(ts.sys.realpath?.(path.resolve(file)) ?? path.resolve(file));
    return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
  }
  const root = identity(rootDir);
  const packageRoot = identity(path.join(root, "packages/logs"));
  const sourceRoot = identity(path.join(packageRoot, "src"));
  const distRoot = identity(path.join(packageRoot, "dist"));
  const within = (directory, file) => {
    const relative = path.relative(directory, file);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  };
  const owned = (file) => within(sourceRoot, file) || within(distRoot, file);
  const diagnostics = [];
  const seen = new Set();
  function report(project, source, dependency, rule, message) {
    const position =
      source && dependency
        ? source.getLineAndCharacterOfPosition(dependency.node.getStart(source))
        : { line: 0, character: 0 };
    const diagnostic = {
      project,
      source: source?.fileName ?? project,
      line: position.line + 1,
      column: position.character + 1,
      target: dependency?.specifier,
      rule,
      message,
    };
    const key = JSON.stringify(diagnostic);
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(diagnostic);
    }
  }
  const manifestFile = path.join(packageRoot, "package.json");
  const manifestResult = ts.readConfigFile(manifestFile, ts.sys.readFile);
  if (manifestResult.error) {
    report(
      manifestFile,
      undefined,
      undefined,
      "manifest",
      ts.flattenDiagnosticMessageText(manifestResult.error.messageText, "\n"),
    );
    return diagnostics;
  }
  const manifest = manifestResult.config;
  const publicTargets = new Map();
  if (
    manifest.name !== "@agent-harness/logs" ||
    manifest.version !== "0.1.0" ||
    manifest.private !== true ||
    manifest.type !== "module" ||
    manifest.engines?.node !== ">=24"
  )
    report(
      manifestFile,
      undefined,
      undefined,
      "manifest",
      "Expected private @agent-harness/logs@0.1.0, ESM, Node >=24.",
    );
  if (
    Object.keys(manifest.dependencies ?? {}).length ||
    Object.keys(manifest.optionalDependencies ?? {}).length ||
    Object.keys(manifest.peerDependencies ?? {}).length
  )
    report(
      manifestFile,
      undefined,
      undefined,
      "dependencies",
      "Logs must have no runtime, optional or peer dependencies.",
    );
  if (
    JSON.stringify(Object.keys(manifest.exports ?? {}).sort()) !==
    JSON.stringify(entries.map((entry) => `./${entry}`).sort())
  )
    report(
      manifestFile,
      undefined,
      undefined,
      "exports",
      "Only three exact public subpath exports are allowed.",
    );
  for (const entry of entries) {
    const conditions = manifest.exports?.[`./${entry}`];
    if (
      !conditions ||
      JSON.stringify(Object.keys(conditions).sort()) !== JSON.stringify(["import", "types"]) ||
      conditions.import !== `./dist/${entry}.js` ||
      conditions.types !== `./dist/${entry}.d.ts`
    ) {
      report(
        manifestFile,
        undefined,
        undefined,
        "exports",
        `Invalid export conditions for ${entry}.`,
      );
      continue;
    }
    publicTargets.set(`@agent-harness/logs/${entry}`, {
      js: identity(path.join(packageRoot, conditions.import)),
      types: identity(path.join(packageRoot, conditions.types)),
    });
  }
  function resolve(dependency, source, options) {
    if (dependency.kind === "path")
      return identity(path.resolve(path.dirname(source.fileName), dependency.specifier));
    if (dependency.kind === "types")
      return ts.resolveTypeReferenceDirective(
        dependency.specifier,
        source.fileName,
        options,
        ts.sys,
      ).resolvedTypeReferenceDirective?.resolvedFileName;
    if (dependency.kind === "lib") return undefined;
    const mode = dependency.argument
      ? ts.getModeForUsageLocation(source, dependency.argument, options)
      : undefined;
    return ts.resolveModuleName(
      dependency.specifier,
      source.fileName,
      options,
      ts.sys,
      undefined,
      undefined,
      mode,
    ).resolvedModule?.resolvedFileName;
  }
  const projects = ["packages/logs/tsconfig.json", "tsconfig.node.json", "tsconfig.web.json"];
  for (const relative of projects) {
    const configFile = path.join(root, relative);
    const config = ts.readConfigFile(configFile, ts.sys.readFile);
    if (config.error) {
      report(
        configFile,
        undefined,
        undefined,
        "project",
        ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
      );
      continue;
    }
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configFile));
    for (const error of parsed.errors)
      report(
        configFile,
        undefined,
        undefined,
        "project",
        ts.flattenDiagnosticMessageText(error.messageText, "\n"),
      );
    // Resolution mode inspects the usage's parents, including type-only import nodes.
    const options = { ...parsed.options, noEmit: true };
    const program = ts.createProgram(
      parsed.fileNames,
      options,
      ts.createCompilerHost(options, true),
    );
    const nodeReachable = new Set();
    const sourceByIdentity = new Map(
      program.getSourceFiles().map((source) => [identity(source.fileName), source]),
    );
    function graph(file, visited, generic = false) {
      file = identity(file);
      if (visited.has(file)) return;
      visited.add(file);
      const source =
        sourceByIdentity.get(file) ??
        (() => {
          const text = ts.sys.readFile(file);
          return text === undefined
            ? undefined
            : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        })();
      if (!source) {
        report(configFile, undefined, undefined, "missing-output", `Missing graph entry ${file}`);
        return;
      }
      if (
        generic &&
        (file.endsWith(`${path.sep}node-logs.ts`) ||
          file.endsWith(`${path.sep}node-logs.js`) ||
          file.endsWith(`${path.sep}node-logs.d.ts`) ||
          /[/\\]internal[/\\]node-/.test(file))
      )
        report(
          configFile,
          source,
          undefined,
          "generic-node",
          "Generic logging closure includes Node implementation.",
        );
      for (const dependency of dependencies(source)) {
        if (dependency.dynamic) {
          if (owned(file))
            report(
              configFile,
              source,
              dependency,
              "dynamic-import",
              "Package imports must be statically resolvable.",
            );
          continue;
        }
        if (generic && (dependency.kind === "types" || builtins.has(dependency.specifier)))
          report(
            configFile,
            source,
            dependency,
            "generic-node",
            "Generic logging closure must not reference Node or ambient declarations.",
          );
        if (builtins.has(dependency.specifier) || dependency.kind === "lib") continue;
        const target = resolve(dependency, source, parsed.options);
        if (target && owned(identity(target))) graph(target, visited, generic);
        else if (owned(file))
          report(
            configFile,
            source,
            dependency,
            "package-escape",
            "Package imports must resolve inside its own source or dist (except Node builtins).",
          );
      }
    }
    for (const extension of [".ts", ".js", ".d.ts"])
      graph(
        path.join(extension === ".ts" ? sourceRoot : distRoot, `node-logs${extension}`),
        nodeReachable,
      );
    for (const entry of ["logs", "log-contract"])
      for (const extension of [".ts", ".js", ".d.ts"])
        graph(
          path.join(extension === ".ts" ? sourceRoot : distRoot, `${entry}${extension}`),
          new Set(),
          true,
        );
    for (const source of program.getSourceFiles()) {
      const file = identity(source.fileName);
      if (
        program.isSourceFileDefaultLibrary(source) ||
        (within(path.join(root, "node_modules"), file) && !owned(file))
      )
        continue;
      for (const dependency of dependencies(source)) {
        if (dependency.dynamic) {
          if (owned(file))
            report(
              configFile,
              source,
              dependency,
              "dynamic-import",
              "Package imports must be statically resolvable.",
            );
          continue;
        }
        const specifier = dependency.specifier;
        if (builtins.has(specifier)) {
          if (owned(file) && !nodeReachable.has(file))
            report(
              configFile,
              source,
              dependency,
              "node-graph",
              "Node builtins are restricted to the Node implementation graph.",
            );
          continue;
        }
        const resolved = resolve(dependency, source, parsed.options);
        const target = resolved ? identity(resolved) : undefined;
        if (owned(file)) {
          if (dependency.kind === "lib") continue;
          if (!target || !owned(target))
            report(
              configFile,
              source,
              dependency,
              "package-escape",
              "Package imports must stay inside its source/dist.",
            );
          continue;
        }
        const publicTarget = publicTargets.get(specifier);
        if (publicTarget) {
          if (
            !target ||
            target !== publicTarget.types ||
            !ts.sys.fileExists(publicTarget.js) ||
            !ts.sys.fileExists(publicTarget.types)
          )
            report(
              configFile,
              source,
              dependency,
              "public-resolution",
              "Normal package import must resolve to its manifest's actual dist declaration and JavaScript.",
            );
        } else if (
          (target && owned(target)) ||
          specifier === "@agent-harness/logs" ||
          specifier.startsWith("@agent-harness/logs/") ||
          /(?:^|\/)packages\/logs\/(?:src|dist)\//.test(specifier.replaceAll("\\", "/")) ||
          (target && within(path.join(root, "src/logs"), target))
        ) {
          const whitebox =
            file === identity(path.join(root, "tests/log-safety.test.ts")) &&
            target === identity(path.join(distRoot, "internal/log-safety.d.ts")) &&
            /(?:^|\/)dist\/internal\/log-safety\.js$/.test(specifier.replaceAll("\\", "/"));
          if (!whitebox)
            report(
              configFile,
              source,
              dependency,
              "consumer-bypass",
              "Consumers must use exact public package imports; only the log-safety test has an exact private dist grant.",
            );
        }
      }
    }
  }
  return diagnostics;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const diagnostics = checkLogsBoundaries();
  for (const diagnostic of diagnostics)
    console.error(
      `${diagnostic.source}:${diagnostic.line}:${diagnostic.column} [${diagnostic.rule}] ${diagnostic.message}`,
    );
  if (diagnostics.length) process.exitCode = 1;
  else
    console.log(
      "Logging package boundaries passed (TypeScript-resolved package, node and web graphs).",
    );
}
