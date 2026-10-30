import type { ZodType } from "zod";
import type {
  ModelToolCallContent,
  ModelToolContent,
  ModelToolSchema,
} from "../model/model-contract";
import type {
  Disposable,
  InteractionRequest,
  InteractionResponse,
  JsonValue,
  ProtocolError,
  RunIdentity,
  VersionedData,
} from "../protocol-values";

export interface ToolExecutionContext {
  readonly identity: RunIdentity;
  readonly callId: string;
  readonly signal: AbortSignal;
}

/** Applied means some effect occurred, not that all intended work succeeded. */
export type ToolSideEffects = "none" | "applied" | "unknown";

/** Unknown is an indeterminate outcome, not permission to retry an effectful operation. */
export type ToolResult<T = unknown> =
  | { readonly status: "succeeded"; readonly output: T; readonly effects: ToolSideEffects }
  | { readonly status: "failed"; readonly error: ProtocolError; readonly effects: ToolSideEffects }
  | {
      readonly status: "unknown";
      readonly error: ProtocolError;
      readonly effects: ToolSideEffects;
    };

export interface ToolSuspension {
  readonly status: "waiting";
  readonly interaction: InteractionRequest;
  /** The owner must bind continuation data to the tool version and validate it on resume. */
  readonly continuation: VersionedData;
  readonly effects: ToolSideEffects;
}

interface ToolDefinitionFields<TInput, TOutput> {
  readonly name: string;
  readonly version: string;
  readonly owner: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  /** Outputs must be representable as JSON at the executor's persistence boundary. */
  readonly outputSchema: ZodType<TOutput>;
  /** Omission means serial. Parallel declares eligibility only; it does not schedule work. */
  readonly concurrency?: "serial" | "parallel";
  /** Projection is separate from the business output, including failed/unknown outcomes. */
  readonly toModelContent: (
    result: ToolResult<TOutput>,
  ) => readonly ModelToolContent[] | Promise<readonly ModelToolContent[]>;
  readonly toPresentation?: (result: ToolResult<TOutput>) => VersionedData | Promise<VersionedData>;
}

export interface ImmediateToolDefinition<TInput = unknown, TOutput = unknown>
  extends ToolDefinitionFields<TInput, TOutput> {
  readonly mode: "immediate";
  readonly execute: (input: TInput, context: ToolExecutionContext) => Promise<ToolResult<TOutput>>;
}

export interface ResumableToolDefinition<TInput = unknown, TOutput = unknown>
  extends ToolDefinitionFields<TInput, TOutput> {
  readonly mode: "resumable";
  readonly execute: (
    input: TInput,
    context: ToolExecutionContext,
  ) => Promise<ToolResult<TOutput> | ToolSuspension>;
  /**
   * Resume a stored continuation, never an untrusted client snapshot. Effects reported
   * across execute/resume are cumulative for this call, including pre-suspension effects.
   */
  readonly resume: (
    continuation: VersionedData,
    response: InteractionResponse,
    context: ToolExecutionContext,
  ) => Promise<ToolResult<TOutput> | ToolSuspension>;
}

/** Business services are captured by the definition's closure, not injected into context. */
export type ToolDefinition<TInput = unknown, TOutput = unknown> =
  | ImmediateToolDefinition<TInput, TOutput>
  | ResumableToolDefinition<TInput, TOutput>;

/** Registration keeps each definition's input/output types without an unknown-typed registry. */
export interface ToolRegistrar {
  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): Disposable;
}

/** Persist projections with the outcome; replay must not rerun a tool or its projections. */
export type ToolCompletion = ToolResult<JsonValue> & {
  readonly modelContent: readonly ModelToolContent[];
  readonly presentation?: VersionedData;
};

export type ToolExecutionResult = ToolCompletion | ToolSuspension;

/**
 * The implementation owns heterogeneous type erasure, schema validation and JSON-safe
 * completion projection. It must preserve effects even on cancellation or projection
 * failure. This is an execution boundary, not a tool authorization policy engine.
 */
export interface ToolExecutor {
  getSchemas(): readonly ModelToolSchema[];
  /** The call ID must match context.callId; external execution policy controls dispatch. */
  execute(call: ModelToolCallContent, context: ToolExecutionContext): Promise<ToolExecutionResult>;
  /** Resolve the saved call and its version-bound continuation before invoking a resume handler. */
  resume(
    call: ModelToolCallContent,
    continuation: VersionedData,
    response: InteractionResponse,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}
