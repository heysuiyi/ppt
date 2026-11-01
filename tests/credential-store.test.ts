import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialStore,
  CredentialStoreError,
  type SafeStorageAdapter,
} from "../app/main/agent-configuration/internal/credential-store";
import type {
  ModelCredentialBinding,
  WebSearchCredentialBinding,
} from "../app/main/agent-configuration/internal/credential-types";
import type { CredentialStorageBackend } from "../src/shared/credentials";

const temporaryDirectories: string[] = [];

const MODEL_BINDING: ModelCredentialBinding = {
  vendorId: "primary-openai",
  provider: "openai",
  baseURL: "https://api.example.test/v1/",
};

const SEARCH_BINDING: WebSearchCredentialBinding = {
  endpoint: "https://api.tavily.com/search",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CredentialStore", () => {
  it("encrypts credentials with async safeStorage and writes only ciphertext", async () => {
    const { directory, store, safeStorage } = await createStore();
    const secret = "sk-plain-text-must-not-be-persisted";

    await store.setModelCredentials({
      bindings: [MODEL_BINDING],
      apiKey: secret,
    });

    expect(safeStorage.asyncEncryptCalls).toBe(1);
    expect(safeStorage.syncEncryptCalls).toBe(0);
    expect(
      await store.resolveModelCredential({
        ...MODEL_BINDING,
        baseURL: "https://api.example.test/v1",
      }),
    ).toBe(secret);

    const persistedText = await readFile(store.filePath, "utf8");
    expect(persistedText).not.toContain(secret);
    const persisted = JSON.parse(persistedText) as Record<string, unknown>;
    expect(Object.keys(persisted).sort()).toEqual(["credentials", "version"]);
    expect(persisted).toMatchObject({
      version: 2,
      credentials: [
        {
          ref: "vendor:primary-openai",
          binding: {
            vendorId: "primary-openai",
            baseURL: "https://api.example.test/v1",
          },
        },
      ],
    });
    if (process.platform !== "win32") {
      expect((await stat(join(directory, "credentials.v2.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("does not resolve a model secret after vendor binding changes", async () => {
    const { store } = await createStore();
    await store.setModelCredentials({ bindings: [MODEL_BINDING], apiKey: "bound-key" });

    await expect(
      store.resolveModelCredential({
        ...MODEL_BINDING,
        provider: "anthropic",
      }),
    ).resolves.toBeUndefined();
    await expect(
      store.resolveModelCredential({
        ...MODEL_BINDING,
        baseURL: "https://attacker.example.test/v1",
      }),
    ).resolves.toBeUndefined();
    await expect(
      store.resolveModelCredential({
        ...MODEL_BINDING,
        vendorId: "other-vendor",
      }),
    ).resolves.toBeUndefined();
  });

  it("upgrades legacy raw-api-key ciphertext to the envelope format", async () => {
    const { store, safeStorage } = await createStore();
    await store.setModelCredentials({ bindings: [MODEL_BINDING], apiKey: "envelope-key" });

    const persisted = JSON.parse(await readFile(store.filePath, "utf8")) as {
      version: 2;
      credentials: Array<{
        ref: string;
        binding: ModelCredentialBinding;
        fingerprint: string;
        ciphertext: string;
        updatedAt: string;
      }>;
    };
    const legacyKey = "sk-legacy-raw-api-key";
    persisted.credentials[0] = {
      ...persisted.credentials[0]!,
      ciphertext: safeStorage.encryptString(legacyKey).toString("base64"),
    };
    await writeFile(store.filePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    await expect(store.resolveModelCredential(MODEL_BINDING)).resolves.toBe(legacyKey);

    const upgraded = JSON.parse(await readFile(store.filePath, "utf8")) as {
      credentials: Array<{ ciphertext: string }>;
    };
    const upgradedPlainText = safeStorage.decryptString(
      Buffer.from(upgraded.credentials[0]!.ciphertext, "base64"),
    );
    expect(JSON.parse(upgradedPlainText)).toMatchObject({
      version: 1,
      apiKey: legacyKey,
    });
    await expect(store.resolveModelCredential(MODEL_BINDING)).resolves.toBe(legacyKey);
  });

  it("rejects plaintext credential transport except for loopback development endpoints", async () => {
    const { store } = await createStore();

    await expect(
      store.setModelCredentials({
        bindings: [{ ...MODEL_BINDING, baseURL: "http://api.example.test/v1" }],
        apiKey: "must-use-tls",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      store.setWebSearchCredential({
        binding: { endpoint: "http://search.example.test/api" },
        apiKey: "must-use-tls",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      store.setModelCredentials({
        bindings: [{ ...MODEL_BINDING, baseURL: "http://127.0.0.1:8080/v1" }],
        apiKey: "local-development-key",
      }),
    ).resolves.toBeUndefined();
    await expect(
      store.resolveModelCredential({
        ...MODEL_BINDING,
        baseURL: "http://127.0.0.1:8080/v1",
      }),
    ).resolves.toBe("local-development-key");
  });

  it("rejects ciphertext moved between otherwise valid credential bindings", async () => {
    const { store } = await createStore();
    const secondBinding: ModelCredentialBinding = {
      ...MODEL_BINDING,
      vendorId: "secondary-openai",
    };
    await store.setModelCredentials({ bindings: [MODEL_BINDING], apiKey: "first-key" });
    await store.setModelCredentials({ bindings: [secondBinding], apiKey: "second-key" });

    const persisted = JSON.parse(await readFile(store.filePath, "utf8")) as {
      version: 2;
      credentials: Array<{ ciphertext: string }>;
    };
    const firstCiphertext = persisted.credentials[0]!.ciphertext;
    persisted.credentials[0]!.ciphertext = persisted.credentials[1]!.ciphertext;
    persisted.credentials[1]!.ciphertext = firstCiphertext;
    await writeFile(store.filePath, JSON.stringify(persisted), "utf8");

    await expect(store.resolveModelCredential(MODEL_BINDING)).rejects.toMatchObject({
      name: "CredentialStoreError",
      code: "DECRYPTION_FAILED",
    });
  });

  it("commits a model credential batch atomically", async () => {
    const { store, safeStorage } = await createStore();
    const secondBinding: ModelCredentialBinding = {
      ...MODEL_BINDING,
      vendorId: "secondary-openai",
    };
    await store.setModelCredentials({ bindings: [MODEL_BINDING], apiKey: "old-key" });
    const before = await readFile(store.filePath, "utf8");
    safeStorage.failOnAsyncEncryptCall = safeStorage.asyncEncryptCalls + 2;

    await expect(
      store.setModelCredentials({
        bindings: [MODEL_BINDING, secondBinding],
        apiKey: "replacement-key",
      }),
    ).rejects.toMatchObject({
      name: "CredentialStoreError",
      code: "ENCRYPTION_FAILED",
    });

    expect(await readFile(store.filePath, "utf8")).toBe(before);
    await expect(store.resolveModelCredential(MODEL_BINDING)).resolves.toBe("old-key");
    await expect(store.resolveModelCredential(secondBinding)).resolves.toBeUndefined();
  });

  it("serializes complete read-modify-write transactions across store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-ppt-credentials-shared-"));
    temporaryDirectories.push(directory);
    const firstSafeStorage = new FakeSafeStorage();
    const secondSafeStorage = new FakeSafeStorage();
    let markFirstEncryptionStarted!: () => void;
    const firstEncryptionStarted = new Promise<void>((resolve) => {
      markFirstEncryptionStarted = resolve;
    });
    let releaseFirstEncryption!: () => void;
    const firstEncryptionRelease = new Promise<void>((resolve) => {
      releaseFirstEncryption = resolve;
    });
    firstSafeStorage.beforeAsyncEncrypt = async () => {
      markFirstEncryptionStarted();
      await firstEncryptionRelease;
    };
    const firstStore = new CredentialStore({
      applicationDataRoot: directory,
      safeStorage: firstSafeStorage,
    });
    const secondStore = new CredentialStore({
      applicationDataRoot: directory,
      safeStorage: secondSafeStorage,
    });
    const secondBinding: ModelCredentialBinding = {
      ...MODEL_BINDING,
      vendorId: "secondary-openai",
    };

    const firstWrite = firstStore.setModelCredentials({
      bindings: [MODEL_BINDING],
      apiKey: "first-key",
    });
    await firstEncryptionStarted;
    const secondWrite = secondStore.setModelCredentials({
      bindings: [secondBinding],
      apiKey: "second-key",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const secondEnteredWhileFirstHeldLock = secondSafeStorage.asyncEncryptCalls > 0;

    releaseFirstEncryption();
    await Promise.all([firstWrite, secondWrite]);
    expect(secondEnteredWhileFirstHeldLock).toBe(false);

    await expect(firstStore.resolveModelCredential(MODEL_BINDING)).resolves.toBe("first-key");
    await expect(secondStore.resolveModelCredential(secondBinding)).resolves.toBe("second-key");
  });

  it("binds, reports, and deletes the Tavily credential by normalized endpoint", async () => {
    const { store } = await createStore();
    await store.setWebSearchCredential({
      binding: SEARCH_BINDING,
      apiKey: "tvly-secret",
    });

    await expect(store.resolveWebSearchCredential(SEARCH_BINDING)).resolves.toBe("tvly-secret");
    await expect(
      store.resolveWebSearchCredential({
        endpoint: "https://proxy.example.test/search",
      }),
    ).resolves.toBeUndefined();
    await expect(
      store.getStatus({
        models: [MODEL_BINDING],
        webSearch: SEARCH_BINDING,
      }),
    ).resolves.toMatchObject({
      models: [{ vendorId: "primary-openai", configured: false }],
      webSearchConfigured: true,
    });

    await store.deleteWebSearchCredential();
    await expect(store.resolveWebSearchCredential(SEARCH_BINDING)).resolves.toBeUndefined();
  });

  it("allows basic_text with an explicit degraded status", async () => {
    const safeStorage = new FakeSafeStorage();
    safeStorage.backend = "basic_text";
    const { store } = await createStore(safeStorage);

    expect((await store.getStatus()).storage).toEqual({
      state: "degraded",
      backend: "basic_text",
      warning: "linux-basic-text",
    });
    await expect(
      store.setModelCredentials({
        bindings: [MODEL_BINDING],
        apiKey: "degraded-but-allowed",
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses to persist secrets when safeStorage is unavailable", async () => {
    const safeStorage = new FakeSafeStorage();
    safeStorage.asyncAvailable = false;
    safeStorage.syncAvailable = false;
    const { store } = await createStore(safeStorage);

    expect((await store.getStatus()).storage).toEqual({
      state: "unavailable",
      backend: "unknown",
      warning: "safe-storage-unavailable",
    });
    const secret = "must-not-be-written";
    await expect(
      store.setModelCredentials({
        bindings: [MODEL_BINDING],
        apiKey: secret,
      }),
    ).rejects.toMatchObject({
      name: "CredentialStoreError",
      code: "STORAGE_UNAVAILABLE",
    });
    await expect(readFile(store.filePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("surfaces malformed stores and filesystem errors without exposing secrets", async () => {
    const malformed = await createStore();
    await writeFile(malformed.store.filePath, "{not-json", "utf8");
    await expect(malformed.store.getStatus()).rejects.toMatchObject({
      name: "CredentialStoreError",
      code: "CORRUPT_STORE",
    });

    const blocked = await createStore();
    await mkdir(blocked.store.filePath);
    const secret = "never-include-this-in-errors";
    let failure: unknown;
    try {
      await blocked.store.setModelCredentials({
        bindings: [MODEL_BINDING],
        apiKey: secret,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CredentialStoreError);
    expect(failure).toMatchObject({ code: "PERSISTENCE_FAILED" });
    expect((failure as Error).message).not.toContain(secret);
  });
});

async function createStore(safeStorage = new FakeSafeStorage()): Promise<{
  directory: string;
  store: CredentialStore;
  safeStorage: FakeSafeStorage;
}> {
  const directory = await mkdtemp(join(tmpdir(), "agent-ppt-credentials-"));
  temporaryDirectories.push(directory);
  return {
    directory,
    safeStorage,
    store: new CredentialStore({ applicationDataRoot: directory, safeStorage }),
  };
}

class FakeSafeStorage implements SafeStorageAdapter {
  backend: CredentialStorageBackend = "unknown";
  asyncAvailable = true;
  syncAvailable = true;
  asyncEncryptCalls = 0;
  syncEncryptCalls = 0;
  failOnAsyncEncryptCall: number | undefined;
  beforeAsyncEncrypt: (() => Promise<void>) | undefined;

  decryptString(encrypted: Buffer): string {
    return decode(encrypted);
  }

  async decryptStringAsync(encrypted: Buffer): Promise<{
    result: string;
    shouldReEncrypt: boolean;
  }> {
    return { result: decode(encrypted), shouldReEncrypt: false };
  }

  encryptString(plainText: string): Buffer {
    this.syncEncryptCalls += 1;
    return encode(plainText);
  }

  async encryptStringAsync(plainText: string): Promise<Buffer> {
    this.asyncEncryptCalls += 1;
    if (this.asyncEncryptCalls === this.failOnAsyncEncryptCall) {
      throw new Error("simulated encryption failure");
    }
    await this.beforeAsyncEncrypt?.();
    return encode(plainText);
  }

  getSelectedStorageBackend(): CredentialStorageBackend {
    return this.backend;
  }

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return this.asyncAvailable;
  }

  isEncryptionAvailable(): boolean {
    return this.syncAvailable;
  }
}

function encode(value: string): Buffer {
  return Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ 0xa5));
}

function decode(value: Buffer): string {
  return Buffer.from(value.map((byte) => byte ^ 0xa5)).toString("utf8");
}
