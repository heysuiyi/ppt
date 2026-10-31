import type { AgentResumeInput, AgentRunHandle, AgentRunInput } from "../agent/agent-contract.js";
import type { AgentCreationOptions, AgentServices } from "../agent/agent-factory.js";
import {
  type AgentApplication,
  createAgentApplication,
} from "../agent/application/agent-application.js";
import { AgentError } from "../agent/protocol-errors.js";
import { type Disposable, snapshot } from "../agent/protocol-values.js";

export interface SessionBindingPort {
  ensure(): Promise<void>;
}

export interface SessionHostOptions {
  readonly services: AgentServices;
  readonly agent: AgentCreationOptions;
  readonly threadId: string;
  readonly binding: SessionBindingPort;
}

export type SessionRunInput = Omit<AgentRunInput, "threadId">;
export type SessionResumeInput = Omit<AgentResumeInput, "threadId" | "takeover">;

export interface SessionHost extends Disposable {
  run(input: SessionRunInput): Promise<AgentRunHandle>;
  resume(input: SessionResumeInput): Promise<AgentRunHandle>;
  close(): Promise<void>;
}

/** 借用端口与绑定校验；只拥有绑定通过后创建的 Application。 */
export async function createSessionHost(options: SessionHostOptions): Promise<SessionHost> {
  if (
    typeof options?.threadId !== "string" ||
    !options.threadId.trim() ||
    typeof options.binding?.ensure !== "function" ||
    typeof options.services?.authorizeTool !== "function" ||
    typeof options.services.models?.create !== "function" ||
    typeof options.services.history?.read !== "function" ||
    typeof options.services.history?.append !== "function" ||
    typeof options.services.checkpoints?.findUnfinished !== "function" ||
    typeof options.services.checkpoints?.acquire !== "function" ||
    typeof options.services.checkpoints?.save !== "function" ||
    typeof options.services.checkpoints?.release !== "function" ||
    !options.agent ||
    !Array.isArray(options.agent.plugins)
  ) {
    throw new AgentError("HOST_OPTIONS_INVALID", "需要有效会话、显式授权、绑定与完整 Agent 端口。");
  }

  // ensure 可能等待外部存储；等待期间不能跟随调用方的可变配置漂移。
  const threadId = options.threadId;
  const binding = options.binding;
  const services: AgentServices = {
    models: options.services.models,
    history: options.services.history,
    checkpoints: options.services.checkpoints,
    authorizeTool: options.services.authorizeTool,
  };
  const agentOptions: AgentCreationOptions = {
    agentId: options.agent.agentId,
    definition: snapshot(options.agent.definition),
    model: snapshot(options.agent.model),
    maxSteps: options.agent.maxSteps,
    plugins: [...options.agent.plugins],
    signal: options.agent.signal,
  };
  const signal = agentOptions.signal;
  signal?.throwIfAborted();
  await binding.ensure();
  signal?.throwIfAborted();

  let application: AgentApplication | undefined;
  try {
    application = createAgentApplication(services);
    const agent = await application.agents.create(agentOptions);
    signal?.throwIfAborted();
    const ownedApplication = application;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closing) return closing;
      // 同步停止受理，再交由 Application 中断并排空执行、释放自有资源。
      closing = Promise.resolve().then(() => ownedApplication.close());
      return closing;
    };
    const ensureOpen = () => {
      if (closing) throw new AgentError("HOST_CLOSED", "会话宿主已经关闭。");
    };
    return {
      async run(input) {
        ensureOpen();
        return agent.run({
          threadId,
          queryId: input.queryId,
          runId: input.runId,
          input: input.input,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      },
      async resume(input) {
        ensureOpen();
        return agent.resume({
          threadId,
          queryId: input.queryId,
          runId: input.runId,
          ...(input.response === undefined ? {} : { response: input.response }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      },
      close,
      dispose: close,
    };
  } catch (error) {
    try {
      await application?.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "会话创建与资源回收失败。");
    }
    throw error;
  }
}
