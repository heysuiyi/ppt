import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageRoot = fileURLToPath(new URL("../packages/harness/", import.meta.url));
const configPath = fileURLToPath(new URL("../packages/harness/tsconfig.json", import.meta.url));

export function buildHarness() {
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../packages/harness/build.mjs", import.meta.url))],
    {
      cwd: packageRoot,
      stdio: "inherit",
    },
  );
}

/** Start the application only after the first successful emit; never alias back to source. */
export function watchHarness() {
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
    process.stdout.write("[harness] Package emit ready.\n");
    queueMicrotask(() => ready.resolve(watcher));
  };
  const watcher = ts.createWatchProgram(host);
  // The watcher belongs to this launcher, not to the Agent or an application session.
  process.once("exit", () => watcher.close());
  return ready.promise;
}
