import { z } from "zod";

export const CREDENTIAL_STORE_FILE_NAME = "credentials.v2.json";
export const LEGACY_CREDENTIAL_STORE_FILE_NAME = "credentials.v1.json";

const credentialUrlSchema = z.string().trim().min(1).max(2_048).url();

export const credentialApiKeySchema = z.string().trim().min(1).max(16_384);

export type CredentialStorageBackend =
  | "basic_text"
  | "gnome_libsecret"
  | "kwallet"
  | "kwallet5"
  | "kwallet6"
  | "windows-dpapi-current-user"
  | "unknown";

export interface CredentialStorageStatus {
  state: "secure" | "degraded" | "unavailable";
  backend: CredentialStorageBackend;
  warning?: "linux-basic-text" | "safe-storage-unavailable" | "credential-protection-unavailable";
}

export interface CredentialStatusSnapshot {
  storage: CredentialStorageStatus;
  models: Array<{
    vendorId: string;
    configured: boolean;
  }>;
  webSearchConfigured: boolean;
}

/** OS adapters own encryption; configuration owns persistence and binding integrity. */
export interface CredentialProtection {
  readonly scheme: "electron-safe-storage" | "windows-dpapi-current-user";
  inspect(): Promise<CredentialStorageStatus>;
  encrypt(plainText: string): Promise<Uint8Array>;
  decrypt(encrypted: Uint8Array): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export function normalizeCredentialUrl(value: string): string {
  const validated = credentialUrlSchema.parse(value);
  const parsed = new URL(validated);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Credential-bound URLs must use http or https.");
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error("Credential-bound remote URLs must use HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Credential-bound URLs must not contain embedded credentials.");
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  const normalized = parsed.toString();
  return parsed.pathname === "/" && !parsed.search && !parsed.hash ? parsed.origin : normalized;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}
