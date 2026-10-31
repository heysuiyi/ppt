import type {
  Agent,
  AgentDefinition,
  AgentResumeInput,
  AgentRunHandle,
  AgentRunInput,
  AgentRunResult,
} from "../agent-contract";
import type { AgentServices } from "../agent-factory";
import type { PromptRegistry } from "../extensions/prompt-registry";
import type { ModelBinding, ModelSelection } from "../model/model-contract";
import { AgentError } from "../protocol-errors";
import { type RunIdentity, snapshot } from "../protocol-values";
import type { ResourceScope } from "../scope/resource-scope";
import type { ToolExecutor } from "../tools/tool-executor";
import { RuntimeEventStream } from "./event-stream";
import { executeRun, type RunEnvironment, type RunRequest } from "./run-controller";

export interface DefaultAgentOptions {
  readonly id: string;
  readonly definition: AgentDefinition;
  readonly model: ModelSelection;
  readonly maxSteps: number;
  readonly plugins: readonly { readonly id: string; readonly version: string }[];
  readonly scope: ResourceScope;
  readonly binding: ModelBinding;
  readonly tools: ToolExecutor;
  readonly prompts: PromptRegistry;
  readonly services: AgentServices;
}

interface ActiveRun {
  readonly controller: AbortController;
  readonly completed: Promise<AgentRunResult>;
  interrupted: boolean;
}

/** 一个 Agent 只保留一个活动激活；查询续传状态由持久化端口拥有。 */
export class DefaultAgent implements Agent {
  readonly id: string;
  readonly definition: AgentDefinition;
  readonly model: ModelSelection;
  private active?: ActiveRun;
  private closing = false;
  private disposal?: Promise<void>;
  private readonly plugins: DefaultAgentOptions["plugins"];

  constructor(private readonly options: DefaultAgentOptions) {
    this.id = options.id;
    this.definition = snapshot(options.definition);
    this.model = snapshot(options.model);
    this.plugins = snapshot(options.plugins);
    const interrupt = () => {
      this.closing = true;
      this.interrupt();
    };
    options.scope.signal.addEventListener("abort", interrupt, { once: true });
    options.scope.own({
      dispose: async () => {
        this.closing = true;
        this.interrupt();
        options.scope.signal.removeEventListener("abort", interrupt);
        if (this.active) await this.active.completed;
      },
    });
  }

  run(input: AgentRunInput): Promise<AgentRunHandle> {
    return this.activate({ kind: "run", input });
  }

  resume(input: AgentResumeInput): Promise<AgentRunHandle> {
    return this.activate({ kind: "resume", input });
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closing = true;
    this.interrupt();
    this.disposal = this.options.scope.dispose();
    return this.disposal;
  }

  private interrupt(): void {
    if (!this.active) return;
    this.active.interrupted = true;
    this.active.controller.abort(new AgentError("agent-interrupted", "Agent 正在关闭。"));
  }

  private activate(request: RunRequest): Promise<AgentRunHandle> {
    try {
      if (this.closing || this.options.scope.signal.aborted) {
        throw new AgentError("agent-closed", "Agent 已关闭，不能启动执行。");
      }
      if (this.active) throw new AgentError("agent-busy", "Agent 已有活动执行。");
      // 信号是本次激活的借用对象，不进入 JSON 快照或后续激活。
      const { signal, ...data } = request.input;
      const detached = snapshot(data);
      const execution: RunRequest =
        request.kind === "run"
          ? { kind: "run", input: detached as Omit<AgentRunInput, "signal"> }
          : { kind: "resume", input: detached as Omit<AgentResumeInput, "signal"> };
      const identity: RunIdentity = Object.freeze({
        agentId: this.id,
        threadId: detached.threadId,
        queryId: detached.queryId,
        runId: detached.runId,
      });
      const scope = this.options.scope.child();
      const controller = new AbortController();
      const events = new RuntimeEventStream();
      const cancel = () => controller.abort(signal?.reason);
      const finished = Promise.withResolvers<AgentRunResult>();
      const active: ActiveRun = {
        controller,
        completed: finished.promise,
        interrupted: false,
      };
      // 在任何异步边界前保留槽位，包括尚未取得句柄的调用。
      this.active = active;
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      scope.own({
        async dispose() {
          signal?.removeEventListener("abort", cancel);
        },
      });
      const environment: RunEnvironment = {
        identity,
        definition: this.definition,
        plugins: this.plugins,
        model: this.options.binding.client,
        tools: this.options.tools,
        renderPrompt: (context) => this.options.prompts.render(context),
        checkpoints: this.options.services.checkpoints,
        history: this.options.services.history,
        maxSteps: this.options.maxSteps,
        signal: controller.signal,
        isInterrupted: () => active.interrupted,
        emit: (event) => events.emit(event),
      };
      // 观察者完全独立于执行；没有消费者也必须提交历史并释放租约。
      void Promise.resolve().then(async () => {
        let result: AgentRunResult | undefined;
        const errors: unknown[] = [];
        try {
          result = await executeRun(execution, environment);
        } catch (error) {
          errors.push(error);
        }
        try {
          await scope.dispose();
        } catch (error) {
          errors.push(error);
        }
        if (this.active === active) this.active = undefined;
        events.close();
        if (errors.length === 1) finished.reject(errors[0]);
        else if (errors.length > 1) finished.reject(new AggregateError(errors, "执行与清理失败。"));
        else finished.resolve(result!);
      });
      // 未观察 completed 不应造成进程级未处理拒绝；原 promise 仍保留失败。
      void finished.promise.catch(() => {});
      return Promise.resolve({
        identity,
        events,
        completed: finished.promise,
        cancel: (reason?: string) => {
          if (this.active === active) controller.abort(reason);
        },
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
