/** Values allowed across persistence and plugin protocol boundaries; exclude services and secrets. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** A versioned payload belongs to its named producer, not to the execution loop. */
export interface VersionedData {
  readonly type: string;
  readonly version: number;
  readonly data: JsonValue;
}

/** A query can survive multiple run activations within one conversation thread. */
export interface RunIdentity {
  readonly agentId: string;
  readonly threadId: string;
  readonly queryId: string;
  readonly runId: string;
}

/** Safe public error data; native errors, credentials and stack traces stay with the host. */
export interface ProtocolError {
  readonly code: string;
  readonly message: string;
}

/** The owner validates the payload and interprets the response; the kernel only routes it. */
export interface InteractionRequest {
  readonly id: string;
  readonly owner: string;
  readonly payload: VersionedData;
}

/** Resolve only a stored pending interaction; this is not an execution snapshot from the client. */
export type InteractionResponse =
  | { readonly interactionId: string; readonly type: "answer"; readonly value: JsonValue }
  | { readonly interactionId: string; readonly type: "reject" | "cancel" };

export interface Disposable {
  /** Idempotent; resolves after owned work and registrations have been released. */
  dispose(): Promise<void>;
}
