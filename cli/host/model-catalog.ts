import type { AgentConfigurationSnapshot } from "@agent-harness/configuration/configuration-contract";
import { getModelProfile, getModelSupport } from "@agent-harness/models/model-profiles";
import type { TerminalModelItem } from "../terminal/terminal-contract.js";
import { configuredModelAdapter, configuredModelFingerprint } from "./configured-model-factory.js";

export type ConfiguredModelStatus =
  | "ready"
  | "disabled"
  | "unsupported-adapter"
  | "unsupported-model"
  | "invalid-budget"
  | "credential-storage-unavailable"
  | "missing-credential";
export interface ConfiguredModelItem extends TerminalModelItem {
  readonly status: ConfiguredModelStatus;
  readonly connectionFingerprint?: string;
}

/** 公开配置与凭据状态足以判断本地就绪；列表不解析密钥，也不创建模型。 */
export function configuredModels(
  snapshot: AgentConfigurationSnapshot | undefined,
): readonly ConfiguredModelItem[] {
  if (!snapshot) return [];
  const configured = new Set(
    snapshot.credentials.models.filter((entry) => entry.configured).map((entry) => entry.vendorId),
  );
  return snapshot.settings.vendors.flatMap((vendor) =>
    vendor.models.map((model): ConfiguredModelItem => {
      const selection = {
        provider: vendor.protocol,
        model: model.model,
        baseURL: vendor.baseURL,
        openaiApiMode: model.openaiApiMode,
        configurationId: model.id,
        vendorId: vendor.id,
        ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
      };
      const adapterId = configuredModelAdapter(
        selection,
        vendor.kind === "mimo-token-plan-cn" ? vendor.kind : undefined,
      );
      const profile = getModelProfile(adapterId);
      const support = getModelSupport(adapterId, model.model);
      const limit = support?.supported
        ? (support.maxOutputTokens ?? profile?.maxOutputTokens)
        : undefined;
      const status: ConfiguredModelStatus =
        !vendor.enabled || !model.enabled
          ? "disabled"
          : !profile
            ? "unsupported-adapter"
            : !support?.supported ||
                (model.reasoningEffort !== undefined &&
                  !support.reasoningEfforts.includes(model.reasoningEffort))
              ? "unsupported-model"
              : limit !== undefined && snapshot.settings.gateway.maxOutputTokens > limit
                ? "invalid-budget"
                : snapshot.credentials.storage.state === "unavailable"
                  ? "credential-storage-unavailable"
                  : !configured.has(vendor.id)
                    ? "missing-credential"
                    : "ready";
      return {
        id: model.id,
        label: `${vendor.label} / ${model.name}`,
        status,
        ...(profile
          ? {
              connectionFingerprint: configuredModelFingerprint(
                model.id,
                selection,
                snapshot.settings.gateway.maxOutputTokens,
                adapterId,
              ),
            }
          : {}),
      };
    }),
  );
}
