import type { Agent } from "../agent-contract";
import type { AgentFactory, AgentServices } from "../agent-factory";
import { installPlugins } from "../extensions/plugin-manager";
import { PromptRegistry } from "../extensions/prompt-registry";
import { ModelRegistry } from "../model/model-registry";
import { AgentError, snapshot } from "../protocol-utils";
import { DefaultAgent } from "../runtime/default-agent";
import { ResourceScope } from "../scope/resource-scope";
import { ToolPipeline } from "../tools/tool-pipeline";
import { ToolRegistry } from "../tools/tool-registry";

/** 服务均为借用；只有本次绑定、注册表及插件作用域进入 Agent 的所有权树。 */
export function createDefaultAgentFactory(
  services: AgentServices,
  parentScope?: ResourceScope,
  onDisposed?: (agent: Agent) => void,
): AgentFactory {
  const reservations = new Map<string, object>();
  return {
    async create(options) {
      const creationSignal = options.signal;
      if (parentScope?.signal.aborted) {
        throw new AgentError("application-closed", "父作用域已关闭。");
      }
      if (creationSignal?.aborted) {
        throw new AgentError("agent-creation-aborted", "Agent 创建已取消。");
      }
      if (!options.agentId || !Number.isInteger(options.maxSteps) || options.maxSteps <= 0) {
        throw new AgentError("invalid-agent-options", "需要 Agent 标识和正整数执行预算。");
      }
      if (reservations.has(options.agentId)) {
        throw new AgentError("duplicate-agent", `Agent 标识已占用：${options.agentId}`);
      }
      const agentId = options.agentId;
      const reservation = {};
      reservations.set(agentId, reservation);
      let scope: ResourceScope | undefined;
      let agent: Agent | undefined;
      let abortedDisposal: Promise<void> | undefined;
      const abort = () => {
        abortedDisposal = scope?.dispose();
        // 保留原拒绝用于创建路径汇总，同时避免等待 setup 期间未处理拒绝。
        void abortedDisposal?.catch(() => {});
      };
      try {
        const definition = snapshot(options.definition);
        const selection = snapshot(options.model);
        const plugins = [...options.plugins];
        const versions = snapshot(plugins.map(({ id, version }) => ({ id, version })));
        const maxSteps = options.maxSteps;
        scope = parentScope ? parentScope.child() : new ResourceScope();
        scope.own({
          async dispose() {
            if (!agent) return;
            if (reservations.get(agentId) === reservation) reservations.delete(agentId);
            onDisposed?.(agent);
          },
        });
        creationSignal?.addEventListener("abort", abort, { once: true });
        if (creationSignal?.aborted) abort();
        const ensureOpen = () => {
          if (creationSignal?.aborted || scope!.signal.aborted) {
            throw new AgentError("agent-creation-aborted", "Agent 创建已取消。");
          }
        };
        ensureOpen();
        const models = new ModelRegistry(services.models);
        const tools = new ToolRegistry();
        const prompts = new PromptRegistry();
        scope.own(models);
        scope.own(tools);
        scope.own(prompts);
        await installPlugins(plugins, scope, models, tools, prompts);
        ensureOpen();
        const binding = await models.create(selection, scope.signal);
        // 不合作的外部工厂可能在取消后才交付绑定，不能交给已关闭的作用域。
        if (creationSignal?.aborted || scope.signal.aborted) {
          await binding.dispose();
          ensureOpen();
        }
        scope.own(binding);
        models.seal();
        tools.seal();
        prompts.seal();
        ensureOpen();
        agent = new DefaultAgent({
          id: agentId,
          definition,
          model: selection,
          maxSteps,
          plugins: versions,
          scope,
          binding,
          tools: new ToolPipeline(tools, services.authorizeTool),
          prompts,
          services,
        });
        // 创建信号只属于创建操作；发布后不再控制 Agent 的生命周期。
        creationSignal?.removeEventListener("abort", abort);
        return agent;
      } catch (error) {
        const errors: unknown[] = [error];
        try {
          await (abortedDisposal ?? scope?.dispose());
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
        if (reservations.get(agentId) === reservation) reservations.delete(agentId);
        if (errors.length > 1) throw new AggregateError(errors, "Agent 创建与回收失败。");
        throw error;
      } finally {
        creationSignal?.removeEventListener("abort", abort);
      }
    },
  };
}
