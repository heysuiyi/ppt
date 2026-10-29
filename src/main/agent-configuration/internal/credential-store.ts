import { createHash } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  CREDENTIAL_STORE_FILE_NAME,
  type CredentialStatusSnapshot,
  type CredentialStorageBackend,
  type CredentialStorageStatus,
  credentialApiKeySchema,
  LEGACY_CREDENTIAL_STORE_FILE_NAME,
} from "@shared/credentials";
import { z } from "zod";
import { readJsonFile, writeTextFileAtomic } from "../../agent/persistence/atomic-json-file";
import {
  type CredentialStatusRequest,
  credentialStatusRequestSchema,
  type DeleteModelCredentialRequest,
  deleteModelCredentialRequestSchema,
  type ModelCredentialBinding,
  modelCredentialBindingSchema,
  normalizeModelCredentialBinding,
  normalizeWebSearchCredentialBinding,
  type SetModelCredentialsRequest,
  type SetWebSearchCredentialRequest,
  setModelCredentialsRequestSchema,
  setWebSearchCredentialRequestSchema,
  type WebSearchCredentialBinding,
  webSearchCredentialBindingSchema,
} from "./credential-types";

const MODEL_CREDENTIAL_REF_PREFIX = "vendor:";
const WEB_SEARCH_CREDENTIAL_REF = "web-search:tavily";
const MAX_PERSISTED_CREDENTIALS = 501;

type LockRelease = () => Promise<void>;
type ProperLockfile = {
  lock(
    file: string,
    options?: {
      realpath?: boolean;
      stale?: number;
      retries?:
        | number
        | {
            retries?: number;
            factor?: number;
            minTimeout?: number;
            maxTimeout?: number;
          };
    },
  ): Promise<LockRelease>;
};
const lockfile = createRequire(import.meta.url)("proper-lockfile") as ProperLockfile;
const STORE_LOCK_OPTIONS = {
  realpath: false,
  stale: 30_000,
  retries: {
    retries: 600,
    factor: 1,
    minTimeout: 10,
    maxTimeout: 100,
  },
} as const;

const encryptedPayloadSchema = z
  .string()
  .min(1)
  .max(65_536)
  .regex(/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/);
const credentialFingerprintSchema = z.string().regex(/^[a-f\d]{64}$/);

const encryptedCredentialEnvelopeSchema = z
  .object({
    version: z.literal(1),
    fingerprint: credentialFingerprintSchema,
    apiKey: credentialApiKeySchema,
  })
  .strict();

const persistedCredentialSchema = z
  .object({
    ref: z.string().min(1).max(512),
    binding: z.union([modelCredentialBindingSchema, webSearchCredentialBindingSchema]),
    fingerprint: credentialFingerprintSchema,
    ciphertext: encryptedPayloadSchema,
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const persistedCredentialFileSchema = z
  .object({
    version: z.literal(2),
    credentials: z.array(persistedCredentialSchema).max(MAX_PERSISTED_CREDENTIALS),
  })
  .strict();

type PersistedCredential = z.infer<typeof persistedCredentialSchema>;
type PersistedCredentialFile = z.infer<typeof persistedCredentialFileSchema>;
type ParsedCredentialStatusRequest = z.output<typeof credentialStatusRequestSchema>;
type EncryptionMode = "async" | "sync";

export interface SafeStorageAdapter {
  decryptString(encrypted: Buffer): string;
  decryptStringAsync(encrypted: Buffer): Promise<{
    result: string;
    shouldReEncrypt: boolean;
  }>;
  encryptString(plainText: string): Buffer;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  getSelectedStorageBackend(): CredentialStorageBackend;
  isAsyncEncryptionAvailable(): Promise<boolean>;
  isEncryptionAvailable(): boolean;
}

export type CredentialStoreErrorCode =
  | "INVALID_INPUT"
  | "STORAGE_UNAVAILABLE"
  | "CORRUPT_STORE"
  | "ENCRYPTION_FAILED"
  | "DECRYPTION_FAILED"
  | "PERSISTENCE_FAILED";

export class CredentialStoreError extends Error {
  constructor(
    readonly code: CredentialStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CredentialStoreError";
  }
}

export interface CredentialStoreOptions {
  applicationDataRoot: string;
  safeStorage: SafeStorageAdapter;
  now?: () => Date;
}

export class CredentialStore {
  readonly filePath: string;
  private readonly safeStorage: SafeStorageAdapter;
  private readonly now: () => Date;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(options: CredentialStoreOptions) {
    const applicationDataRoot = options.applicationDataRoot.trim();
    if (!applicationDataRoot) {
      throw new CredentialStoreError("INVALID_INPUT", "The application data root is required.");
    }
    this.filePath = join(applicationDataRoot, CREDENTIAL_STORE_FILE_NAME);
    this.safeStorage = options.safeStorage;
    this.now = options.now ?? (() => new Date());
  }

  async getStatus(input: CredentialStatusRequest = {}): Promise<CredentialStatusSnapshot> {
    return await this.exclusive(async () => {
      const request = this.parseStatusRequest(input);
      const storage = (await this.inspectStorage()).status;
      const state = await this.readState();
      const storageUsable = storage.state !== "unavailable";

      return {
        storage,
        models: request.models.map((binding) => ({
          vendorId: binding.vendorId,
          configured:
            storageUsable &&
            Boolean(findCredential(state, modelCredentialRef(binding.vendorId), binding)),
        })),
        webSearchConfigured:
          storageUsable &&
          Boolean(
            request.webSearch &&
              findCredential(state, WEB_SEARCH_CREDENTIAL_REF, request.webSearch),
          ),
      };
    });
  }

  async setModelCredentials(input: SetModelCredentialsRequest): Promise<void> {
    await this.exclusive(async () => {
      const request = this.parseSetModelCredentialsRequest(input);
      const references = request.bindings.map((binding) => modelCredentialRef(binding.vendorId));
      if (new Set(references).size !== references.length) {
        throw new CredentialStoreError(
          "INVALID_INPUT",
          "A model credential batch cannot contain duplicate vendor IDs.",
        );
      }

      const mode = await this.requireEncryptionMode();
      const encrypted = await Promise.all(
        request.bindings.map(async (binding) => ({
          binding,
          ciphertext: await this.encryptCredential(request.apiKey, binding, mode),
        })),
      );
      const state = await this.readState();
      const replacedReferences = new Set(references);
      const updatedAt = this.now().toISOString();
      const credentials = state.credentials.filter((entry) => !replacedReferences.has(entry.ref));
      credentials.push(
        ...encrypted.map(({ binding, ciphertext }) => ({
          ref: modelCredentialRef(binding.vendorId),
          binding,
          fingerprint: credentialFingerprint(binding),
          ciphertext: ciphertext.toString("base64"),
          updatedAt,
        })),
      );
      await this.writeState({ version: 2, credentials });
    });
  }

  async deleteModelCredential(input: DeleteModelCredentialRequest): Promise<void> {
    await this.exclusive(async () => {
      const request = this.parseDeleteModelCredentialRequest(input);
      const state = await this.readState();
      const ref = modelCredentialRef(request.vendorId);
      const credentials = state.credentials.filter((entry) => entry.ref !== ref);
      if (credentials.length !== state.credentials.length) {
        await this.writeState({ version: 2, credentials });
      }
    });
  }

  async setWebSearchCredential(input: SetWebSearchCredentialRequest): Promise<void> {
    await this.exclusive(async () => {
      const request = this.parseSetWebSearchCredentialRequest(input);
      const mode = await this.requireEncryptionMode();
      const encrypted = await this.encryptCredential(request.apiKey, request.binding, mode);
      const state = await this.readState();
      const credentials = state.credentials.filter(
        (entry) => entry.ref !== WEB_SEARCH_CREDENTIAL_REF,
      );
      credentials.push({
        ref: WEB_SEARCH_CREDENTIAL_REF,
        binding: request.binding,
        fingerprint: credentialFingerprint(request.binding),
        ciphertext: encrypted.toString("base64"),
        updatedAt: this.now().toISOString(),
      });
      await this.writeState({ version: 2, credentials });
    });
  }

  async deleteWebSearchCredential(): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.readState();
      const credentials = state.credentials.filter(
        (entry) => entry.ref !== WEB_SEARCH_CREDENTIAL_REF,
      );
      if (credentials.length !== state.credentials.length) {
        await this.writeState({ version: 2, credentials });
      }
    });
  }

  async resolveModelCredential(input: ModelCredentialBinding): Promise<string | undefined> {
    return await this.exclusive(async () => {
      const binding = this.parseModelBinding(input);
      return await this.resolveCredential(modelCredentialRef(binding.vendorId), binding);
    });
  }

  async resolveWebSearchCredential(input: WebSearchCredentialBinding): Promise<string | undefined> {
    return await this.exclusive(async () => {
      const binding = this.parseWebSearchBinding(input);
      return await this.resolveCredential(WEB_SEARCH_CREDENTIAL_REF, binding);
    });
  }

  private async resolveCredential(
    ref: string,
    binding: ModelCredentialBinding | WebSearchCredentialBinding,
  ): Promise<string | undefined> {
    const state = await this.readState();
    const entry = findCredential(state, ref, binding);
    if (!entry) return undefined;

    const mode = await this.requireEncryptionMode();
    const decrypted = await this.decryptCredential(entry, mode);
    if (decrypted.shouldReEncrypt) {
      const ciphertext = await this.encryptCredential(decrypted.apiKey, entry.binding, mode);
      const credentials = state.credentials.map((candidate) =>
        candidate.ref === ref
          ? {
              ...candidate,
              ciphertext: ciphertext.toString("base64"),
              updatedAt: this.now().toISOString(),
            }
          : candidate,
      );
      await this.writeState({ version: 2, credentials });
    }
    return decrypted.apiKey;
  }

  private async inspectStorage(): Promise<{
    status: CredentialStorageStatus;
    mode?: EncryptionMode;
  }> {
    let backend: CredentialStorageBackend = "unknown";
    try {
      backend = this.safeStorage.getSelectedStorageBackend();
    } catch {
      // Backend discovery is informational; availability probes remain authoritative.
    }

    let asyncAvailable = false;
    try {
      asyncAvailable = await this.safeStorage.isAsyncEncryptionAvailable();
    } catch {
      // Fall back to the synchronous safeStorage API when it is available.
    }
    let syncAvailable = false;
    if (!asyncAvailable) {
      try {
        syncAvailable = this.safeStorage.isEncryptionAvailable();
      } catch {
        // Report the store as unavailable below.
      }
    }
    const mode: EncryptionMode | undefined = asyncAvailable
      ? "async"
      : syncAvailable
        ? "sync"
        : undefined;
    if (!mode) {
      return {
        status: {
          state: "unavailable",
          backend,
          warning: "safe-storage-unavailable",
        },
      };
    }
    if (backend === "basic_text") {
      return {
        mode,
        status: {
          state: "degraded",
          backend,
          warning: "linux-basic-text",
        },
      };
    }
    return { mode, status: { state: "secure", backend } };
  }

  private async requireEncryptionMode(): Promise<EncryptionMode> {
    const inspected = await this.inspectStorage();
    if (!inspected.mode) {
      throw new CredentialStoreError(
        "STORAGE_UNAVAILABLE",
        "Operating-system credential encryption is unavailable.",
      );
    }
    return inspected.mode;
  }

  private async encrypt(plainText: string, mode: EncryptionMode): Promise<Buffer> {
    try {
      const encrypted =
        mode === "async"
          ? await this.safeStorage.encryptStringAsync(plainText)
          : this.safeStorage.encryptString(plainText);
      if (encrypted.length === 0) throw new Error("Empty encrypted payload.");
      return encrypted;
    } catch (error) {
      throw new CredentialStoreError(
        "ENCRYPTION_FAILED",
        "The credential could not be encrypted.",
        { cause: error },
      );
    }
  }

  private async encryptCredential(
    apiKey: string,
    binding: ModelCredentialBinding | WebSearchCredentialBinding,
    mode: EncryptionMode,
  ): Promise<Buffer> {
    return this.encrypt(
      JSON.stringify({
        version: 1,
        fingerprint: credentialFingerprint(binding),
        apiKey,
      }),
      mode,
    );
  }

  private async decryptCredential(
    entry: PersistedCredential,
    mode: EncryptionMode,
  ): Promise<{ apiKey: string; shouldReEncrypt: boolean }> {
    try {
      const encrypted = Buffer.from(entry.ciphertext, "base64");
      const decrypted =
        mode === "async"
          ? await this.safeStorage.decryptStringAsync(encrypted)
          : {
              result: this.safeStorage.decryptString(encrypted),
              shouldReEncrypt: false,
            };
      const credential = parseDecryptedCredential(decrypted.result, entry.fingerprint);
      return {
        apiKey: credential.apiKey,
        shouldReEncrypt: decrypted.shouldReEncrypt || credential.isLegacy,
      };
    } catch (error) {
      throw new CredentialStoreError(
        "DECRYPTION_FAILED",
        "The credential could not be decrypted.",
        { cause: error },
      );
    }
  }

  private async readState(): Promise<PersistedCredentialFile> {
    let value: unknown;
    try {
      value = await readJsonFile<unknown>(this.filePath);
      if (value === undefined) {
        const migrated = await this.migrateLegacyStoreIfPresent();
        return migrated ?? { version: 2, credentials: [] };
      }
      await chmod(this.filePath, 0o600);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new CredentialStoreError("CORRUPT_STORE", "The credential store is not valid JSON.", {
          cause: error,
        });
      }
      throw new CredentialStoreError(
        "PERSISTENCE_FAILED",
        "The credential store could not be read securely.",
        { cause: error },
      );
    }

    const parsed = persistedCredentialFileSchema.safeParse(value);
    if (!parsed.success || !hasConsistentCredentials(parsed.data)) {
      throw new CredentialStoreError(
        "CORRUPT_STORE",
        "The credential store failed integrity validation.",
      );
    }
    return parsed.data;
  }

  /**
   * Legacy per-model credentials cannot be remapped to vendor bindings without
   * the catalog. Keep web-search secrets and drop model entries so users re-enter keys.
   */
  private async migrateLegacyStoreIfPresent(): Promise<PersistedCredentialFile | undefined> {
    const legacyPath = join(dirname(this.filePath), LEGACY_CREDENTIAL_STORE_FILE_NAME);
    let legacyValue: unknown;
    try {
      legacyValue = await readJsonFile<unknown>(legacyPath);
    } catch {
      return undefined;
    }
    if (legacyValue === undefined) return undefined;

    const legacySchema = z
      .object({
        version: z.literal(1),
        credentials: z
          .array(
            z
              .object({
                ref: z.string().min(1).max(512),
                binding: z.unknown(),
                fingerprint: credentialFingerprintSchema,
                ciphertext: encryptedPayloadSchema,
                updatedAt: z.string().datetime({ offset: true }),
              })
              .strict(),
          )
          .max(MAX_PERSISTED_CREDENTIALS),
      })
      .strict();
    const parsed = legacySchema.safeParse(legacyValue);
    if (!parsed.success) {
      throw new CredentialStoreError(
        "CORRUPT_STORE",
        "The legacy credential store failed integrity validation.",
      );
    }

    const webSearchEntries = parsed.data.credentials.flatMap((entry) => {
      if (entry.ref !== WEB_SEARCH_CREDENTIAL_REF) return [];
      const binding = webSearchCredentialBindingSchema.safeParse(entry.binding);
      if (!binding.success) return [];
      const normalized = normalizeWebSearchCredentialBinding(binding.data);
      return [
        {
          ref: WEB_SEARCH_CREDENTIAL_REF,
          binding: normalized,
          fingerprint: credentialFingerprint(normalized),
          ciphertext: entry.ciphertext,
          updatedAt: entry.updatedAt,
        },
      ];
    });

    const migrated: PersistedCredentialFile = { version: 2, credentials: webSearchEntries };
    await this.writeState(migrated);
    try {
      await unlink(legacyPath);
    } catch {
      // Leaving the legacy file is acceptable; v2 is authoritative.
    }
    return migrated;
  }

  private async writeState(state: PersistedCredentialFile): Promise<void> {
    const parsed = persistedCredentialFileSchema.safeParse(state);
    if (!parsed.success || !hasConsistentCredentials(parsed.data)) {
      throw new CredentialStoreError(
        "CORRUPT_STORE",
        "Refusing to write an inconsistent credential store.",
      );
    }
    try {
      await writeTextFileAtomic(this.filePath, `${JSON.stringify(parsed.data, null, 2)}\n`, {
        mode: 0o600,
      });
    } catch (error) {
      throw new CredentialStoreError(
        "PERSISTENCE_FAILED",
        "The credential store could not be written atomically.",
        { cause: error },
      );
    }
  }

  private parseStatusRequest(input: unknown): ParsedCredentialStatusRequest {
    return this.parseInput(
      credentialStatusRequestSchema,
      input,
      "The credential status request is invalid.",
      (request) => ({
        models: request.models.map((binding) => normalizeModelCredentialBinding(binding)),
        ...(request.webSearch
          ? { webSearch: normalizeWebSearchCredentialBinding(request.webSearch) }
          : {}),
      }),
    );
  }

  private parseSetModelCredentialsRequest(input: unknown): SetModelCredentialsRequest {
    return this.parseInput(
      setModelCredentialsRequestSchema,
      input,
      "The model credential request is invalid.",
      (request) => ({
        bindings: request.bindings.map((binding) => normalizeModelCredentialBinding(binding)),
        apiKey: request.apiKey,
      }),
    );
  }

  private parseDeleteModelCredentialRequest(input: unknown): DeleteModelCredentialRequest {
    return this.parseInput(
      deleteModelCredentialRequestSchema,
      input,
      "The model credential deletion request is invalid.",
    );
  }

  private parseSetWebSearchCredentialRequest(input: unknown): SetWebSearchCredentialRequest {
    return this.parseInput(
      setWebSearchCredentialRequestSchema,
      input,
      "The web-search credential request is invalid.",
      (request) => ({
        binding: normalizeWebSearchCredentialBinding(request.binding),
        apiKey: request.apiKey,
      }),
    );
  }

  private parseModelBinding(input: unknown): ModelCredentialBinding {
    return this.parseInput(
      modelCredentialBindingSchema,
      input,
      "The model credential binding is invalid.",
      normalizeModelCredentialBinding,
    );
  }

  private parseWebSearchBinding(input: unknown): WebSearchCredentialBinding {
    return this.parseInput(
      webSearchCredentialBindingSchema,
      input,
      "The web-search credential binding is invalid.",
      normalizeWebSearchCredentialBinding,
    );
  }

  private parseInput<T, U = T>(
    schema: z.ZodType<T>,
    input: unknown,
    message: string,
    normalize?: (value: T) => U,
  ): U {
    try {
      const parsed = schema.parse(input);
      return normalize ? normalize(parsed) : (parsed as unknown as U);
    } catch (error) {
      throw new CredentialStoreError("INVALID_INPUT", message, { cause: error });
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => await this.withInterProcessLock(operation);
    const result = this.operationTail.then(run, run);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  private async withInterProcessLock<T>(operation: () => Promise<T>): Promise<T> {
    let release: LockRelease;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      release = await lockfile.lock(`${this.filePath}.transaction`, STORE_LOCK_OPTIONS);
    } catch (error) {
      throw new CredentialStoreError(
        "PERSISTENCE_FAILED",
        "The credential store transaction lock could not be acquired.",
        { cause: error },
      );
    }

    let result: T;
    try {
      result = await operation();
    } catch (operationError) {
      try {
        await release();
      } catch {
        // Prefer the original operation error over a release failure.
      }
      throw operationError;
    }

    try {
      await release();
    } catch (error) {
      throw new CredentialStoreError(
        "PERSISTENCE_FAILED",
        "The credential store transaction lock could not be released.",
        { cause: error },
      );
    }
    return result;
  }
}

function modelCredentialRef(vendorId: string): string {
  return `${MODEL_CREDENTIAL_REF_PREFIX}${encodeURIComponent(vendorId)}`;
}

function credentialFingerprint(
  binding: ModelCredentialBinding | WebSearchCredentialBinding,
): string {
  return createHash("sha256").update(JSON.stringify(binding), "utf8").digest("hex");
}

function findCredential(
  state: PersistedCredentialFile,
  ref: string,
  binding: ModelCredentialBinding | WebSearchCredentialBinding,
): PersistedCredential | undefined {
  const fingerprint = credentialFingerprint(binding);
  return state.credentials.find((entry) => entry.ref === ref && entry.fingerprint === fingerprint);
}

function isConsistentState(state: PersistedCredentialFile): boolean {
  const references = new Set<string>();
  return state.credentials.every((entry) => {
    if (references.has(entry.ref)) return false;
    references.add(entry.ref);
    const binding = normalizePersistedBinding(entry.binding);
    const expectedRef =
      "vendorId" in binding ? modelCredentialRef(binding.vendorId) : WEB_SEARCH_CREDENTIAL_REF;
    return entry.ref === expectedRef && entry.fingerprint === credentialFingerprint(binding);
  });
}

function hasConsistentCredentials(state: PersistedCredentialFile): boolean {
  try {
    return isConsistentState(state);
  } catch {
    return false;
  }
}

function normalizePersistedBinding(
  binding: ModelCredentialBinding | WebSearchCredentialBinding,
): ModelCredentialBinding | WebSearchCredentialBinding {
  return "vendorId" in binding
    ? normalizeModelCredentialBinding(binding)
    : normalizeWebSearchCredentialBinding(binding);
}

/**
 * Current records encrypt a JSON envelope. Older development builds encrypted
 * the raw API key string; accept that shape once and re-encrypt on resolve.
 */
function parseDecryptedCredential(
  plainText: string,
  expectedFingerprint: string,
): { apiKey: string; isLegacy: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plainText) as unknown;
  } catch {
    return {
      apiKey: credentialApiKeySchema.parse(plainText),
      isLegacy: true,
    };
  }

  const envelope = encryptedCredentialEnvelopeSchema.parse(parsed);
  if (envelope.fingerprint !== expectedFingerprint) {
    throw new Error("The encrypted credential binding does not match its record.");
  }
  return { apiKey: envelope.apiKey, isLegacy: false };
}
