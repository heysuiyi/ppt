import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entries = ["tools", "tools-contract", "tools-errors", "atomic-files", "workspace-files"];
const pureEntries = new Set(["tools-contract", "tools-errors"]);
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

// Match the existing models/logs gates: use TS resolution, not an import-text allowlist.
// Also recognize the actual CJS bridge used by atomic.ts: createRequire(import.meta.url)(literal).
function dependencies(source) {
  const result = [];
  const constants = new Map();
  const requireNames = new Set(["require"]);
  const bridgeNames = new Set(["createRequire"]);
  function collect(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === "node:module")
      for (const element of node.importClause?.namedBindings?.elements ?? [])
        if ((element.propertyName ?? element.name).text === "createRequire")
          bridgeNames.add(element.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      constants.set(node.name.text, node.initializer);
      if (
        ts.isCallExpression(node.initializer) &&
        bridgeNames.has(node.initializer.expression.getText(source))
      )
        requireNames.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  }
  collect(source);
  function literal(node, seen = new Set()) {
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return literal(node.expression, seen);
    if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text)) {
      seen.add(node.text);
      return literal(constants.get(node.text), seen);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literal(node.left, new Set(seen)),
        right = literal(node.right, new Set(seen));
      return left === undefined || right === undefined ? undefined : left + right;
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        const part = literal(span.expression, new Set(seen));
        if (part === undefined) return undefined;
        value += part + span.literal.text;
      }
      return value;
    }
    return undefined;
  }
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
    else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const bridge =
        ts.isCallExpression(expression) && bridgeNames.has(expression.expression.getText(source));
      const requireCall = ts.isIdentifier(expression) && requireNames.has(expression.text);
      const resolveCall =
        ts.isPropertyAccessExpression(expression) &&
        ((ts.isIdentifier(expression.expression) &&
          requireNames.has(expression.expression.text) &&
          expression.name.text === "resolve") ||
          (expression.expression.getText(source) === "import.meta" &&
            expression.name.text === "resolve"));
      if (expression.kind === ts.SyntaxKind.ImportKeyword || bridge || requireCall || resolveCall) {
        argument = node.arguments[0];
        if (literal(argument) === undefined) result.push({ node, dynamic: true });
      }
    }
    const specifier = literal(argument);
    if (specifier !== undefined) result.push({ node, argument, specifier });
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const [kind, references] of [
    ["types", source.typeReferenceDirectives],
    ["path", source.referencedFiles],
    ["lib", source.libReferenceDirectives],
  ])
    for (const reference of references)
      result.push({ node: { getStart: () => reference.pos }, kind, specifier: reference.fileName });
  return result;
}

export function checkToolsBoundaries(rootDir = repositoryRoot) {
  const identity = (file) => {
    const absolute = path.normalize(ts.sys.realpath?.(path.resolve(file)) ?? path.resolve(file));
    return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
  };
  const root = identity(rootDir);
  const packageRoot = identity(path.join(root, "packages/tools"));
  const sourceRoot = path.join(packageRoot, "src"),
    distRoot = path.join(packageRoot, "dist");
  const testsRoot = path.join(packageRoot, "tests"),
    oldRoot = path.join(root, "src/tools");
  const reverseRoots = ["harness", "logs", "models"].map((name) =>
    path.join(root, "packages", name),
  );
  const within = (directory, file) => {
    const relative = path.relative(directory, file);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  };
  const owned = (file) => within(sourceRoot, file) || within(distRoot, file);
  const reverseOwner = (file) => reverseRoots.some((directory) => within(directory, file));
  const diagnostics = [],
    seen = new Set();
  function report(project, source, dependency, rule, message) {
    const position =
      source && dependency
        ? source.getLineAndCharacterOfPosition(dependency.node.getStart(source))
        : { line: 0, character: 0 };
    const item = {
      project,
      source: source?.fileName ?? project,
      line: position.line + 1,
      column: position.character + 1,
      target: dependency?.specifier,
      rule,
      message,
    };
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(item);
    }
  }
  function manifestAt(directory) {
    const file = path.join(directory, "package.json"),
      value = ts.readConfigFile(file, ts.sys.readFile);
    if (value.error)
      report(
        file,
        undefined,
        undefined,
        "manifest",
        ts.flattenDiagnosticMessageText(value.error.messageText, "\n"),
      );
    return value.config;
  }
  const manifest = manifestAt(packageRoot);
  if (!manifest) return diagnostics;
  const manifestFile = path.join(packageRoot, "package.json");
  if (
    manifest.name !== "@agent-harness/tools" ||
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
      "Expected private @agent-harness/tools@0.1.0, ESM, Node >=24.",
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
      "Only five exact subpaths are allowed, without root, aliases or wildcards.",
    );
  const publicTargets = new Map(),
    permittedPublic = new Map();
  for (const entry of entries) {
    const value = manifest.exports?.[`./${entry}`];
    if (
      !value ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["import", "types"]) ||
      value.import !== `./dist/${entry}.js` ||
      value.types !== `./dist/${entry}.d.ts`
    )
      report(
        manifestFile,
        undefined,
        undefined,
        "exports",
        `Invalid export conditions for ${entry}.`,
      );
    publicTargets.set(`@agent-harness/tools/${entry}`, {
      js: identity(path.join(distRoot, `${entry}.js`)),
      types: identity(path.join(distRoot, `${entry}.d.ts`)),
    });
  }
  const required = ["@agent-harness/core", "@agent-harness/logs", "proper-lockfile", "zod"];
  if (
    JSON.stringify(Object.keys(manifest.dependencies ?? {}).sort()) !==
      JSON.stringify(required.sort()) ||
    manifest.dependencies?.["@agent-harness/core"] !== "0.1.0" ||
    manifest.dependencies?.["@agent-harness/logs"] !== "0.1.0" ||
    Object.keys(manifest.optionalDependencies ?? {}).length ||
    Object.keys(manifest.peerDependencies ?? {}).length
  )
    report(
      manifestFile,
      undefined,
      undefined,
      "dependencies",
      "Tools requires exactly same-version Core/logs, proper-lockfile and zod runtime dependencies.",
    );
  for (const directory of reverseRoots) {
    const other = manifestAt(directory);
    for (const kind of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ])
      if (
        Object.keys(other?.[kind] ?? {}).some(
          (name) => name === "@agent-harness/tools" || name.startsWith("@agent-harness/tools/"),
        )
      )
        report(
          path.join(directory, "package.json"),
          undefined,
          undefined,
          "reverse-dependency",
          "Core/logs/models must not depend on tools.",
        );
    if (other?.name === "@agent-harness/models") continue;
    for (const [entry, conditions] of Object.entries(other?.exports ?? {}))
      if (entry.startsWith("./") && !entry.includes("*") && conditions.types && conditions.import)
        permittedPublic.set(`${other.name}/${entry.slice(2)}`, {
          types: identity(path.join(directory, conditions.types)),
          js: identity(path.join(directory, conditions.import)),
        });
  }
  function resolve(dependency, source, options, runtime = false) {
    if (dependency.kind === "lib") return undefined;
    if (dependency.kind === "path")
      return path.resolve(path.dirname(source.fileName), dependency.specifier);
    if (dependency.kind === "types")
      return ts.resolveTypeReferenceDirective(
        dependency.specifier,
        source.fileName,
        options,
        ts.sys,
      ).resolvedTypeReferenceDirective?.resolvedFileName;
    if (runtime && dependency.specifier.startsWith(".")) {
      const file = path.resolve(path.dirname(source.fileName), dependency.specifier);
      if (ts.sys.fileExists(file)) return file;
    }
    // Resolve public consumer edges as installed artifacts, not as this package's
    // emission inputs. NodeNext otherwise redirects self-name dist exports back
    // to src under rootDir/outDir when package tests are added to the graph.
    // Keep paths/baseUrl intact: a source alias must still fail the exact-target check.
    const resolutionOptions = publicTargets.has(dependency.specifier)
      ? { ...options, rootDir: undefined, outDir: undefined, declarationDir: undefined }
      : options;
    return ts.resolveModuleName(
      dependency.specifier,
      source.fileName,
      resolutionOptions,
      ts.sys,
      undefined,
      undefined,
      dependency.argument && ts.isStringLiteralLike(dependency.argument)
        ? ts.getModeForUsageLocation(source, dependency.argument, resolutionOptions)
        : undefined,
    ).resolvedModule?.resolvedFileName;
  }
  const standard = (file) => {
    const relative = path.relative(path.dirname(ts.getDefaultLibFilePath({})), file);
    return !relative.includes(path.sep) && /^lib\..*\.d\.ts$/i.test(relative);
  };
  const externalRuntime = (specifier) => /^(?:proper-lockfile|zod)(?:\/|$)/.test(specifier);
  const browserFile = (file) =>
    ["app/shared", "app/renderer", "app/preload", "src/shared", "src/renderer", "src/preload"].some(
      (directory) => within(path.join(root, directory), file),
    );
  const projects = [
    "packages/tools/tsconfig.json",
    ...["harness", "logs", "models"].map((name) => `packages/${name}/tsconfig.json`),
    "tsconfig.node.json",
    "tsconfig.web.json",
  ];
  for (const relative of projects) {
    const configFile = path.join(root, relative),
      config = ts.readConfigFile(configFile, ts.sys.readFile);
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
    const options = { ...parsed.options, allowJs: true, checkJs: false, noEmit: true };
    const roots = [
      ...parsed.fileNames,
      ...[sourceRoot, distRoot, testsRoot].flatMap((directory) =>
        ts.sys.readDirectory(directory, [".ts", ".mts", ".js", ".mjs"], undefined, ["**/*"]),
      ),
    ];
    for (const directory of reverseRoots)
      roots.push(
        ...ts.sys.readDirectory(
          path.join(directory, "dist"),
          [".js", ".mjs", ".d.ts", ".d.mts"],
          undefined,
          ["**/*"],
        ),
      );
    // Include real app/cli and reverse owners even when a tsconfig's current include is incomplete.
    for (const directory of [
      "app",
      "cli",
      "tests",
      "packages/harness/src",
      "packages/logs/src",
      "packages/models/src",
    ])
      roots.push(
        ...ts.sys.readDirectory(
          path.join(root, directory),
          [".ts", ".tsx", ".mts"],
          ["**/node_modules/**", "**/dist/**"],
          ["**/*"],
        ),
      );
    const program = ts.createProgram(roots, options, ts.createCompilerHost(options, true));
    const sources = new Map(
      program.getSourceFiles().map((source) => [identity(source.fileName), source]),
    );
    const checker = program.getTypeChecker();
    function sourceFor(file) {
      if (!sources.has(file)) {
        const text = ts.sys.readFile(file);
        if (text !== undefined)
          sources.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
      }
      return sources.get(file);
    }
    function platformSymbols(source) {
      function visit(node) {
        if (ts.isIdentifier(node)) {
          let symbol = checker.getSymbolAtLocation(node);
          if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
          const declarations = symbol?.getDeclarations() ?? [];
          if (
            !declarations.some((value) => standard(identity(value.getSourceFile().fileName))) &&
            declarations.some((value) =>
              /[/\\]node_modules[/\\](?:@types[/\\]node|proper-lockfile)[/\\]/i.test(
                value.getSourceFile().fileName,
              ),
            )
          )
            report(
              configFile,
              source,
              { node, specifier: node.text },
              "platform-leak",
              "Pure symbols must not require Node or runtime library declarations.",
            );
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    function graph(file, visited, pure, lowLevel, runtime) {
      file = identity(file);
      if (visited.has(file) || standard(file)) return;
      visited.add(file);
      const source = sourceFor(file);
      if (!source) {
        report(configFile, undefined, undefined, "missing-output", `Missing graph entry ${file}`);
        return;
      }
      if (pure) platformSymbols(source);
      for (const dependency of dependencies(source)) {
        if (dependency.dynamic) {
          report(
            configFile,
            source,
            dependency,
            "dynamic-import",
            "Tools closure imports require statically resolvable targets.",
          );
          continue;
        }
        const specifier = dependency.specifier;
        if (dependency.kind === "lib") {
          if (!ts.libMap.has(specifier.toLowerCase()))
            report(
              configFile,
              source,
              dependency,
              "reference",
              "Only standard lib references are allowed.",
            );
          continue;
        }
        if (
          builtins.has(specifier) ||
          externalRuntime(specifier) ||
          (dependency.kind === "types" && specifier === "node")
        ) {
          if (
            pure &&
            (builtins.has(specifier) ||
              /^proper-lockfile(?:\/|$)/.test(specifier) ||
              dependency.kind === "types" ||
              owned(file))
          )
            report(
              configFile,
              source,
              dependency,
              "pure-closure",
              "Pure contract/errors cannot load Node, lock libraries or schemas.",
            );
          continue;
        }
        const value = resolve(dependency, source, options, runtime),
          target = value && identity(value);
        const grant = permittedPublic.get(specifier);
        const ownRelative =
          target && owned(target) && (specifier.startsWith(".") || dependency.kind === "path");
        const publicEdge = target && grant && [grant.types, grant.js].includes(target);
        const internalDependency =
          target &&
          !owned(file) &&
          specifier.startsWith(".") &&
          reverseRoots.some((directory) => within(directory, file) && within(directory, target));
        if (!target || (!ownRelative && !publicEdge && !internalDependency && !standard(target))) {
          report(
            configFile,
            source,
            dependency,
            "package-escape",
            "Tools closure may use only its own relative modules, Node, declared libraries and exact Core/logs public entries.",
          );
          continue;
        }
        if (lowLevel && reverseRoots.some((directory) => within(directory, target))) {
          report(
            configFile,
            source,
            dependency,
            "node-support-closure",
            "Atomic/workspace support must not pull Core or logs into its closure.",
          );
          continue;
        }
        if (
          pure &&
          publicEdge &&
          !source.isDeclarationFile &&
          !(ts.isImportDeclaration(dependency.node) && dependency.node.importClause?.isTypeOnly) &&
          !(ts.isExportDeclaration(dependency.node) && dependency.node.isTypeOnly)
        )
          report(
            configFile,
            source,
            dependency,
            "pure-runtime",
            "Pure contract/errors may reference Core/logs only as public types.",
          );
        graph(target, visited, pure, lowLevel, runtime);
      }
    }
    for (const entry of entries)
      for (const extension of [".ts", ".js", ".d.ts"])
        graph(
          path.join(extension === ".ts" ? sourceRoot : distRoot, `${entry}${extension}`),
          new Set(),
          pureEntries.has(entry),
          entry === "atomic-files" || entry === "workspace-files",
          extension === ".js",
        );
    function reachesPrivateTest(file, visited = new Set()) {
      file = identity(file);
      if (visited.has(file) || !within(testsRoot, file)) return false;
      visited.add(file);
      const source = sourceFor(file);
      if (!source) return false;
      for (const dependency of dependencies(source)) {
        if (dependency.dynamic) return true;
        if (dependency.kind === "lib") continue;
        const value = resolve(dependency, source, options),
          target = value && identity(value);
        if (target && owned(target) && !publicTargets.has(dependency.specifier)) return true;
        if (target && within(testsRoot, target) && reachesPrivateTest(target, visited)) return true;
      }
      return false;
    }
    function browserGraph(file, visited = new Set()) {
      file = identity(file);
      if (visited.has(file) || standard(file)) return;
      visited.add(file);
      const source = sourceFor(file);
      if (!source) return;
      for (const dependency of dependencies(source)) {
        if (dependency.dynamic || dependency.kind === "lib") continue;
        const value = resolve(dependency, source, options),
          target = value && identity(value);
        if (!target) continue;
        const grant = publicTargets.get(dependency.specifier);
        if (owned(target)) {
          if (
            !grant ||
            !pureEntries.has(dependency.specifier.slice("@agent-harness/tools/".length))
          )
            report(
              configFile,
              source,
              dependency,
              "browser-node",
              "The shared/renderer/preload module closure must not reach Node tools entries.",
            );
        } else if (within(root, target) && !target.includes(`${path.sep}node_modules${path.sep}`))
          browserGraph(target, visited);
      }
    }
    const browserVisited = new Set();
    for (const [file] of sources) if (browserFile(file)) browserGraph(file, browserVisited);
    for (const source of [...sources.values()]) {
      const file = identity(source.fileName);
      if (
        program.isSourceFileDefaultLibrary(source) ||
        (program.isSourceFileFromExternalLibrary(source) && !owned(file) && !reverseOwner(file))
      )
        continue;
      for (const dependency of dependencies(source)) {
        if (dependency.dynamic) {
          report(
            configFile,
            source,
            dependency,
            "dynamic-import",
            "Computed import/require targets cannot establish a checked tools boundary.",
          );
          continue;
        }
        const specifier = dependency.specifier;
        if (dependency.kind === "lib") continue;
        const value = resolve(dependency, source, options, /\.m?js$/.test(file)),
          target = value && identity(value);
        if (
          target &&
          within(testsRoot, target) &&
          !within(testsRoot, file) &&
          reachesPrivateTest(target)
        )
          report(
            configFile,
            source,
            dependency,
            "test-private-bridge",
            "External consumers cannot use package tests to bridge private tools implementations.",
          );
        if (within(testsRoot, file) && target) {
          const otherOwner = reverseRoots.find((directory) => within(directory, target));
          const grant = permittedPublic.get(specifier);
          if (otherOwner && (!grant || ![grant.types, grant.js].includes(target)))
            report(
              configFile,
              source,
              dependency,
              "test-other-package-private",
              "Tools white-box tests may not access another package's private modules.",
            );
        }
        if (owned(file)) {
          const grant = permittedPublic.get(specifier);
          if (
            builtins.has(specifier) ||
            externalRuntime(specifier) ||
            (dependency.kind === "types" && specifier === "node")
          )
            continue;
          if (
            !target ||
            (!standard(target) &&
              !(owned(target) && specifier.startsWith(".")) &&
              !(grant && [grant.types, grant.js].includes(target)))
          )
            report(
              configFile,
              source,
              dependency,
              "package-escape",
              "Tools must not depend on host/PPT/models or private Core/logs modules.",
            );
          continue;
        }
        const lexical =
          specifier.startsWith(".") || path.isAbsolute(specifier)
            ? identity(path.resolve(path.dirname(file), specifier))
            : undefined;
        const normalized = specifier.replaceAll("\\", "/");
        const toolsImport =
          /^@agent-harness\/tools(?:\/|$)/.test(specifier) ||
          /(?:^|\/)packages\/tools\/(?:src|dist)(?:\/|$)/.test(normalized) ||
          /(?:^|\/)src\/tools(?:\/|$)/.test(normalized) ||
          [target, lexical].some((value) => value && (owned(value) || within(oldRoot, value)));
        if (!toolsImport) continue;
        if (reverseOwner(file)) {
          report(
            configFile,
            source,
            dependency,
            "reverse-dependency",
            "Core/logs/models must remain independent of tools.",
          );
          continue;
        }
        // This exception is physically scoped; a root test is still an ordinary consumer.
        if (
          within(testsRoot, file) &&
          target &&
          within(distRoot, target) &&
          specifier.startsWith(".")
        )
          continue;
        const grant = publicTargets.get(specifier);
        if (!grant)
          report(
            configFile,
            source,
            dependency,
            "consumer-bypass",
            "Consumers must use five exact tools entries, never source/dist/internal/legacy paths, references or aliases.",
          );
        else {
          if (
            ![grant.types, grant.js].includes(target) ||
            !ts.sys.fileExists(grant.types) ||
            !ts.sys.fileExists(grant.js)
          )
            report(
              configFile,
              source,
              dependency,
              "public-resolution",
              "Tools public imports must resolve to the actual manifest JS/declaration artifacts.",
            );
          if (
            browserFile(file) &&
            !pureEntries.has(specifier.slice("@agent-harness/tools/".length))
          )
            report(
              configFile,
              source,
              dependency,
              "browser-node",
              "Shared/renderer/preload may load only tools-contract and tools-errors.",
            );
        }
      }
    }
  }
  return diagnostics;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const diagnostics = checkToolsBoundaries();
  for (const item of diagnostics)
    console.error(`${item.source}:${item.line}:${item.column} [${item.rule}] ${item.message}`);
  if (diagnostics.length) process.exitCode = 1;
  else
    console.log(
      "Tools package boundaries passed (resolved source, JavaScript, declarations, app/cli, browser and physically scoped private tests).",
    );
}
