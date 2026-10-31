import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Keep the supported paths and white-box grants here, not in a second glob-based rule.
const publicEntries = [
  "application/agent-application.ts",
  "agent-contract.ts",
  "agent-factory.ts",
  "protocol-values.ts",
  "protocol-errors.ts",
  "extensions/plugin-contract.ts",
  "model/model-contract.ts",
  "tools/tool-contract.ts",
  "session/session-contract.ts",
  "session/checkpoint-contract.ts",
  "session/session-events.ts",
];
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
  visit(source);
  return result;
}

/** Check both compiler projects without emitting or typechecking them. */
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
  const agentRoot = identity(path.join(root, "src/agent"));
  function within(directory, file) {
    const relative = path.relative(directory, file);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  }
  const isAgent = (file) => within(agentRoot, file);
  const entry = (file) => identity(path.join(agentRoot, file));
  const publicPaths = new Set(publicEntries.map(entry));
  const application = entry("application/agent-application.ts");
  const values = entry("protocol-values.ts");
  const errors = entry("protocol-errors.ts");
  const purePaths = new Set(
    [...publicPaths].filter((file) => file !== application && file !== values && file !== errors),
  );
  const grants = new Map(
    [...whiteBoxEntries].map(([source, targets]) => [
      identity(path.join(root, source)),
      new Set(targets.map(entry)),
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

  for (const configName of ["tsconfig.node.json", "tsconfig.web.json"]) {
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
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
      projectReferences: parsed.projectReferences,
    });
    const checker = program.getTypeChecker();
    const cache = ts.createModuleResolutionCache(root, identity, parsed.options);

    for (const source of program.getSourceFiles()) {
      const sourcePath = identity(source.fileName);
      if (!within(root, sourcePath) || program.isSourceFileFromExternalLibrary(source)) continue;
      const internal = isAgent(sourcePath);
      const pure = purePaths.has(sourcePath);
      const controlled = sourcePath === values || sourcePath === errors;

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
          if (internal) {
            report(
              configPath,
              source,
              node,
              "<non-literal module>",
              "literal-loading",
              "Agent module loading must use a resolvable string literal.",
            );
          }
          continue;
        }
        const mode = program.getModeForUsageLocation(source, dependency.argument);
        const resolution = ts.resolveModuleName(
          specifier,
          source.fileName,
          parsed.options,
          ts.sys,
          cache,
          undefined,
          mode,
        );
        const resolved = resolution.resolvedModule;
        if (!resolved) {
          // Failed lookup paths include relative and paths/baseUrl candidates, so
          // missing Agent files and unresolved Agent aliases cannot be skipped.
          const agentLookup = (resolution.failedLookupLocations ?? []).some((file) =>
            isAgent(identity(file)),
          );
          if (internal || agentLookup) {
            report(
              configPath,
              source,
              node,
              `<unresolved: ${specifier}>`,
              "resolved-agent-dependency",
              "Agent dependencies and public protocol closures must resolve in this compiler project.",
            );
          }
          continue;
        }
        const target = identity(resolved.resolvedFileName);
        const targetInternal = isAgent(target);
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
          if (pure && (!typeOnly || (!publicPaths.has(target) && !zod) || target === application)) {
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
            const allowed =
              sourcePath === values ? target === errors : target === values && typeOnly;
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
        } else if (targetInternal && !publicPaths.has(target)) {
          if (!grants.get(sourcePath)?.has(target) || reexport) {
            report(
              configPath,
              source,
              node,
              target,
              "private-entry",
              "External code must use an exact public entry; white-box grants allow consumption, not re-export.",
            );
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
          function localDeclaration(declaration) {
            const file = declaration.getSourceFile();
            return (
              within(root, identity(file.fileName)) &&
              !program.isSourceFileFromExternalLibrary(file)
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
            if (type.flags & ts.TypeFlags.TypeParameter) collectTypeOrigins(type.getConstraint());
            if (type.flags & ts.TypeFlags.Object && type.objectFlags & ts.ObjectFlags.Reference) {
              for (const argument of checker.getTypeArguments(type)) collectTypeOrigins(argument);
            }
            const repeated =
              symbols.length > 0 && symbols.every((item) => visitedSymbols.has(item));
            for (const item of symbols) visitedSymbols.add(item);
            if (repeated || (declarations.length && !declarations.some(localDeclaration))) return;
            for (const part of type.types ?? []) collectTypeOrigins(part);
            if (
              typeOrigins.some(
                (origin) => isAgent(origin) && !publicPaths.has(origin) && origin !== sourcePath,
              )
            )
              return;
            if (!(type.flags & ts.TypeFlags.Object)) return;
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
  else console.log("Agent boundaries passed (node + web compiler projects).");
}
