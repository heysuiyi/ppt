import type { VendorConfiguration } from "@agent-harness/configuration/configuration-contract";
import { normalizeCredentialUrl } from "@agent-harness/configuration/credential-contract";
import { getModelProfile, getModelSupport } from "@agent-harness/models/model-profiles";

export type ConnectionAdapter =
  | "mimo-token-plan-cn"
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages";

export const connectionAdapters: readonly { value: ConnectionAdapter; label: string }[] = [
  { value: "mimo-token-plan-cn", label: "MiMo Token Plan CN" },
  { value: "openai-chat-completions", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
];

export function connectionAdapter(vendor: VendorConfiguration): ConnectionAdapter {
  if (vendor.kind === "mimo-token-plan-cn") return "mimo-token-plan-cn";
  if (vendor.protocol === "anthropic") return "anthropic-messages";
  return vendor.models[0]?.openaiApiMode === "chat-completions"
    ? "openai-chat-completions"
    : "openai-responses";
}

export function connectionURL(vendor: VendorConfiguration): string {
  const endpoint = getModelProfile(connectionAdapter(vendor))?.endpoint;
  const defaultURL = endpoint?.kind === "fixed" ? endpoint.url : endpoint?.defaultURL;
  return normalizeCredentialUrl(vendor.baseURL.trim() || defaultURL || "");
}

export function connectionBindingChanged(
  previous: VendorConfiguration,
  draft: VendorConfiguration,
): boolean {
  if (previous.protocol !== draft.protocol) return true;
  try {
    return connectionURL(previous) !== connectionURL(draft);
  } catch {
    return true;
  }
}

export function changeConnectionAdapter(
  vendor: VendorConfiguration,
  adapter: ConnectionAdapter,
): VendorConfiguration {
  const endpoint = getModelProfile(adapter)?.endpoint;
  const wasFixed = vendor.kind === "mimo-token-plan-cn";
  const baseURL =
    endpoint?.kind === "fixed"
      ? endpoint.url
      : wasFixed || !vendor.baseURL
        ? (endpoint?.defaultURL ?? "")
        : vendor.baseURL;
  return {
    ...vendor,
    kind:
      adapter === "mimo-token-plan-cn"
        ? adapter
        : adapter === "anthropic-messages"
          ? "anthropic"
          : "openai",
    protocol: adapter === "anthropic-messages" ? "anthropic" : "openai",
    baseURL,
    models: vendor.models.map((model) => ({
      ...model,
      openaiApiMode: adapter === "openai-chat-completions" ? "chat-completions" : "responses",
      ...(adapter === "mimo-token-plan-cn" ? { reasoningEffort: undefined } : {}),
    })),
  };
}

export function newConnection(): VendorConfiguration {
  return changeConnectionAdapter(
    {
      id: crypto.randomUUID(),
      kind: "custom",
      label: "",
      protocol: "openai",
      baseURL: "",
      enabled: true,
      models: [],
    },
    "openai-responses",
  );
}

export function newConnectionModel(
  vendor: VendorConfiguration,
  model = "",
  name = model,
): VendorConfiguration["models"][number] {
  return {
    id: crypto.randomUUID(),
    model,
    name,
    openaiApiMode:
      connectionAdapter(vendor) === "openai-chat-completions" ? "chat-completions" : "responses",
    enabled: true,
  };
}

/** 列表只展示连接位置，绝不回显地址里可能误填的凭据或查询参数。 */
export function connectionAddress(value: string): string {
  if (!value) return "默认地址";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "地址需要检查";
  }
}

export function modelIsSupported(
  vendor: VendorConfiguration,
  model: VendorConfiguration["models"][number],
): boolean {
  const adapter =
    vendor.kind === "mimo-token-plan-cn"
      ? vendor.kind
      : vendor.protocol === "anthropic"
        ? "anthropic-messages"
        : model.openaiApiMode === "chat-completions"
          ? "openai-chat-completions"
          : "openai-responses";
  return getModelSupport(adapter, model.model)?.supported !== false;
}
