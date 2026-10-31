import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Public entries come only from the package manifest; these grants are private,
// exact-file exceptions and never package exports.
const infrastructureTargets = [
  "extensions/plugin-manager.ts",
  "extensions/prompt-registry.ts",
  "model/model-registry.ts",
  "scope/resource-scope.ts",
  "tools/tool-pipeline.ts",
  "tools/tool-registry.ts",
  "tools/tool-executor.ts",
];
const whiteBoxEntries = new Map([
  ["tests/general-agent-infrastructure.test.ts", infrastructureTargets],
  ["tests/general-agent-lifecycle.test.ts", ["runtime/event-stream.ts"]],
  ["tests/base-tools.test.ts", infrastructureTargets],
]);

function importIsTypeOnly(node) {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return (
    !clause.name &&
    bindings &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function exportIsTypeOnly(node) {
  return (
    node.isTypeOnly ||
    (node.exportClause &&
      ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.length > 0 &&
      node.exportClause.elements.every((element) => element.isTypeOnly))
  );
}

function dependencies(source) {
  const result = [];
  function add(node, argument, typeOnly, reexport = false) {
    result.push({
      node,
      argument,
      specifier: argument && ts.isStringLiteralLike(argument) ? argument.text : undefined,
      typeOnly: Boolean(typeOnly),
      reexport,
    });
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier, node.moduleSpecifier, importIsTypeOnly(node));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node.moduleSpecifier, node.moduleSpecifier, exportIsTypeOnly(node), true);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference, node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isImportTypeNode(node)) {
      const argument = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      add(node, argument, true);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      add(node, node.arguments[0], false);
    }
    ts.forEachChild(node, visit);
  }
  for (const [kind, references] of [
    ["types", source.typeReferenceDirectives],
    ["path", source.referencedFiles],
    ["lib", source.libReferenceDirectives],
  ]) {
    for (const reference of references) {
      result.push({
        node: { getStart: () => reference.pos },
        reference,
        kind,
        specifier: reference.fileName,
        typeOnly: true,
        reexport: false,
      });
    }
  }
  visit(source);
  return result;
}

/** Check the package and both consumer projects without emitting or typechecking. */
export function checkAgentBoundaries(rootDir = repositoryRoot) {
  // realpath prevents symlink spellings from changing module identity; TypeScript's
  // platform case policy also applies to configs, exact grants and containment.
  function identity(file) {
    let absolute = path.resolve(file);
    if (ts.sys.realpath) absolute = ts.sys.realpath(absolute);
    absolute = path.normalize(absolute);
    return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
  }
  const root = identity(rootDir);
  const packageRoot = identity(path.join(root, "packages/harness"));
  const sourceRoot = identity(path.join(packageRoot, "src"));
  const distRoot = identity(path.join(packageRoot, "dist"));
  const agentRoot = identity(path.join(sourceRoot, "agent"));
  const hostRoot = identity(path.join(sourceRoot, "agent-host"));
  const agentDistRoot = identity(path.join(distRoot, "agent"));
  const hostDistRoot = identity(path.join(distRoot, "agent-host"));
  const legacyAgentRoot = identity(path.join(root, "src/agent"));
  const legacyHostRoot = identity(path.join(root, "src/agent-host"));
  function within(directory, file) {
    const relative = path.relative(directory, file);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  }
  const isAgent = (file) => within(agentRoot, file) || within(agentDistRoot, file);
  const isHost = (file) => within(hostRoot, file) || within(hostDistRoot, file);
  const isLegacy = (file) => within(legacyAgentRoot, file) || within(legacyHostRoot, file);
  const isPackage = (file) => within(sourceRoot, file) || within(distRoot, file);
  const entry = (file) => identity(path.join(agentRoot, file));
  const variants = (file) => {
    const relative = path.relative(sourceRoot, file).replace(/\.ts$/, "");
    return [
      file,
      identity(path.join(distRoot, `${relative}.js`)),
      identity(path.join(distRoot, `${relative}.d.ts`)),
    ];
  };
  const applications = new Set(variants(entry("application/agent-application.ts")));
  const values = new Set(variants(entry("protocol-values.ts")));
  const errors = new Set(variants(entry("protocol-errors.ts")));
  const hostEntries = new Set(variants(identity(path.join(hostRoot, "session-host.ts"))));
  const publicPaths = new Set();
  const publicSpecifiers = new Map();
  const grants = new Map(
    [...whiteBoxEntries].map(([source, targets]) => [
      identity(path.join(root, source)),
      new Set(
        targets.flatMap((file) =>
          variants(entry(file)).filter((target) => within(distRoot, target)),
        ),
      ),
    ]),
  );
  const diagnostics = [];
  const seen = new Set();
  function report(project, source, node, target, rule, message) {
    const position =
      source && node ? source.getLineAndCharacterOfPosition(node.getStart(source)) : undefined;
    const diagnostic = {
      project,
      source: source ? identity(source.fileName) : project,
      line: position ? position.line + 1 : 1,
      column: position ? position.character + 1 : 1,
      target,
      rule,
      message,
    };
    const key = JSON.stringify([
      diagnostic.source,
      diagnostic.line,
      diagnostic.column,
      target,
      rule,
    ]);
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(diagnostic);
    }
  }

  const manifestPath = path.join(packageRoot, "package.json");
  const manifestResult = ts.readConfigFile(manifestPath, ts.sys.readFile);
  if (manifestResult.error) {
    report(
      manifestPath,
      undefined,
      undefined,
      manifestPath,
      "package-exports",
      ts.flattenDiagnosticMessageText(manifestResult.error.messageText, "\n"),
    );
    return diagnostics;
  }
  const manifest = manifestResult.config;
  if (
    manifest.name !== "@agent-ppt/harness" ||
    !manifest.exports ||
    typeof manifest.exports !== "object" ||
    Array.isArray(manifest.exports)
  ) {
    report(
      manifestPath,
      undefined,
      undefined,
      manifestPath,
      "package-exports",
      "The harness manifest must declare its package name and exact subpath exports.",
    );
    return diagnostics;
  }
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    const types = conditions?.types;
    const imported = conditions?.import;
    const validShape =
      subpath.startsWith("./") &&
      subpath.length > 2 &&
      !subpath.includes("*") &&
      typeof types === "string" &&
      typeof imported === "string" &&
      types.startsWith("./dist/") &&
      imported.startsWith("./dist/") &&
      types.endsWith(".d.ts") &&
      imported.endsWith(".js") &&
      types.slice(0, -5) === imported.slice(0, -3);
    const declaration = validShape ? identity(path.join(packageRoot, types)) : undefined;
    const javascript = validShape ? identity(path.join(packageRoot, imported)) : undefined;
    const source = validShape
      ? identity(path.join(sourceRoot, `${path.relative(distRoot, javascript).slice(0, -3)}.ts`))
      : undefined;
    if (
      !validShape ||
      !within(distRoot, declaration) ||
      !within(distRoot, javascript) ||
      (!within(agentRoot, source) && !hostEntries.has(source))
    ) {
      report(
        manifestPath,
        undefined,
        undefined,
        subpath,
        "package-exports",
        "Each exact export must map matching dist JS and declarations to one harness source module.",
      );
      continue;
    }
    publicSpecifiers.set(
      `${manifest.name}/${subpath.slice(2)}`,
      new Set([javascript, declaration]),
    );
    if (within(agentRoot, source)) {
      for (const file of [source, javascript, declaration]) publicPaths.add(file);
    }
  }
  const purePaths = new Set(
    [...publicPaths].filter(
      (file) => !applications.has(file) && !values.has(file) && !errors.has(file),
    ),
  );

  for (const configName of [
    "tsconfig.node.json",
    "tsconfig.web.json",
    "packages/harness/tsconfig.json",
  ]) {
    const configPath = path.join(root, configName);
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) {
      report(
        configPath,
        undefined,
        undefined,
        configPath,
        "config",
        ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
      );
      continue;
    }
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      path.dirname(configPath),
      undefined,
      configPath,
    );
    if (parsed.errors.length) {
      for (const error of parsed.errors) {
        report(
          configPath,
          undefined,
          undefined,
          configPath,
          "config",
          ts.flattenDiagnosticMessageText(error.messageText, "\n"),
        );
      }
      continue;
    }
    if (
      configName === "packages/harness/tsconfig.json" &&
      (!Array.isArray(parsed.options.types) || parsed.options.types.length !== 0)
    ) {
      report(
        configPath,
        undefined,
        undefined,
        configPath,
        "ambient-node",
        "The standalone harness project must explicitly disable ambient type packages with types: [].",
      );
    }
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
      projectReferences: parsed.projectReferences,
    });
    const checker = program.getTypeChecker();
    const cache = ts.createModuleResolutionCache(root, identity, parsed.options);
    const standardLibraryRoot = identity(path.dirname(ts.getDefaultLibFilePath(parsed.options)));

    function resolveDependency(source, dependency) {
      const { kind, specifier, reference } = dependency;
      if (kind === "types") {
        const resolution = ts.resolveTypeReferenceDirective(
          specifier,
          source.fileName,
          parsed.options,
          ts.sys,
          undefined,
          undefined,
          reference.resolutionMode ?? source.impliedNodeFormat,
        );
        return {
          ...resolution,
          resolvedModule: resolution.resolvedTypeReferenceDirective,
        };
      }
      if (kind === "path") {
        const fileName = ts.resolveTripleslashReference(specifier, source.fileName);
        return {
          resolvedModule: ts.sys.fileExists(fileName) ? { resolvedFileName: fileName } : undefined,
          failedLookupLocations: [fileName],
        };
      }
      if (kind === "lib") {
        // Use the compiler's actual lib resolution, including @typescript/lib-*
        // replacements, rather than assuming a lib name denotes a built-in file.
        const library = program.getLibFileFromReference(reference);
        return {
          resolvedModule: library ? { resolvedFileName: library.fileName } : undefined,
          standardLibrary:
            library &&
            within(standardLibraryRoot, identity(library.fileName)) &&
            program.isSourceFileDefaultLibrary(library),
        };
      }
      return ts.resolveModuleName(
        specifier,
        source.fileName,
        parsed.options,
        ts.sys,
        cache,
        undefined,
        program.getModeForUsageLocation(source, dependency.argument),
      );
    }

    for (const source of program.getSourceFiles()) {
      const sourcePath = identity(source.fileName);
      if (
        !within(root, sourcePath) ||
        (program.isSourceFileFromExternalLibrary(source) && !isPackage(sourcePath))
      )
        continue;
      const internal = isAgent(sourcePath);
      const host = isHost(sourcePath);
      const pure = purePaths.has(sourcePath);
      const controlled = values.has(sourcePath) || errors.has(sourcePath);

      if (pure) {
        for (const statement of source.statements) {
          const typeStatement =
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement) ||
            (ts.isImportDeclaration(statement) && importIsTypeOnly(statement)) ||
            (ts.isImportEqualsDeclaration(statement) && statement.isTypeOnly) ||
            (ts.isExportDeclaration(statement) &&
              (exportIsTypeOnly(statement) ||
                (!statement.moduleSpecifier &&
                  statement.exportClause &&
                  ts.isNamedExports(statement.exportClause) &&
                  statement.exportClause.elements.length === 0)));
          if (!typeStatement) {
            report(
              configPath,
              source,
              statement,
              sourcePath,
              "pure-protocol",
              "Public type protocols may contain only type declarations and type-only imports/exports.",
            );
          }
        }
      }

      for (const dependency of dependencies(source)) {
        const { node, specifier, typeOnly, reexport } = dependency;
        if (specifier === undefined) {
          if (internal || host) {
            report(
              configPath,
              source,
              node,
              "<non-literal module>",
              "literal-loading",
              "Agent and session-host module loading must use a resolvable string literal.",
            );
          }
          continue;
        }
        const resolution = resolveDependency(source, dependency);
        const resolved = resolution.resolvedModule;
        if (!resolved) {
          // Failed lookup paths include relative and paths/baseUrl candidates, so
          // missing Agent files and unresolved Agent aliases cannot be skipped.
          const boundaryLookup = (resolution.failedLookupLocations ?? []).some((file) => {
            const candidate = identity(file);
            return isAgent(candidate) || isHost(candidate) || isLegacy(candidate);
          });
          if (
            internal ||
            host ||
            boundaryLookup ||
            specifier === manifest.name ||
            specifier.startsWith(`${manifest.name}/`)
          ) {
            report(
              configPath,
              source,
              node,
              `<unresolved: ${specifier}>`,
              "resolved-agent-dependency",
              "Agent and session-host dependencies must resolve in this compiler project.",
            );
          }
          continue;
        }
        const target = identity(resolved.resolvedFileName);
        const targetInternal = isAgent(target);
        const targetHost = isHost(target);
        if (isLegacy(target)) {
          report(
            configPath,
            source,
            node,
            target,
            "legacy-agent-path",
            "The retired src/agent and src/agent-host paths are not valid package entry points.",
          );
        }
        if (resolution.standardLibrary) continue;
        if (
          (internal || host) &&
          (targetInternal || targetHost) &&
          within(sourceRoot, sourcePath) !== within(sourceRoot, target)
        ) {
          report(
            configPath,
            source,
            node,
            target,
            "package-tree",
            "Harness dependencies must stay in the source tree or the matching dist tree, not mix both.",
          );
        }
        if (host && !targetHost && !(targetInternal && publicPaths.has(target))) {
          report(
            configPath,
            source,
            node,
            target,
            "session-host-dependency",
            "Session host may depend only on its own modules and exact public Agent entries.",
          );
        }
        if (!internal && !host && (targetInternal || targetHost)) {
          const publicTarget = publicSpecifiers.get(specifier)?.has(target);
          const whiteBoxTarget =
            !dependency.kind &&
            (specifier.startsWith("./") || specifier.startsWith("../")) &&
            (specifier.endsWith(".js") || specifier.endsWith(".d.ts")) &&
            grants.get(sourcePath)?.has(target) &&
            !reexport;
          if (!publicTarget && !whiteBoxTarget) {
            report(
              configPath,
              source,
              node,
              target,
              "package-entry",
              "Consumers must use an exact package export resolving to its dist product; only exact white-box dist targets are exempt.",
            );
          }
        }
        const zod = specifier === "zod" && resolved.packageId?.name === "zod";
        if (internal) {
          if (!targetInternal && !zod) {
            report(
              configPath,
              source,
              node,
              target,
              "kernel-dependency",
              "Agent may depend only on its own modules and zod.",
            );
          }
          if (
            pure &&
            (!typeOnly || (!publicPaths.has(target) && !zod) || applications.has(target))
          ) {
            report(
              configPath,
              source,
              node,
              target,
              "public-type-closure",
              "Public type protocols may only type-import public protocols or zod types.",
            );
          }
          if (controlled) {
            const allowed = values.has(sourcePath)
              ? errors.has(target)
              : values.has(target) && typeOnly;
            if (!allowed) {
              report(
                configPath,
                source,
                node,
                target,
                "protocol-runtime-closure",
                "protocol-values may depend only on protocol-errors; protocol-errors may only type-import protocol-values.",
              );
            }
          }
        }
        if (publicPaths.has(sourcePath) && reexport && targetInternal && !publicPaths.has(target)) {
          report(
            configPath,
            source,
            node,
            target,
            "private-reexport",
            "Public entries must not re-export private Agent modules.",
          );
        }
      }

      // An allowed white-box import must not become `export { ImportedPrivate }`
      // (including aliased / namespace / type exports). Resolve exported symbols,
      // rather than merely looking for `export ... from` spelling.
      if (grants.has(sourcePath) || publicPaths.has(sourcePath)) {
        const moduleSymbol = checker.getSymbolAtLocation(source);
        for (const exported of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
          const symbol =
            exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
          const origins = new Set(
            symbol.declarations?.map((declaration) =>
              identity(declaration.getSourceFile().fileName),
            ),
          );
          // Inspect exported signatures as well as aliases: a white-box wrapper
          // returning a private class or an object containing it is still a leak.
          const visitedTypes = new Set();
          const visitedSymbols = new Set();
          const visitedDeclarations = new Set();
          const visitedTypeNodes = new Set();
          function localDeclaration(declaration) {
            const file = declaration.getSourceFile();
            return (
              within(root, identity(file.fileName)) &&
              (!program.isSourceFileFromExternalLibrary(file) || isPackage(identity(file.fileName)))
            );
          }
          function firstLocalDeclaration(declaration) {
            if (
              !declaration ||
              !localDeclaration(declaration) ||
              visitedDeclarations.has(declaration)
            )
              return false;
            visitedDeclarations.add(declaration);
            return true;
          }
          function collectTypeNodeOrigins(node) {
            if (!node || visitedTypeNodes.has(node) || !localDeclaration(node)) return;
            visitedTypeNodes.add(node);
            if (ts.isTypeNode(node)) collectTypeOrigins(checker.getTypeFromTypeNode(node));
            ts.forEachChild(node, collectTypeNodeOrigins);
          }
          function collectTypeOrigins(type) {
            if (!type || visitedTypes.has(type)) return;
            visitedTypes.add(type);
            const symbols = [...new Set([type.aliasSymbol, type.getSymbol()].filter(Boolean))];
            const declarations = symbols.flatMap((item) => item.declarations ?? []);
            const typeOrigins = declarations.map((item) => identity(item.getSourceFile().fileName));
            for (const origin of typeOrigins) origins.add(origin);
            // Type instances can grow indefinitely (for example nested Zod
            // generics). Walk each declaration/symbol once, not its instantiations.
            // Type arguments remain relevant even when the generic is external
            // or an earlier instantiation was already visited.
            for (const argument of type.aliasTypeArguments ?? []) collectTypeOrigins(argument);
            if (type.flags & ts.TypeFlags.TypeParameter) {
              collectTypeOrigins(type.getConstraint());
              collectTypeOrigins(type.getDefault());
            }
            if (type.flags & ts.TypeFlags.Object && type.objectFlags & ts.ObjectFlags.Reference) {
              for (const argument of checker.getTypeArguments(type)) collectTypeOrigins(argument);
            }
            const repeated =
              symbols.length > 0 && symbols.every((item) => visitedSymbols.has(item));
            for (const item of symbols) visitedSymbols.add(item);
            if (repeated || (declarations.length && !declarations.some(localDeclaration))) return;
            for (const declaration of declarations) {
              if (ts.isTypeAliasDeclaration(declaration)) collectTypeNodeOrigins(declaration.type);
              if (ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) {
                for (const clause of declaration.heritageClauses ?? []) {
                  for (const base of clause.types) collectTypeNodeOrigins(base);
                }
              }
            }
            for (const part of type.types ?? []) collectTypeOrigins(part);
            // Uninstantiated conditional types do not expose either branch through
            // properties/signatures. Resolve their syntax once, including nested
            // conditional, mapped and indexed-access type operands.
            if (type.flags & ts.TypeFlags.Conditional && localDeclaration(type.root.node)) {
              collectTypeOrigins(type.checkType);
              collectTypeOrigins(type.extendsType);
              collectTypeNodeOrigins(type.root.node);
            }
            if (type.flags & ts.TypeFlags.IndexedAccess) {
              collectTypeOrigins(type.objectType);
              collectTypeOrigins(type.indexType);
            }
            if (type.flags & ts.TypeFlags.Index) collectTypeOrigins(type.type);
            if (type.flags & ts.TypeFlags.Substitution) {
              collectTypeOrigins(type.baseType);
              collectTypeOrigins(type.constraint);
            }
            if (
              typeOrigins.some(
                (origin) => isAgent(origin) && !publicPaths.has(origin) && origin !== sourcePath,
              )
            )
              return;
            if (!(type.flags & ts.TypeFlags.Object)) return;
            if (type.objectFlags & ts.ObjectFlags.Mapped) collectTypeNodeOrigins(type.declaration);
            // A subclass may inherit no observable members at all, but its base
            // declaration is still part of the exported type's origin.
            if (type.objectFlags & ts.ObjectFlags.ClassOrInterface) {
              for (const base of checker.getBaseTypes(type) ?? []) collectTypeOrigins(base);
            }
            for (const info of checker.getIndexInfosOfType(type)) {
              if (firstLocalDeclaration(info.declaration)) collectTypeOrigins(info.type);
            }
            for (const property of type.getProperties()) {
              const location = property.valueDeclaration ?? property.declarations?.[0];
              if (firstLocalDeclaration(location))
                collectTypeOrigins(checker.getTypeOfSymbolAtLocation(property, location));
            }
            for (const signature of [
              ...type.getCallSignatures(),
              ...type.getConstructSignatures(),
            ]) {
              if (!firstLocalDeclaration(signature.declaration)) continue;
              collectTypeOrigins(signature.getReturnType());
              for (const parameter of signature.getParameters()) {
                const location = parameter.valueDeclaration ?? parameter.declarations?.[0];
                if (firstLocalDeclaration(location))
                  collectTypeOrigins(checker.getTypeOfSymbolAtLocation(parameter, location));
              }
              for (const parameter of signature.typeParameters ?? []) collectTypeOrigins(parameter);
            }
          }
          const declaration = exported.valueDeclaration ?? exported.declarations?.[0];
          if (declaration) {
            collectTypeOrigins(checker.getTypeOfSymbolAtLocation(symbol, declaration));
            if (
              symbol.flags &
              (ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface | ts.SymbolFlags.Class)
            ) {
              collectTypeOrigins(checker.getDeclaredTypeOfSymbol(symbol));
            }
          }
          for (const origin of origins) {
            if (isAgent(origin) && !publicPaths.has(origin) && origin !== sourcePath) {
              report(
                configPath,
                source,
                exported.declarations?.[0] ?? source,
                origin,
                "private-reexport",
                "White-box grants and public entries must not expose private Agent symbols.",
              );
            }
          }
        }
      }
    }
  }
  return diagnostics;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const diagnostics = checkAgentBoundaries();
  for (const diagnostic of diagnostics) {
    console.error(
      `${diagnostic.source}:${diagnostic.line}:${diagnostic.column} [${diagnostic.rule}] -> ${diagnostic.target}: ${diagnostic.message} (${path.basename(diagnostic.project)})`,
    );
  }
  if (diagnostics.length) process.exitCode = 1;
  else console.log("Agent boundaries passed (harness + node + web compiler projects).");
}
