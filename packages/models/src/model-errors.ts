export type ModelProviderErrorCode =
  | "ADAPTER_UNSUPPORTED"
  | "CONFIGURATION"
  | "MODEL_CAPABILITY"
  | "AUTHENTICATION"
  | "ACCESS_DENIED"
  | "PAYMENT_REQUIRED"
  | "RATE_LIMIT_OR_QUOTA"
  | "SERVICE_UNAVAILABLE"
  | "TIMEOUT"
  | "NETWORK"
  | "INCOMPLETE_STREAM"
  | "TRUNCATED"
  | "INVALID_RESPONSE"
  | "REPLAY_INCOMPATIBLE"
  | "CANCELLED"
  | "CLOSED";

/** Safe public error; adapters supply reviewed static messages, never SDK causes. */
export class ModelProviderError extends Error {
  constructor(
    readonly code: ModelProviderErrorCode,
    message: string,
    readonly adapterId?: string,
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}
