export class AtomicWriteConflictError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    readonly sideEffects: "none" | "uncertain" = "none",
  ) {
    super(message);
    this.name = "AtomicWriteConflictError";
  }
}
