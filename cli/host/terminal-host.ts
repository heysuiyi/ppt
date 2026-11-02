import { resolve } from "node:path";
import {
  type AgentConfiguration,
  createAgentConfiguration,
} from "@agent-harness/configuration/configuration";
import type { CredentialProtection } from "@agent-harness/configuration/credential-contract";
import { createNodeCredentialProtection } from "@agent-harness/configuration/node-credentials";
import type { AgentRunHandle } from "@agent-harness/core/agent-contract";
import { AgentError } from "@agent-harness/core/protocol-errors";
import type { createModelProvider } from "@agent-harness/models/models";
import { configuredModels } from "./model-catalog.js";
import { configuredConnections, ensureConfiguredModel } from "./model-setup.js";
import { createNodeHost } from "./node-host.js";
import type {
  TerminalConnectionTarget,
  TerminalHost,
  TerminalHostOptions,
  TerminalSetupIO,
} from "./terminal-host-contract.js";

/** Explicit injection for host integrations, never exposed through CLI arguments or environment. */
export interface TerminalHostIntegrationOptions extends TerminalHostOptions {
  readonly configuration?: AgentConfiguration;
  readonly credentialProtection?: CredentialProtection;
  readonly createProvider?: typeof createModelProvider;
  readonly requireReadApproval?: boolean;
}

export function createTerminalHost(options: TerminalHostIntegrationOptions): TerminalHost {
  const lifetime = new AbortController();
  const protection =
    options.credentialProtection ?? createNodeCredentialProtection({ signal: lifetime.signal });
  const configuration =
    options.configuration ??
    createAgentConfiguration({
      applicationDataRoot: resolve(options.dataRoot),
      credentialProtection: protection,
      defaultTemplateId: "none",
      environment: {},
    });
  const node = createNodeHost({
    dataRoot: options.dataRoot,
    workspaceRoot: options.workspaceRoot,
    configuration,
    ...(options.createProvider ? { createProvider: options.createProvider } : {}),
    ...(options.requireReadApproval === undefined
      ? {}
      : { requireReadApproval: options.requireReadApproval }),
  });
  let opened = false;
  let active: AgentRunHandle | undefined;
  let transition: Promise<unknown> | undefined;
  let setupOperation: Promise<string | undefined> | undefined;
  let closing: Promise<void> | undefined;

  function ensureLive() {
    if (closing) throw new AgentError("HOST_CLOSED", "Node 宿主已经关闭。");
  }
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new AgentError("HOST_CLOSED", "Node 宿主已经关闭。"));
    if (transition || active)
      return Promise.reject(new AgentError("HOST_BUSY", "当前执行或会话切换尚未完成。"));
    const result = Promise.resolve().then(operation);
    transition = result;
    void result.then(
      () => {
        if (transition === result) transition = undefined;
      },
      () => {
        if (transition === result) transition = undefined;
      },
    );
    return result;
  }
  function track(handle: AgentRunHandle): AgentRunHandle {
    active = handle;
    void handle.completed.then(
      () => {
        if (active === handle) active = undefined;
      },
      () => {
        if (active === handle) active = undefined;
      },
    );
    return handle;
  }
  async function setupInput<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const interruption = Promise.withResolvers<never>();
    const aborted = () => interruption.reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    try {
      return await Promise.race([operation(), interruption.promise]);
    } finally {
      signal.removeEventListener("abort", aborted);
    }
  }
  function configure(
    setup: TerminalSetupIO,
    signal: AbortSignal,
    target?: TerminalConnectionTarget,
  ): Promise<string | undefined> {
    const result = (async () => {
      try {
        signal.throwIfAborted();
        return await ensureConfiguredModel(
          configuration.management,
          {
            select: (title, items) => setupInput(() => setup.select(title, items), signal),
            secret: (prompt) => setupInput(() => setup.secret(prompt), signal),
            text: (prompt) => setupInput(() => setup.text(prompt), signal),
            notify: (message) => setupInput(() => setup.notify(message), signal),
            protection,
            signal,
          },
          target,
        );
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof AgentError && error.code === "CLI_MODEL_SETUP_FAILED") throw error;
        throw new AgentError(
          "CLI_MODEL_SETUP_FAILED",
          "模型配置未完成；已保存的配置保留，当前模型与会话保持不变。",
        );
      }
    })();
    setupOperation = result;
    void result.then(
      () => {
        if (setupOperation === result) setupOperation = undefined;
      },
      () => {
        if (setupOperation === result) setupOperation = undefined;
      },
    );
    return result;
  }

  return {
    get context() {
      ensureLive();
      return node.context;
    },
    open(options) {
      return exclusive(async () => {
        if (opened) throw new AgentError("HOST_ALREADY_OPEN", "Node 宿主已经打开。");
        const signal = options.signal
          ? AbortSignal.any([lifetime.signal, options.signal])
          : lifetime.signal;
        signal.throwIfAborted();
        let modelId = options.modelId;
        // Existing threads must validate their original binding before any setup or default changes.
        if (!options.threadId && modelId === undefined) {
          const snapshot = await configuration.management.getSnapshot();
          signal.throwIfAborted();
          modelId = snapshot?.settings.cli?.defaultModelId;
          if (
            !modelId ||
            !configuredModels(snapshot).some(
              (entry) => entry.id === modelId && entry.status === "ready",
            )
          ) {
            if (!options.setup)
              throw new AgentError(
                "CLI_MODEL_SETUP_REQUIRED",
                "没有可用的 CLI 默认模型；请在安全交互终端完成配置。",
              );
            modelId = await configure(options.setup, signal);
            if (!modelId) throw new AgentError("CLI_SETUP_CANCELLED", "模型设置已取消。");
          }
        }
        signal.throwIfAborted();
        await node.open({
          ...(modelId === undefined ? {} : { modelId }),
          ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
          ...(options.toolsMode === undefined ? {} : { toolsMode: options.toolsMode }),
          signal,
        });
        opened = true;
      });
    },
    async models() {
      ensureLive();
      return node.models();
    },
    async connections() {
      ensureLive();
      return configuredConnections(await configuration.management.getSnapshot());
    },
    configureModel(setup, target) {
      return exclusive(async () => {
        // Retain the neutral host's not-open diagnostic before projecting setup failures.
        void node.context;
        try {
          if (!target) throw new AgentError("CLI_MODEL_SETUP_FAILED", "请选择要配置的连接。");
          return await configure(setup, lifetime.signal, target);
        } catch {
          lifetime.signal.throwIfAborted();
          throw new AgentError(
            "HOST_CONFIGURATION_REJECTED",
            "模型配置未完成；已保存的配置保留，当前模型与会话保持不变。",
          );
        }
      });
    },
    async sessions() {
      ensureLive();
      return node.sessions();
    },
    newSession(options) {
      return exclusive(() => node.newSession(options));
    },
    selectSession(threadId) {
      return exclusive(() => node.selectSession(threadId));
    },
    selectModel(modelId) {
      return exclusive(() => node.selectModel(modelId));
    },
    run(text) {
      return exclusive(async () => track(await node.run(text)));
    },
    resume(queryId, response) {
      return exclusive(async () => track(await node.resume(queryId, response)));
    },
    describeInteraction: (request) => node.describeInteraction(request),
    answerInteraction: (request, choiceId, confirmationId) =>
      node.answerInteraction(request, choiceId, confirmationId),
    close() {
      if (!closing) {
        closing = Promise.resolve().then(async () => {
          try {
            await setupOperation;
          } catch {
            // Setup failure remains observable by its caller; closing still owns resource cleanup.
          }
          try {
            await node.close();
          } finally {
            try {
              await transition;
            } catch {
              // The operation caller observes its own failure, not a synthetic close failure.
            }
          }
        });
        lifetime.abort(new AgentError("HOST_CLOSED", "Node 宿主已经关闭。"));
      }
      return closing;
    },
  };
}
