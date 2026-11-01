import type {
  CredentialProtection,
  CredentialStorageBackend,
  CredentialStorageStatus,
} from "@agent-harness/configuration/credential-contract";

export interface SafeStorageAdapter {
  decryptString(encrypted: Buffer): string;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  encryptString(plainText: string): Buffer;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  getSelectedStorageBackend(): CredentialStorageBackend;
  isAsyncEncryptionAvailable(): Promise<boolean>;
  isEncryptionAvailable(): boolean;
}

/** Keep Electron's async preference, sync fallback, backend warning and re-encryption semantics. */
export function createSafeStorageCredentialProtection(
  safeStorage: SafeStorageAdapter,
): CredentialProtection {
  async function inspect(): Promise<{ status: CredentialStorageStatus; mode?: "async" | "sync" }> {
    let backend: CredentialStorageBackend = "unknown";
    try {
      backend = safeStorage.getSelectedStorageBackend();
    } catch {
      /* informational */
    }
    let asyncAvailable = false;
    try {
      asyncAvailable = await safeStorage.isAsyncEncryptionAvailable();
    } catch {
      /* try sync */
    }
    let syncAvailable = false;
    if (!asyncAvailable) {
      try {
        syncAvailable = safeStorage.isEncryptionAvailable();
      } catch {
        /* unavailable */
      }
    }
    const mode = asyncAvailable ? "async" : syncAvailable ? "sync" : undefined;
    if (!mode)
      return { status: { state: "unavailable", backend, warning: "safe-storage-unavailable" } };
    return {
      mode,
      status:
        backend === "basic_text"
          ? { state: "degraded", backend, warning: "linux-basic-text" }
          : { state: "secure", backend },
    };
  }
  async function requireMode() {
    const { mode } = await inspect();
    if (!mode) throw new Error("Operating-system credential encryption is unavailable.");
    return mode;
  }
  return {
    scheme: "electron-safe-storage",
    async inspect() {
      return (await inspect()).status;
    },
    async encrypt(plainText) {
      return (await requireMode()) === "async"
        ? safeStorage.encryptStringAsync(plainText)
        : safeStorage.encryptString(plainText);
    },
    async decrypt(encrypted) {
      const bytes = Buffer.from(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);
      return (await requireMode()) === "async"
        ? safeStorage.decryptStringAsync(bytes)
        : { result: safeStorage.decryptString(bytes), shouldReEncrypt: false };
    },
  };
}
