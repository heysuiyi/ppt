import type { ModelRegistry } from "../model/model-registry";
import { AgentError } from "../protocol-errors";
import type { Disposable } from "../protocol-values";
import type { ResourceScope } from "../scope/resource-scope";
import type { ToolRegistry } from "../tools/tool-registry";
import type { AgentPlugin, PluginScope } from "./plugin-contract";
import type { PromptRegistry } from "./prompt-registry";

export async function installPlugins(
  plugins: readonly AgentPlugin[],
  parentScope: ResourceScope,
  models: ModelRegistry,
  tools: ToolRegistry,
  prompts: PromptRegistry,
): Promise<void> {
  const ids = new Set<string>();
  for (const plugin of plugins) {
    if (ids.has(plugin.id)) {
      throw new AgentError("duplicate_plugin", `Duplicate plugin: ${plugin.id}`);
    }
    ids.add(plugin.id);
  }
  const installation = parentScope.child();
  try {
    for (const plugin of plugins) {
      installation.signal.throwIfAborted();
      const scope = installation.child();
      const pluginScope: PluginScope = {
        signal: scope.signal,
        own(resource) {
          scope.own(resource);
        },
      };
      const own = (registration: Disposable): Disposable => {
        try {
          scope.own(registration);
        } catch (error) {
          // 注册移除本身同步完成；异步接口与所有其他资源一致。
          void registration.dispose();
          throw error;
        }
        return registration;
      };
      await plugin.setup({
        scope: pluginScope,
        models: {
          register(providerId, factory) {
            scope.signal.throwIfAborted();
            return own(models.register(providerId, factory));
          },
        },
        tools: {
          register(definition) {
            scope.signal.throwIfAborted();
            return own(tools.register(definition));
          },
        },
        prompts: {
          register(contribution) {
            scope.signal.throwIfAborted();
            return own(prompts.register(contribution));
          },
        },
      });
      installation.signal.throwIfAborted();
    }
  } catch (error) {
    try {
      await installation.dispose();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Plugin setup and rollback failed");
    }
    throw error;
  }
}
