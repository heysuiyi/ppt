import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
// A fresh emit prevents deleted modules from remaining in the next tarball.
rmSync(new URL("dist/", import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"], {
  cwd: root,
  stdio: "inherit",
});
