import type { ModelRegistrar } from "../model/model-contract";
import type { Disposable, RunIdentity } from "../protocol-values";
import type { ToolRegistrar } from "../tools/tool-contract";
import type { PluginScope } from "./plugin-scope";

export interface PromptContext {
  readonly identity: RunIdentity;
  readonly signal: AbortSignal;
}

export interface PromptContribution {
  readonly id: string;
  /** Called at a step boundary; business dependencies stay in the contributor's closure. */
  render(context: PromptContext): string | Promise<string>;
}

export interface PromptRegistrar {
  /** Reject duplicate IDs in the same scope; disposal removes only this registration. */
  register(contribution: PromptContribution): Disposable;
}

/** A scoped registration surface, not a service locator or a shared mutable business context. */
export interface PluginContext {
  readonly scope: PluginScope;
  /** Registrations made here are owned by this plugin scope and reclaimed on setup failure or disposal. */
  readonly models: ModelRegistrar;
  readonly tools: ToolRegistrar;
  readonly prompts: PromptRegistrar;
}

export interface AgentPlugin {
  readonly id: string;
  /** Resume checks the installed version before interpreting plugin-owned continuation data. */
  readonly version: string;
  /** Trusted in-process composition only; external services are provided by the plugin factory. */
  setup(context: PluginContext): void | Promise<void>;
}
