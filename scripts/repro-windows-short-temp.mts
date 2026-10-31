/**
 * Reproduces the Windows CI path-guard failure mode:
 * open a workspace via an 8.3 short path and call WorkspaceFileService.read.
 *
 * On GitHub Actions, TEMP is already short (`C:\Users\RUNNER~1\...`).
 * Locally we force a short path via Scripting.FileSystemObject when available.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function shortPath(longPath: string): string {
  const escaped = longPath.replace(/'/g, "''");
  const script = `$fso = New-Object -ComObject Scripting.FileSystemObject; Write-Output $fso.GetFolder('${escaped}').ShortPath`;
  return execFileSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
  }).trim();
}

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "ppt-short-repro-"));
  const longRoot = join(base, "VeryLongDirectoryNameForEightDotThreeCollision");
  mkdirSync(longRoot);
  writeFileSync(join(longRoot, "notes.txt"), "hello\n", "utf8");

  let workspaceRoot = longRoot;
  try {
    const shortened = shortPath(longRoot);
    if (shortened && shortened.toLowerCase() !== longRoot.toLowerCase()) {
      workspaceRoot = shortened;
    }
  } catch {
    // keep longRoot
  }

  const resolvedRoot = resolve(workspaceRoot);
  const canonicalRoot = realpathSync(resolvedRoot);
  const rootStats = lstatSync(resolvedRoot);

  fetch("http://127.0.0.1:7758/ingest/f715bfbd-c4b3-4d7c-91d3-b40633f1a70c", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "ef46d4",
    },
    body: JSON.stringify({
      sessionId: "ef46d4",
      runId: "repro-script",
      hypothesisId: "A",
      location: "scripts/repro-windows-short-temp.mts",
      message: "repro path forms before WorkspaceFileService",
      data: {
        envTemp: process.env.TEMP,
        osTmpdir: tmpdir(),
        longRoot,
        workspaceRoot,
        resolvedRoot,
        canonicalRoot,
        samePath: resolvedRoot.toLowerCase() === canonicalRoot.toLowerCase(),
        rootIsSymlink: rootStats.isSymbolicLink(),
        resolvedHasTilde: resolvedRoot.includes("~"),
        canonicalHasTilde: canonicalRoot.includes("~"),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});

  const moduleUrl = pathToFileURL(
    resolve("src/tools/internal/workspace-file-service.ts"),
  ).href;
  const { WorkspaceFileService } = await import(moduleUrl);
  const service = new WorkspaceFileService(workspaceRoot);
  try {
    const receipt = await service.read("notes.txt");
    fetch("http://127.0.0.1:7758/ingest/f715bfbd-c4b3-4d7c-91d3-b40633f1a70c", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "ef46d4",
      },
      body: JSON.stringify({
        sessionId: "ef46d4",
        runId: "repro-script",
        hypothesisId: "A",
        location: "scripts/repro-windows-short-temp.mts",
        message: "WorkspaceFileService.read succeeded",
        data: { path: receipt.path, version: receipt.version },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    console.log("READ_OK", receipt.path, receipt.version);
  } catch (error) {
    const err = error as { code?: string; message?: string; name?: string };
    fetch("http://127.0.0.1:7758/ingest/f715bfbd-c4b3-4d7c-91d3-b40633f1a70c", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "ef46d4",
      },
      body: JSON.stringify({
        sessionId: "ef46d4",
        runId: "repro-script",
        hypothesisId: "A",
        location: "scripts/repro-windows-short-temp.mts",
        message: "WorkspaceFileService.read failed",
        data: { name: err.name, code: err.code, message: err.message },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    console.error("READ_FAIL", err.code, err.message);
    process.exitCode = 1;
  }
}

await main();
