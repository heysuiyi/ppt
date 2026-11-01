import { randomUUID } from "node:crypto";
import type {
  AgentConfigurationSnapshot,
  ConfigurationManagement,
  VendorConfiguration,
} from "@agent-harness/configuration/configuration-contract";
import type { CredentialProtection } from "@agent-harness/configuration/credential-contract";
import { credentialApiKeySchema } from "@agent-harness/configuration/credential-contract";
import type { RemoteModelInfo } from "@agent-harness/configuration/remote-models";
import { AgentError } from "@agent-harness/core/protocol-errors";
import { getModelProfile, getModelSupport } from "@agent-harness/models/model-profiles";
import { configuredModelAdapter } from "./configured-model-factory.js";
import type { TerminalSetupIO } from "./host-contract.js";
import { configuredModels } from "./model-catalog.js";

const mimoProfile = getModelProfile("mimo-token-plan-cn");
if (mimoProfile?.endpoint?.kind !== "fixed")
  throw new Error("MiMo Token Plan CN requires its fixed endpoint profile.");
const mimoBaseURL = mimoProfile.endpoint.url;
const mimoMaxOutputTokens = mimoProfile.maxOutputTokens;

type SetupIO = TerminalSetupIO & {
  readonly protection: CredentialProtection;
  readonly signal: AbortSignal;
};

function setupError(message: string): AgentError {
  return new AgentError("CLI_MODEL_SETUP_FAILED", message);
}

async function choose(
  io: SetupIO,
  title: string,
  labels: readonly string[],
): Promise<number | undefined> {
  const selected = await io.select(
    title,
    labels.map((label, index) => ({ id: String(index), label })),
  );
  if (selected === undefined) return undefined;
  const index = labels.findIndex((_, index) => String(index) === selected);
  if (index < 0) throw setupError("终端返回了无效选项。");
  return index;
}

async function readKey(io: SetupIO): Promise<string | undefined> {
  io.signal.throwIfAborted();
  if ((await io.protection.inspect()).state !== "secure")
    throw setupError("系统凭据保护不可用；不会读取或保存 API Key。");
  for (;;) {
    const input = await io.secret("API Key：");
    if (input === undefined) return undefined;
    const parsed = credentialApiKeySchema.safeParse(input);
    if (parsed.success) return parsed.data;
    await io.notify("API Key 不能为空或超过允许长度，请重新输入。");
  }
}

interface ModelChoice {
  readonly model: RemoteModelInfo;
  readonly apiKey: string | undefined;
}

async function discoverModel(
  management: ConfigurationManagement,
  io: SetupIO,
  vendor: VendorConfiguration,
  initialKey: string | undefined,
): Promise<ModelChoice | undefined> {
  let apiKey = initialKey;
  for (;;) {
    let models: readonly RemoteModelInfo[];
    try {
      const result = await management.listRemoteModels(
        apiKey === undefined
          ? { type: "saved-vendor", vendorId: vendor.id }
          : {
              type: "draft",
              provider: vendor.protocol,
              baseURL: vendor.baseURL,
              ...(vendor.kind === "mimo-token-plan-cn" ? { modelAdapter: vendor.kind } : {}),
              apiKey,
            },
        io.signal,
      );
      io.signal.throwIfAborted();
      const adapterId = configuredModelAdapter(
        {
          provider: vendor.protocol,
          baseURL: vendor.baseURL,
          openaiApiMode: vendor.models[0]?.openaiApiMode,
        },
        vendor.kind === "mimo-token-plan-cn" ? vendor.kind : undefined,
      );
      models = result.models.filter(
        (model) => model.supported !== false && getModelSupport(adapterId, model.id)?.supported,
      );
    } catch {
      io.signal.throwIfAborted();
      models = [];
      await io.notify("模型发现失败，请检查连接、Key 或套餐后重试。");
    }
    if (models.length) {
      const index = await choose(
        io,
        "选择支持对话的模型：",
        models.map((model) => JSON.stringify(model.displayName ?? model.id)),
      );
      return index === undefined ? undefined : { model: models[index]!, apiKey };
    }
    await io.notify("没有发现当前原生适配器可用的对话模型。");
    const action = await choose(io, "模型发现：", ["重试", "修改 API Key"]);
    if (action === undefined) return undefined;
    if (action === 1) {
      apiKey = await readKey(io);
      if (apiKey === undefined) return undefined;
    }
  }
}

async function chooseVendorModel(
  management: ConfigurationManagement,
  io: SetupIO,
  snapshot: AgentConfigurationSnapshot,
  vendor: VendorConfiguration,
  isNew: boolean,
  apiMode: "responses" | "chat-completions" = vendor.models[0]?.openaiApiMode ??
    (vendor.kind === "openai" || vendor.kind === "mimo-token-plan-cn"
      ? "responses"
      : "chat-completions"),
): Promise<string | undefined> {
  let apiKey: string | undefined;
  const configured = snapshot.credentials.models.some(
    (entry) => entry.vendorId === vendor.id && entry.configured,
  );
  if (isNew || !configured) {
    apiKey = await readKey(io);
    if (apiKey === undefined) return undefined;
  }
  const localModels = vendor.models.filter(
    (model) =>
      getModelSupport(
        configuredModelAdapter(
          {
            provider: vendor.protocol,
            baseURL: vendor.baseURL,
            openaiApiMode: model.openaiApiMode,
          },
          vendor.kind === "mimo-token-plan-cn" ? vendor.kind : undefined,
        ),
        model.model,
      )?.supported,
  );
  let selected: RemoteModelInfo;
  let selectedLocalId: string | undefined;
  if (!isNew && localModels.length) {
    const index = await choose(io, "选择此连接的模型：", [
      ...localModels.map((model) => JSON.stringify(model.name)),
      "发现远程模型",
    ]);
    if (index === undefined) return undefined;
    if (index < localModels.length) {
      const local = localModels[index]!;
      selected = { id: local.model, displayName: local.name };
      selectedLocalId = local.id;
    } else {
      const discovered = await discoverModel(management, io, vendor, apiKey);
      if (!discovered) return undefined;
      selected = discovered.model;
      apiKey = discovered.apiKey;
    }
  } else {
    const discovered = await discoverModel(management, io, vendor, apiKey);
    if (!discovered) return undefined;
    selected = discovered.model;
    apiKey = discovered.apiKey;
  }
  const previous = vendor.models.find((model) =>
    selectedLocalId === undefined ? model.model === selected.id : model.id === selectedLocalId,
  );
  const model = previous
    ? { ...previous, enabled: true }
    : {
        id: randomUUID(),
        name: selected.displayName ?? selected.id,
        model: selected.id,
        openaiApiMode: apiMode,
        enabled: true,
      };
  let saved: AgentConfigurationSnapshot;
  io.signal.throwIfAborted();
  try {
    saved = await management.saveVendor({
      vendor: {
        ...vendor,
        enabled: true,
        models: previous
          ? vendor.models.map((entry) => (entry.id === previous.id ? model : entry))
          : [...vendor.models, model],
      },
      credential: apiKey === undefined ? { type: "keep" } : { type: "replace", apiKey },
    });
  } catch {
    io.signal.throwIfAborted();
    throw setupError("连接或凭据保存失败，CLI 默认模型未更新。请检查配置目录和凭据存储。");
  }
  io.signal.throwIfAborted();
  if (!configuredModels(saved).some((entry) => entry.id === model.id && entry.status === "ready")) {
    throw setupError("连接已保存，但模型本地配置尚未就绪，CLI 默认模型未更新。");
  }
  try {
    await management.saveCliPreferences({ defaultModelId: model.id });
  } catch {
    io.signal.throwIfAborted();
    throw setupError("连接已保存，但 CLI 默认模型保存失败。请检查配置目录后重试。");
  }
  io.signal.throwIfAborted();
  await io.notify("CLI 默认模型已保存。");
  return model.id;
}

/** 仅配置模型；不试跑请求，也不接管输入流。 */
export async function ensureConfiguredModel(
  management: ConfigurationManagement,
  io: SetupIO,
  force = false,
): Promise<string | undefined> {
  let snapshot: AgentConfigurationSnapshot;
  try {
    io.signal.throwIfAborted();
    const existing = await management.getSnapshot();
    io.signal.throwIfAborted();
    snapshot = existing ?? (await management.initialize());
    io.signal.throwIfAborted();
  } catch {
    io.signal.throwIfAborted();
    throw setupError("无法读取或初始化模型配置，请检查配置目录。");
  }
  const defaultModelId = snapshot.settings.cli?.defaultModelId;
  if (
    !force &&
    configuredModels(snapshot).some(
      (model) => model.id === defaultModelId && model.status === "ready",
    )
  )
    return defaultModelId;
  if (snapshot.credentials.storage.state === "unavailable") {
    throw setupError("凭据存储不可用，无法设置 CLI 模型。请先恢复系统凭据存储。");
  }
  const vendors = snapshot.settings.vendors;
  const index = await choose(io, "选择厂商/已有连接：", [
    ...vendors.map((vendor) => vendor.label),
    "新建 MiMo Token Plan 中国连接",
    "新建 OpenAI Responses 连接",
    "新建 OpenAI Chat Completions 兼容连接",
    "新建 Anthropic Messages 连接",
  ]);
  if (index === undefined) return undefined;
  const isNew = index >= vendors.length;
  let vendor: VendorConfiguration;
  let apiMode: "responses" | "chat-completions" | undefined;
  if (isNew) {
    const type = index - vendors.length;
    const anthropic = type === 3;
    apiMode = type === 2 ? "chat-completions" : "responses";
    const defaultURL =
      type === 0
        ? mimoBaseURL
        : anthropic
          ? "https://api.anthropic.com"
          : "https://api.openai.com/v1";
    let baseURL = defaultURL;
    if (type !== 0) {
      const input = await io.text(`API Base URL（留空使用 ${defaultURL}）：`);
      if (input === undefined) return undefined;
      try {
        const url = new URL(input.trim() || defaultURL);
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error();
        baseURL = url.href.replace(/\/+$/u, "");
      } catch {
        throw setupError("连接地址无效；请使用不含凭据、查询参数或片段的 HTTP(S) 地址。");
      }
    }
    vendor = {
      id: randomUUID(),
      kind: type === 0 ? "mimo-token-plan-cn" : anthropic ? "anthropic" : "openai",
      label:
        type === 0
          ? "MiMo Token Plan 中国"
          : anthropic
            ? "Anthropic Messages"
            : apiMode === "responses"
              ? "OpenAI Responses"
              : "OpenAI Chat Completions",
      protocol: anthropic ? "anthropic" : "openai",
      baseURL,
      enabled: true,
      models: [],
    };
  } else {
    vendor = vendors[index]!;
  }
  if (
    vendor.kind === "mimo-token-plan-cn" &&
    mimoMaxOutputTokens !== undefined &&
    snapshot.settings.gateway.maxOutputTokens > mimoMaxOutputTokens
  )
    throw setupError("当前输出预算超过 MiMo 上限，请先在配置中调整输出预算。");
  return chooseVendorModel(management, io, snapshot, vendor, isNew, apiMode);
}
