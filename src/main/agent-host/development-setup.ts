import { randomUUID } from "node:crypto";
import { AgentError } from "../../agent/protocol-errors";
import {
  MIMO_TOKEN_PLAN_CN_BASE_URL,
  MIMO_TOKEN_PLAN_CN_MAX_OUTPUT_TOKENS,
  MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
  supportsMimoTokenPlanCNModel,
} from "../../models/mimo-token-plan-cn-contract";
import type {
  AgentConfigurationSnapshot,
  ConfigurationManagement,
  VendorConfiguration,
} from "../../shared/agent-configuration";
import { credentialApiKeySchema } from "../../shared/credentials";
import type { RemoteModelInfo } from "../../shared/remote-models";
import { projectDevelopmentModels } from "./development-command";

export interface DevelopmentSetupIO {
  readonly interactive: boolean;
  readLine(prompt: string): Promise<string | undefined>;
  write(text: string): Promise<void>;
}

function setupError(message: string): AgentError {
  return new AgentError("CLI_MODEL_SETUP_FAILED", message);
}

async function choose(
  io: DevelopmentSetupIO,
  title: string,
  labels: readonly string[],
): Promise<number | undefined> {
  await io.write(
    `${title}\n${labels.map((label, index) => `${index + 1}. ${label}`).join("\n")}\n0. 返回/取消\n`,
  );
  for (;;) {
    const input = await io.readLine("请选择：");
    if (input === undefined || input.trim() === "0") return undefined;
    const value = input.trim();
    if (/^[1-9]\d*$/.test(value)) {
      const index = Number(value) - 1;
      if (index < labels.length) return index;
    }
    await io.write("请输入列表中的编号，或输入 0 返回。\n");
  }
}

async function readKey(io: DevelopmentSetupIO): Promise<string | undefined> {
  await io.write("API Key 将以明文输入；仅保存到现有凭据存储，不会写入执行输出。输入 0 返回。\n");
  for (;;) {
    const input = await io.readLine("API Key：");
    if (input === undefined || input.trim() === "0") return undefined;
    const parsed = credentialApiKeySchema.safeParse(input);
    if (parsed.success) return parsed.data;
    await io.write("API Key 不能为空或超过允许长度，请重新输入。\n");
  }
}

interface ModelChoice {
  readonly model: RemoteModelInfo;
  readonly apiKey?: string;
}

async function discoverModel(
  management: ConfigurationManagement,
  io: DevelopmentSetupIO,
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
              provider: "openai",
              baseURL: MIMO_TOKEN_PLAN_CN_BASE_URL,
              modelAdapter: MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
              apiKey,
            },
      );
      models = result.models.filter(
        (model) => model.supported !== false && supportsMimoTokenPlanCNModel(model.id),
      );
    } catch {
      models = [];
      await io.write("模型发现失败，请检查连接、Key 或套餐后重试。\n");
    }
    if (models.length) {
      const index = await choose(
        io,
        "选择支持对话的模型：",
        models.map((model) => JSON.stringify(model.displayName ?? model.id)),
      );
      return index === undefined ? undefined : { model: models[index]!, apiKey };
    }
    await io.write("没有发现当前原生适配器可用的对话模型。\n");
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
  io: DevelopmentSetupIO,
  snapshot: AgentConfigurationSnapshot,
  vendor: VendorConfiguration,
  isNew: boolean,
): Promise<string | undefined> {
  let apiKey: string | undefined;
  const configured = snapshot.credentials.models.some(
    (entry) => entry.vendorId === vendor.id && entry.configured,
  );
  if (isNew || !configured) {
    apiKey = await readKey(io);
    if (apiKey === undefined) return undefined;
  }
  const localModels = vendor.models.filter((model) => supportsMimoTokenPlanCNModel(model.model));
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
        openaiApiMode: "responses" as const,
        enabled: true,
      };
  let saved: AgentConfigurationSnapshot;
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
    throw setupError("连接或凭据保存失败，CLI 默认模型未更新。请检查配置目录和凭据存储。");
  }
  if (
    !projectDevelopmentModels(saved).some(
      (entry) => entry.id === model.id && entry.status === "ready",
    )
  ) {
    throw setupError("连接已保存，但模型本地配置尚未就绪，CLI 默认模型未更新。");
  }
  try {
    await management.saveCliPreferences({ defaultModelId: model.id });
  } catch {
    throw setupError("连接已保存，但 CLI 默认模型保存失败。请检查配置目录后重试。");
  }
  await io.write("CLI 默认模型已保存。\n");
  return model.id;
}

/** 仅配置模型；不试跑请求，也不接管输入流。 */
export async function ensureDevelopmentModel(
  management: ConfigurationManagement,
  io: DevelopmentSetupIO,
  force = false,
): Promise<string | undefined> {
  let snapshot: AgentConfigurationSnapshot;
  try {
    snapshot = (await management.getSnapshot()) ?? (await management.initialize());
  } catch {
    throw setupError("无法读取或初始化模型配置，请检查配置目录。");
  }
  const defaultModelId = snapshot.settings.cli?.defaultModelId;
  if (
    !force &&
    projectDevelopmentModels(snapshot).some(
      (model) => model.id === defaultModelId && model.status === "ready",
    )
  )
    return defaultModelId;
  if (snapshot.credentials.storage.state === "unavailable") {
    throw setupError("凭据存储不可用，无法设置 CLI 模型。请先恢复系统凭据存储。");
  }
  if (!io.interactive) {
    throw setupError("没有可用的 CLI 默认模型；请先在交互终端完成模型设置。");
  }
  if (snapshot.settings.gateway.maxOutputTokens > MIMO_TOKEN_PLAN_CN_MAX_OUTPUT_TOKENS) {
    throw setupError("当前输出预算超过 MiMo 上限，请先在配置中调整输出预算。");
  }
  for (;;) {
    const vendors = snapshot.settings.vendors.filter(
      (vendor) => vendor.kind === MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
    );
    const index = await choose(io, "选择厂商/已有连接：", [
      ...vendors.map((vendor) => `${JSON.stringify(vendor.label)}（MiMo 中国）`),
      "新建 MiMo Token Plan 中国连接",
    ]);
    if (index === undefined) return undefined;
    const isNew = index === vendors.length;
    const vendor: VendorConfiguration = isNew
      ? {
          id: randomUUID(),
          kind: MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
          label: "MiMo Token Plan 中国",
          protocol: "openai",
          baseURL: MIMO_TOKEN_PLAN_CN_BASE_URL,
          enabled: true,
          models: [],
        }
      : vendors[index]!;
    const modelId = await chooseVendorModel(management, io, snapshot, vendor, isNew);
    if (modelId !== undefined) return modelId;
  }
}
