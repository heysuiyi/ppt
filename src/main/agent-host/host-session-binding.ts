import type { ModelSelection } from "@agent-ppt/harness/model/model-contract";
import { AgentError } from "@agent-ppt/harness/protocol-errors";
import { snapshot } from "@agent-ppt/harness/protocol-values";
import type { ToolsMode } from "../../tools/tools";

/** 仅宿主保存的恢复边界，不进入内核协议，也不携带连接凭据或地址。 */
export interface HostSessionBinding {
  readonly schemaVersion: 2;
  readonly agentId: string;
  readonly threadId: string;
  readonly workspaceRoot: string;
  readonly toolMode: ToolsMode;
  readonly model: ModelSelection;
  readonly connectionFingerprint: string;
  readonly definition: { readonly id: string; readonly version: string };
  readonly plugins: readonly { readonly id: string; readonly version: string }[];
  readonly maxSteps: number;
}

export interface HostSessionBindingStore {
  read(threadId: string): Promise<HostSessionBinding | null>;
  ensure(binding: HostSessionBinding): Promise<void>;
}

function objectWithKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function versioned(value: unknown): value is { readonly id: string; readonly version: string } {
  return objectWithKeys(value, ["id", "version"]) && nonempty(value.id) && nonempty(value.version);
}

/** 先验证无损 JSON，再限制字段，避免意外持久化配置对象中的密钥或 endpoint。 */
export function snapshotHostSessionBinding(binding: HostSessionBinding): HostSessionBinding {
  const detached: unknown = snapshot(binding);
  if (
    detached !== null &&
    typeof detached === "object" &&
    "schemaVersion" in detached &&
    detached.schemaVersion !== 2
  ) {
    throw new AgentError(
      "HOST_BINDING_VERSION_UNSUPPORTED",
      "Host session binding version is unsupported; start a new thread.",
    );
  }
  if (
    !objectWithKeys(detached, [
      "schemaVersion",
      "agentId",
      "threadId",
      "workspaceRoot",
      "toolMode",
      "model",
      "connectionFingerprint",
      "definition",
      "plugins",
      "maxSteps",
    ]) ||
    detached.schemaVersion !== 2 ||
    !nonempty(detached.agentId) ||
    !nonempty(detached.threadId) ||
    !nonempty(detached.workspaceRoot) ||
    (detached.toolMode !== "read-only" && detached.toolMode !== "read-write") ||
    !nonempty(detached.connectionFingerprint) ||
    !Number.isSafeInteger(detached.maxSteps) ||
    (detached.maxSteps as number) <= 0 ||
    !objectWithKeys(detached.model, ["providerId", "modelId"], ["reasoningEffort"]) ||
    !nonempty(detached.model.providerId) ||
    !nonempty(detached.model.modelId) ||
    (Object.hasOwn(detached.model, "reasoningEffort") &&
      !nonempty(detached.model.reasoningEffort)) ||
    !versioned(detached.definition) ||
    !Array.isArray(detached.plugins) ||
    !detached.plugins.every(versioned)
  ) {
    throw new AgentError("HOST_BINDING_INVALID", "Host session binding is invalid.");
  }
  return detached as unknown as HostSessionBinding;
}
