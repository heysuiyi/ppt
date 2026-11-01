import type { AgentModelMessage } from "../../gateway";
import type { ToolContext } from "../../tools/tool-definition";
import type { AgentRuntimeOptions } from "../runtime-types";
import type { AgentQueryParams, AgentQuerySource, QueryId, QueryStartMode } from "./query-types";

export interface AgentQueryAssemblyInput<TDeps> {
  queryId: QueryId;
  options: AgentRuntimeOptions;
  messages: readonly AgentModelMessage[];
  systemPrompt: string;
  toolUseContext: ToolContext;
  maxTurns: number;
  deps: TDeps;
  canUseTool?: AgentQueryParams["canUseTool"];
}

/**
 * The sole adapter from application-level Runtime options to stable query input.
 * Compatibility fields are interpreted here and do not leak into turn runners.
 */
export class AgentQueryAssembler {
  assemble<TDeps>(input: AgentQueryAssemblyInput<TDeps>): AgentQueryParams<TDeps> {
    const startMode = input.options.startMode;
    return Object.freeze({
      queryId: input.queryId,
      messages: structuredClone(input.messages),
      systemPrompt: input.systemPrompt,
      userContext: Object.freeze({ ...(input.options.userContext ?? {}) }),
      systemContext: Object.freeze({
        ...(input.options.systemContext ?? {}),
        threadId: input.options.threadId,
        runId: input.options.runId ?? "",
      }),
      canUseTool: input.canUseTool ?? (() => true),
      toolUseContext: input.toolUseContext,
      model: input.options.model,
      fallbackModel: input.options.fallbackModel,
      querySource: querySourceFor(startMode),
      maxOutputTokensOverride: input.options.maxOutputTokensOverride,
      maxTurns: input.maxTurns,
      deps: input.deps,
    });
  }
}

function querySourceFor(startMode: QueryStartMode): AgentQuerySource {
  if (startMode.type === "new_query") return "user";
  return startMode.reason === "waiting_user" ? "continuation" : "recovery";
}
