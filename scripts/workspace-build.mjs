import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packages = ["harness", "logs"];

export function buildPackages() {
  for (const name of packages) {
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL(`../packages/${name}/build.mjs`, import.meta.url))],
      {
        cwd: fileURLToPath(new URL(`../packages/${name}/`, import.meta.url)),
        stdio: "inherit",
      },
    );
  }
}

export function watchPackages() {
  return Promise.all(packages.map(watchPackage));
}

/** Start the application only after every package's successful emit; never alias to source. */
function watchPackage(name) {
  const configPath = fileURLToPath(new URL(`../packages/${name}/tsconfig.json`, import.meta.url));
  const ready = Promise.withResolvers();
  const formatHost = {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => ts.sys.newLine,
  };
  const report = (diagnostic) => {
    process.stderr.write(ts.formatDiagnostic(diagnostic, formatHost));
  };
  const host = ts.createWatchCompilerHost(
    configPath,
    {},
    ts.sys,
    ts.createEmitAndSemanticDiagnosticsBuilderProgram,
    report,
    (diagnostic) => process.stdout.write(ts.formatDiagnostic(diagnostic, formatHost)),
  );
  host.afterProgramCreate = (builder) => {
    const diagnostics = ts.getPreEmitDiagnostics(builder.getProgram());
    for (const diagnostic of diagnostics) report(diagnostic);
    if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error))
      return;
    const emitted = builder.emit();
    for (const diagnostic of emitted.diagnostics) report(diagnostic);
    if (emitted.emitSkipped) return;
    process.stdout.write(`[${name}] Package emit ready.\n`);
    queueMicrotask(() => ready.resolve(watcher));
  };
  const watcher = ts.createWatchProgram(host);
  // The watcher belongs to this launcher, not to the Agent or an application session.
  process.once("exit", () => watcher.close());
  return ready.promise;
}
