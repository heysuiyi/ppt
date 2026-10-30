import type { Agent } from "../agent-contract";
import type { AgentFactory, AgentServices } from "../agent-factory";
import { AgentError } from "../protocol-utils";
import type { Disposable } from "../protocol-values";
import { ResourceScope } from "../scope/resource-scope";
import { createDefaultAgentFactory } from "./default-agent-factory";

export interface AgentApplication extends Disposable {
  readonly agents: AgentFactory;
  close(): Promise<void>;
}

interface AgentEntry {
  readonly controller: AbortController;
  readonly operation: Promise<Agent>;
  agent?: Agent;
}

/** 显式的组合根：关闭时先停止创建与执行，再释放作用域，不接管宿主服务。 */
export function createAgentApplication(services: AgentServices): AgentApplication {
  const scope = new ResourceScope();
  const entries = new Map<string, AgentEntry>();
  let closing = false;
  let disposal: Promise<void> | undefined;
  const factory = createDefaultAgentFactory(services, scope, (agent) => {
    if (entries.get(agent.id)?.agent === agent) entries.delete(agent.id);
  });
  const agents: AgentFactory = {
    create(options) {
      if (closing) return Promise.reject(new AgentError("application-closed", "应用正在关闭。"));
      if (entries.has(options.agentId)) {
        return Promise.reject(
          new AgentError("duplicate-agent", `Agent 标识已占用：${options.agentId}`),
        );
      }
      const agentId = options.agentId;
      const controller = new AbortController();
      const creationSignal = options.signal;
      const abort = () => controller.abort(creationSignal?.reason);
      const completed = Promise.withResolvers<Agent>();
      const entry: AgentEntry = { controller, operation: completed.promise };
      // 先同步保留 ID，异步 setup 尚未开始也不能让第二次创建穿透。
      entries.set(agentId, entry);
      if (creationSignal?.aborted) abort();
      else creationSignal?.addEventListener("abort", abort, { once: true });
      void factory
        .create({ ...options, signal: controller.signal })
        .then(async (agent) => {
          if (closing || controller.signal.aborted) {
            await agent.dispose();
            throw new AgentError("agent-creation-aborted", "Agent 发布前创建已取消。");
          }
          // 从容器记录到 promise 发布之间不能留下额外的异步窗口。
          creationSignal?.removeEventListener("abort", abort);
          entry.agent = agent;
          completed.resolve(agent);
        })
        .catch((error: unknown) => {
          creationSignal?.removeEventListener("abort", abort);
          if (entries.get(agentId) === entry) entries.delete(agentId);
          completed.reject(error);
        });
      return completed.promise;
    },
  };
  const close = (): Promise<void> => {
    if (disposal) return disposal;
    closing = true;
    const finished = Promise.withResolvers<void>();
    disposal = finished.promise;
    const pending: Promise<unknown>[] = [];
    const creating = new Set<Promise<unknown>>();
    for (const entry of entries.values()) {
      if (entry.agent) pending.push(entry.agent.dispose());
      else {
        entry.controller.abort(new AgentError("application-closed", "应用关闭取消未发布的创建。"));
        pending.push(entry.operation);
        creating.add(entry.operation);
      }
    }
    void (async () => {
      const settled = await Promise.allSettled(pending);
      const errors: unknown[] = [];
      for (let index = 0; index < settled.length; index++) {
        const result = settled[index];
        if (result.status !== "rejected") continue;
        const cancelledCreation = creating.has(pending[index]);
        // 创建的取消是关闭协议的一部分；聚合错误仍包含必须报告的回收失败。
        if (!cancelledCreation || result.reason instanceof AggregateError)
          errors.push(result.reason);
      }
      try {
        await scope.dispose();
      } catch (error) {
        errors.push(error);
      }
      entries.clear();
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "应用关闭失败。");
    })().then(finished.resolve, finished.reject);
    return disposal;
  };
  return { agents, close, dispose: close };
}
