import { spawn } from "node:child_process";
import { join } from "node:path";
import type { CredentialProtection, CredentialStorageStatus } from "./credential-contract.js";

const PREFIX = Buffer.from("agent-harness:windows-dpapi-current-user:v1\0", "ascii");
const MAX_PIPE_BYTES = 131_072;
const PROCESS_TIMEOUT_MS = 20_000;
const SCRIPT_PREFIX = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
`;
// Only these fixed scripts enter argv. Payloads enter private pipes, never script interpolation.
const PROTECT_SCRIPT = `${SCRIPT_PREFIX}
  $outputBytes = [Security.Cryptography.ProtectedData]::Protect($inputBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($outputBytes))
} catch { exit 1 }
`;
const UNPROTECT_SCRIPT = `${SCRIPT_PREFIX}
  $outputBytes = [Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($outputBytes))
} catch { exit 1 }
`;

export class NodeCredentialProtectionError extends Error {
  constructor(readonly code: "UNAVAILABLE" | "PROTECTION_FAILED" | "UNSUPPORTED_CIPHERTEXT") {
    super(
      code === "UNSUPPORTED_CIPHERTEXT"
        ? "The credential ciphertext uses an unsupported protection scheme or version."
        : code === "UNAVAILABLE"
          ? "Windows CurrentUser DPAPI credential protection is unavailable."
          : "Windows CurrentUser DPAPI credential protection failed.",
    );
    this.name = "NodeCredentialProtectionError";
  }
}

/** Windows-only, scoped to the current OS account. No Electron ciphertext or plaintext fallback. */
export function createNodeCredentialProtection(
  options: { signal?: AbortSignal } = {},
): CredentialProtection {
  const requirePlatform = () => {
    if (process.platform !== "win32" || options.signal?.aborted)
      throw new NodeCredentialProtectionError("UNAVAILABLE");
  };
  const protect = async (plainText: string): Promise<Buffer> => {
    requirePlatform();
    const input = Buffer.from(plainText, "utf8");
    try {
      return Buffer.concat([PREFIX, await runProtectedData(PROTECT_SCRIPT, input, options.signal)]);
    } finally {
      input.fill(0);
    }
  };
  const unprotect = async (encrypted: Uint8Array) => {
    requirePlatform();
    const bytes = Buffer.from(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);
    if (bytes.length <= PREFIX.length || !bytes.subarray(0, PREFIX.length).equals(PREFIX))
      throw new NodeCredentialProtectionError("UNSUPPORTED_CIPHERTEXT");
    const plaintext = await runProtectedData(
      UNPROTECT_SCRIPT,
      bytes.subarray(PREFIX.length),
      options.signal,
    );
    try {
      return { result: plaintext.toString("utf8"), shouldReEncrypt: false };
    } finally {
      plaintext.fill(0);
    }
  };
  return {
    scheme: "windows-dpapi-current-user",
    async inspect(): Promise<CredentialStorageStatus> {
      try {
        const probe = "agent-harness-dpapi-availability-probe-v1";
        if ((await unprotect(await protect(probe))).result !== probe)
          throw new NodeCredentialProtectionError("UNAVAILABLE");
        return { state: "secure", backend: "windows-dpapi-current-user" };
      } catch {
        return {
          state: "unavailable",
          backend: "windows-dpapi-current-user",
          warning: "credential-protection-unavailable",
        };
      }
    },
    encrypt: protect,
    decrypt: unprotect,
  };
}

async function runProtectedData(
  script: string,
  input: Buffer,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (input.length === 0 || input.length > 65_536)
    throw new NodeCredentialProtectionError("PROTECTION_FAILED");
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  try {
    const child = spawn(
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        // Do not pass API keys or any other inherited process environment into PowerShell.
        env: { SystemRoot: systemRoot },
        ...(signal ? { signal } : {}),
      },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const fail = () => {
      failed = true;
      child.kill();
    };
    const timeout = setTimeout(fail, PROCESS_TIMEOUT_MS);
    child.on("error", () => {
      failed = true;
    });
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    // Never retain or report subprocess diagnostics, which may include decrypted data.
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PIPE_BYTES) {
        chunk.fill(0);
        fail();
      } else {
        chunks.push(chunk);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      const output = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      try {
        if (failed || code !== 0 || output.length === 0)
          throw new NodeCredentialProtectionError("PROTECTION_FAILED");
        const encoded = output.toString("ascii");
        if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(encoded))
          throw new NodeCredentialProtectionError("PROTECTION_FAILED");
        resolve(Buffer.from(encoded, "base64"));
      } catch {
        reject(new NodeCredentialProtectionError("PROTECTION_FAILED"));
      } finally {
        output.fill(0);
      }
    });
    child.stdin.end(input.toString("base64"));
    return await promise;
  } catch {
    throw new NodeCredentialProtectionError("PROTECTION_FAILED");
  }
}
