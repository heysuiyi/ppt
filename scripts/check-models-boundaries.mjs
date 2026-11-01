import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entries = ["models", "model-contract", "model-profiles", "model-errors"];
const pureEntries = entries.slice(1);
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

// Keep parents: NodeNext resolution consults the import's enclosing AST, including import types.
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
    else if (ts.isImportTypeNode(node))
      argument = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
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
  ])
    for (const reference of references)
      result.push({ node: { getStart: () => reference.pos }, kind, specifier: reference.fileName });
  return result;
}

/** Resolve package, emitted JavaScript/declarations, and both consumer projects without emitting. */
export function checkModelsBoundaries(rootDir = repositoryRoot) {
  const identity = (file) => {
    const absolute = path.normalize(ts.sys.realpath?.(path.resolve(file)) ?? path.resolve(file));
    return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
  };
  const root = identity(rootDir);
  const packageRoot = identity(path.join(root, "packages/models"));
  const sourceRoot = identity(path.join(packageRoot, "src"));
  const distRoot = identity(path.join(packageRoot, "dist"));
  const coreRoot = identity(path.join(root, "packages/harness"));
  const logsRoot = identity(path.join(root, "packages/logs"));
  const within = (directory, file) => {
    const relative = path.relative(directory, file);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  };
  const owned = (file) => within(sourceRoot, file) || within(distRoot, file);
  const reverseOwner = (file) => within(coreRoot, file) || within(logsRoot, file);
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
  function manifestAt(directory) {
    const file = path.join(directory, "package.json");
    const result = ts.readConfigFile(file, ts.sys.readFile);
    if (result.error) {
      report(
        file,
        undefined,
        undefined,
        "manifest",
        ts.flattenDiagnosticMessageText(result.error.messageText, "\n"),
      );
      return undefined;
    }
    return result.config;
  }
  const manifest = manifestAt(packageRoot);
  if (!manifest) return diagnostics;
  const manifestFile = path.join(packageRoot, "package.json");
  if (
    manifest.name !== "@agent-harness/models" ||
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
      "Expected private @agent-harness/models@0.1.0, ESM, Node >=24.",
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
      "Only four exact public subpath exports are allowed (no root, vendor, wildcard or alias).",
    );
  const publicTargets = new Map();
  for (const entry of entries) {
    const value = manifest.exports?.[`./${entry}`];
    if (
      !value ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["import", "types"]) ||
      value.import !== `./dist/${entry}.js` ||
      value.types !== `./dist/${entry}.d.ts`
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
    publicTargets.set(`@agent-harness/models/${entry}`, {
      js: identity(path.join(packageRoot, value.import)),
      types: identity(path.join(packageRoot, value.types)),
    });
  }
  const permittedPublic = new Map();
  for (const directory of [coreRoot, logsRoot]) {
    const dependencyManifest = manifestAt(directory);
    for (const kind of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "devDependencies",
    ])
      if (
        Object.keys(dependencyManifest?.[kind] ?? {}).some(
          (name) => name === "@agent-harness/models" || name.startsWith("@agent-harness/models/"),
        )
      )
        report(
          path.join(directory, "package.json"),
          undefined,
          undefined,
          "reverse-dependency",
          "Core/logs manifests must not depend on models.",
        );
    for (const [entry, conditions] of Object.entries(dependencyManifest?.exports ?? {}))
      if (entry.startsWith("./") && !entry.includes("*") && conditions.types && conditions.import)
        permittedPublic.set(`${dependencyManifest.name}/${entry.slice(2)}`, {
          types: identity(path.join(directory, conditions.types)),
          js: identity(path.join(directory, conditions.import)),
        });
  }
  const requiredDependencies = ["@agent-harness/core", "@agent-harness/logs", "openai"];
  if (
    JSON.stringify(Object.keys(manifest.dependencies ?? {}).sort()) !==
      JSON.stringify(requiredDependencies.sort()) ||
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
      "Models requires exactly same-version Core/logs and the real OpenAI SDK.",
    );

  function resolve(dependency, source, options, javascript = false) {
    if (dependency.kind === "lib") return undefined;
    if (dependency.kind === "path")
      return identity(path.resolve(path.dirname(source.fileName), dependency.specifier));
    if (dependency.kind === "types")
      return ts.resolveTypeReferenceDirective(
        dependency.specifier,
        source.fileName,
        options,
        ts.sys,
      ).resolvedTypeReferenceDirective?.resolvedFileName;
    // TS resolves .js to .d.ts when both exist; inspect actual emitted runtime edges as well.
    if (javascript && dependency.specifier.startsWith(".")) {
      const file = path.resolve(path.dirname(source.fileName), dependency.specifier);
      if (ts.sys.fileExists(file)) return file;
    }
    return ts.resolveModuleName(
      dependency.specifier,
      source.fileName,
      options,
      ts.sys,
      undefined,
      undefined,
      dependency.argument
        ? ts.getModeForUsageLocation(source, dependency.argument, options)
        : undefined,
    ).resolvedModule?.resolvedFileName;
  }
  const isSDK = (specifier) => specifier === "openai" || specifier.startsWith("openai/");
  const isStandardLibrary = (file) => {
    const relative = path.relative(path.dirname(ts.getDefaultLibFilePath({})), file);
    return !relative.includes(path.sep) && /^lib\..*\.d\.ts$/i.test(relative);
  };
  function isFactory(file) {
    if (!owned(file)) return false;
    const relative = path
      .relative(within(sourceRoot, file) ? sourceRoot : distRoot, file)
      .replaceAll("\\", "/");
    return (
      /^(?:models\.(?:ts|js|d\.ts)|internal\/create-provider\.)/.test(relative) ||
      (relative.startsWith("providers/") && !/\/profile\.(?:ts|js|d\.ts)$/.test(relative))
    );
  }
  for (const relative of [
    "packages/models/tsconfig.json",
    "packages/harness/tsconfig.json",
    "packages/logs/tsconfig.json",
    "tsconfig.node.json",
    "tsconfig.web.json",
  ]) {
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
    const options = { ...parsed.options, allowJs: true, checkJs: false, noEmit: true };
    const roots = [
      ...parsed.fileNames,
      ...ts.sys.readDirectory(sourceRoot, [".ts", ".mts"], undefined, ["**/*"]),
      ...ts.sys.readDirectory(distRoot, [".js", ".d.ts", ".mjs", ".d.mts"], undefined, ["**/*"]),
    ];
    const program = ts.createProgram(roots, options, ts.createCompilerHost(options, true));
    const sources = new Map(
      program.getSourceFiles().map((source) => [identity(source.fileName), source]),
    );
    const checker = program.getTypeChecker();
    function implicitPlatformReferences(source) {
      function visit(node) {
        if (ts.isIdentifier(node)) {
          let symbol = checker.getSymbolAtLocation(node);
          if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
          const declarations = symbol?.getDeclarations() ?? [];
          // DOM/ES declarations can legitimately merge with Node's AbortSignal/fetch globals.
          // Only symbols with no standard-library declaration are exclusively platform-bound.
          if (
            !declarations.some((declaration) =>
              isStandardLibrary(identity(declaration.getSourceFile().fileName)),
            ) &&
            declarations.some((declaration) =>
              /[/\\]node_modules[/\\](?:@types[/\\]node|openai)[/\\]/i.test(
                identity(declaration.getSourceFile().fileName),
              ),
            )
          )
            report(
              configFile,
              source,
              { node, specifier: node.text },
              "platform-leak",
              "Pure/public declaration symbols resolve to SDK or Node declarations.",
            );
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    function sourceFor(file) {
      let source = sources.get(file);
      if (!source) {
        const text = ts.sys.readFile(file);
        if (text !== undefined) {
          source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
          sources.set(file, source);
        }
      }
      return source;
    }
    function graph(file, visited, pure, declaration) {
      file = identity(file);
      if (visited.has(file) || isStandardLibrary(file)) return;
      visited.add(file);
      const source = sourceFor(file);
      if (!source) {
        report(configFile, undefined, undefined, "missing-output", `Missing graph entry ${file}`);
        return;
      }
      if (
        (pure || declaration) &&
        isFactory(file) &&
        !(declaration && file === identity(path.join(distRoot, "models.d.ts")))
      )
        report(
          configFile,
          source,
          undefined,
          "pure-closure",
          "Public pure/declaration closure reaches a provider, SDK conversion or creation implementation.",
        );
      if (pure || declaration) implicitPlatformReferences(source);
      for (const dependency of dependencies(source)) {
        if (dependency.dynamic) {
          report(
            configFile,
            source,
            dependency,
            "dynamic-import",
            "Package closure imports must have literal, statically resolvable targets.",
          );
          continue;
        }
        if (dependency.kind === "lib") {
          if (!ts.libMap.has(dependency.specifier.toLowerCase()))
            report(
              configFile,
              source,
              dependency,
              "reference",
              "Only standard library lib references are permitted.",
            );
          continue;
        }
        if (
          builtins.has(dependency.specifier) ||
          isSDK(dependency.specifier) ||
          (dependency.kind === "types" && dependency.specifier === "node")
        ) {
          if (pure || declaration)
            report(
              configFile,
              source,
              dependency,
              "platform-leak",
              "Pure entries and public declarations must not reference SDK or Node types/runtime.",
            );
          continue;
        }
        const targetValue = resolve(
          dependency,
          source,
          options,
          file.endsWith(".js") || file.endsWith(".mjs"),
        );
        const target = targetValue && identity(targetValue);
        const publicTarget = permittedPublic.get(dependency.specifier);
        const allowedReference =
          dependency.kind &&
          target &&
          (owned(target) ||
            isStandardLibrary(target) ||
            (!owned(file) && (within(coreRoot, target) || within(logsRoot, target))));
        const allowed =
          target &&
          (owned(target) ||
            allowedReference ||
            (publicTarget && (target === publicTarget.types || target === publicTarget.js)) ||
            (!owned(file) &&
              dependency.specifier.startsWith(".") &&
              ((within(coreRoot, file) && within(coreRoot, target)) ||
                (within(logsRoot, file) && within(logsRoot, target)))));
        if (!allowed)
          report(
            configFile,
            source,
            dependency,
            "package-escape",
            "Closure must stay in owned modules or exact Core/logs public entries; aliases and ambient escapes are forbidden.",
          );
        else graph(target, visited, pure, declaration);
      }
    }
    for (const entry of entries) {
      for (const extension of [".ts", ".js", ".d.ts"])
        graph(
          path.join(extension === ".ts" ? sourceRoot : distRoot, `${entry}${extension}`),
          new Set(),
          pureEntries.includes(entry),
          extension === ".d.ts",
        );
    }
    // Check every own module, including unreachable private modules and declaration files.
    for (const source of [...sources.values()]) {
      const file = identity(source.fileName);
      if (
        program.isSourceFileDefaultLibrary(source) ||
        (program.isSourceFileFromExternalLibrary(source) && !owned(file) && !reverseOwner(file))
      )
        continue;
      const browser =
        relative === "tsconfig.web.json" ||
        within(path.join(root, "src/shared"), file) ||
        within(path.join(root, "src/renderer"), file);
      for (const dependency of dependencies(source)) {
        if (dependency.dynamic) {
          if (owned(file))
            report(
              configFile,
              source,
              dependency,
              "dynamic-import",
              "Package imports require literal targets.",
            );
          continue;
        }
        const specifier = dependency.specifier;
        if (dependency.kind === "lib") continue;
        const resolved = resolve(dependency, source, options);
        const target = resolved && identity(resolved);
        if (owned(file)) {
          const grant = permittedPublic.get(specifier);
          if (
            builtins.has(specifier) ||
            isSDK(specifier) ||
            (dependency.kind === "types" && specifier === "node")
          )
            continue;
          if (
            !target ||
            (!owned(target) && !isStandardLibrary(target) && (!grant || target !== grant.types))
          )
            report(
              configFile,
              source,
              dependency,
              "package-escape",
              "Models imports are limited to owned modules, exact Core/logs public paths, OpenAI and Node.",
            );
          continue;
        }
        const lexicalTarget =
          specifier.startsWith(".") || path.isAbsolute(specifier)
            ? identity(path.resolve(path.dirname(file), specifier))
            : undefined;
        const modelImport =
          specifier === "@agent-harness/models" ||
          specifier.startsWith("@agent-harness/models/") ||
          /(?:^|\/)packages\/models\/(?:src|dist)(?:\/|$)/.test(specifier.replaceAll("\\", "/")) ||
          /(?:^|\/)src\/models(?:\/|$)/.test(specifier.replaceAll("\\", "/")) ||
          (target && (owned(target) || within(path.join(root, "src/models"), target))) ||
          (lexicalTarget &&
            (owned(lexicalTarget) || within(path.join(root, "src/models"), lexicalTarget)));
        if (!modelImport) continue;
        if (reverseOwner(file)) {
          report(
            configFile,
            source,
            dependency,
            "reverse-dependency",
            "Core and logs must remain independent of models.",
          );
          continue;
        }
        const publicTarget = publicTargets.get(specifier);
        if (!publicTarget)
          report(
            configFile,
            source,
            dependency,
            "consumer-bypass",
            "Consumers must use exact public models package imports, never old/source/dist/provider paths or aliases.",
          );
        else {
          if (
            target !== publicTarget.types ||
            !ts.sys.fileExists(publicTarget.js) ||
            !ts.sys.fileExists(publicTarget.types)
          )
            report(
              configFile,
              source,
              dependency,
              "public-resolution",
              "Public imports must resolve to actual manifest dist JavaScript and declarations.",
            );
          if (browser && specifier === "@agent-harness/models/models")
            report(
              configFile,
              source,
              dependency,
              "browser-factory",
              "Browser/shared consumers may import only profiles, contract and errors.",
            );
        }
      }
    }
  }
  return diagnostics;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const diagnostics = checkModelsBoundaries();
  for (const item of diagnostics)
    console.error(`${item.source}:${item.line}:${item.column} [${item.rule}] ${item.message}`);
  if (diagnostics.length) process.exitCode = 1;
  else
    console.log(
      "Models package boundaries passed (TypeScript-resolved source, runtime, declaration, node and web graphs).",
    );
}
