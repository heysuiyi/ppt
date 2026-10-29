import type { DiscoverAgentModelsRequest } from "@shared/agent-configuration";
import { normalizeCredentialUrl } from "@shared/credentials";
import type { RemoteModelInfo } from "@shared/remote-models";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildCustomVendorDraft,
  buildVendorDraftFromPreset,
  changeModelVendorDraftProtocol,
  createCatalogEntriesFromRemoteIds,
  getModelVendorPreset,
  type ManagedModel,
  MODEL_VENDOR_PRESETS,
  type ModelCatalogEntry,
  type ModelTokenPricing,
  type ModelVendorConnection,
  type ModelVendorDraft,
  materializeVendorDraft,
  type PresetVendorKind,
  type VendorKind,
} from "../modelCatalog";
import { Edit3Icon, PlusIcon, RefreshIcon, TrashIcon } from "./Icons";
import { Select } from "./Select";

interface ModelManagementProps {
  vendors: ModelVendorConnection[];
  models: ManagedModel[];
  selectedModelId: string;
  onSelectModel: (id: string) => void;
  onSaveVendor: (vendor: ModelVendorConnection, apiKey?: string) => Promise<boolean>;
  onDeleteVendor: (vendorId: string) => Promise<boolean>;
  onDeleteModel: (modelId: string) => Promise<boolean>;
  onSetVendorEnabled: (vendorId: string, enabled: boolean) => Promise<boolean>;
  onSetModelEnabled: (modelId: string, enabled: boolean) => Promise<boolean>;
  triggerToast: (message: string) => void;
}

const VENDOR_KIND_OPTIONS = [
  ...MODEL_VENDOR_PRESETS.map((preset) => ({
    value: preset.id,
    label: preset.label,
    hint: preset.hint,
  })),
  { value: "custom" as const, label: "自定义兼容服务", hint: "手动配置兼容端点" },
];

function validHttpURL(value: string): boolean {
  try {
    normalizeCredentialUrl(value);
    return true;
  } catch {
    return false;
  }
}

function emptyPricing(): ModelTokenPricing {
  return {
    currency: "CNY",
    inputPerMillion: 0,
    cachedInputPerMillion: 0,
    outputPerMillion: 0,
    updatedAt: new Date().toISOString().slice(0, 10),
  };
}

function validPricing(pricing: ModelCatalogEntry["pricing"]): boolean {
  if (!pricing) return true;
  return (
    [pricing.inputPerMillion, pricing.cachedInputPerMillion, pricing.outputPerMillion].every(
      (value) => Number.isFinite(value) && value >= 0,
    ) &&
    (pricing.cacheCreationInputPerMillion === undefined ||
      (Number.isFinite(pricing.cacheCreationInputPerMillion) &&
        pricing.cacheCreationInputPerMillion >= 0))
  );
}

function catalogModelKey(modelId: string): string {
  return modelId.trim().toLowerCase();
}

function dedupeCatalogModels(models: readonly ModelCatalogEntry[]): ModelCatalogEntry[] {
  const seen = new Map<string, ModelCatalogEntry>();
  for (const model of models) {
    const key = catalogModelKey(model.model);
    if (!key || seen.has(key)) continue;
    seen.set(key, model);
  }
  return [...seen.values()];
}

function protocolLabel(protocol: string): string {
  return protocol === "anthropic" ? "Anthropic" : "OpenAI";
}

export function ModelManagement({
  vendors,
  models,
  selectedModelId,
  onSelectModel,
  onSaveVendor,
  onDeleteVendor,
  onDeleteModel,
  onSetVendorEnabled,
  onSetModelEnabled,
  triggerToast,
}: ModelManagementProps) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<ModelVendorDraft | null>(null);
  const [kindPickerOpen, setKindPickerOpen] = useState(false);
  const [dialogApiKey, setDialogApiKey] = useState("");
  const [credentialPending, setCredentialPending] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [remoteModels, setRemoteModels] = useState<RemoteModelInfo[]>([]);
  const [remoteSelectedIds, setRemoteSelectedIds] = useState<string[]>([]);
  const [remoteQuery, setRemoteQuery] = useState("");
  const [remotePending, setRemotePending] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const dialogVisible = Boolean(draft) || kindPickerOpen;

  const filteredVendors = useMemo(() => {
    if (!normalizedQuery) return vendors;
    return vendors.filter((vendor) => {
      if (
        `${vendor.label} ${vendor.kind} ${vendor.baseURL}`.toLowerCase().includes(normalizedQuery)
      )
        return true;
      return vendor.models.some((model) =>
        `${model.name} ${model.model}`.toLowerCase().includes(normalizedQuery),
      );
    });
  }, [vendors, normalizedQuery]);

  const filteredRemoteModels = useMemo(() => {
    const normalized = remoteQuery.trim().toLowerCase();
    if (!normalized) return remoteModels;
    return remoteModels.filter((model) =>
      `${model.id} ${model.displayName ?? ""}`.toLowerCase().includes(normalized),
    );
  }, [remoteModels, remoteQuery]);

  const closeDialog = () => {
    setDraft(null);
    setKindPickerOpen(false);
    setDialogApiKey("");
    setCredentialPending(false);
    setAdvancedOpen(false);
    setRemoteModels([]);
    setRemoteSelectedIds([]);
    setRemoteQuery("");
    setRemotePending(false);
  };
  const closeDialogRef = useRef(closeDialog);
  closeDialogRef.current = closeDialog;

  useEffect(() => {
    if (!dialogVisible) {
      const previous = returnFocusRef.current;
      returnFocusRef.current = null;
      previous?.focus();
      return;
    }
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    focusables[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialogRef.current();
        return;
      }
      if (event.key !== "Tab" || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dialogVisible]);

  const openAddKindPicker = () => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    setKindPickerOpen(true);
  };

  const startAddVendor = (kind: VendorKind) => {
    const existingPreset =
      kind !== "custom" ? vendors.find((vendor) => vendor.kind === kind) : undefined;
    if (existingPreset) {
      triggerToast(`${existingPreset.label} 已添加，请直接编辑`);
      setKindPickerOpen(false);
      openEditVendor(existingPreset);
      return;
    }
    const next = kind === "custom" ? buildCustomVendorDraft() : buildVendorDraftFromPreset(kind);
    setDraft(next);
    setDialogApiKey("");
    setAdvancedOpen(kind === "custom");
    setRemoteModels([]);
    setRemoteSelectedIds(next.models.map((model) => model.model));
    setKindPickerOpen(false);
  };

  const openEditVendor = (vendor: ModelVendorConnection) => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    const next =
      vendor.kind === "custom"
        ? buildCustomVendorDraft(vendor)
        : buildVendorDraftFromPreset(vendor.kind as PresetVendorKind, vendor);
    setDraft(next);
    setDialogApiKey("");
    setAdvancedOpen(vendor.kind === "custom");
    setRemoteModels([]);
    setRemoteSelectedIds(vendor.models.map((model) => model.model));
  };

  const updateDraft = (patch: Partial<ModelVendorDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const updateDraftModel = (id: string, patch: Partial<ModelCatalogEntry>) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            models: current.models.map((model) =>
              model.id === id ? { ...model, ...patch } : model,
            ),
          }
        : current,
    );
  };

  const removeDraftModel = async (modelId: string) => {
    if (!draft) return;
    if (!draft.isNew) {
      const deleted = await onDeleteModel(modelId);
      if (!deleted) return;
    }
    setDraft({
      ...draft,
      models: draft.models.filter((model) => model.id !== modelId),
    });
    setRemoteSelectedIds((current) => {
      const removed = draft.models.find((model) => model.id === modelId)?.model;
      return removed ? current.filter((id) => id !== removed) : current;
    });
    triggerToast("模型已删除");
  };

  const fetchRemoteModels = async () => {
    if (!draft) return;
    if (!draft.baseURL.trim() || !validHttpURL(draft.baseURL)) {
      triggerToast("请填写有效的 Base URL");
      return;
    }
    const apiKey = dialogApiKey.trim();
    const existing = vendors.find((vendor) => vendor.id === draft.id);
    const canUseSavedCredential =
      existing?.credentialConfigured === true &&
      existing.protocol === draft.protocol &&
      validHttpURL(existing.baseURL) &&
      normalizeCredentialUrl(existing.baseURL) === normalizeCredentialUrl(draft.baseURL);
    if (!apiKey && !canUseSavedCredential) {
      triggerToast("请先填写 API Key；连接地址变更后不能使用已保存的 Key");
      return;
    }
    setRemotePending(true);
    try {
      const request: DiscoverAgentModelsRequest = apiKey
        ? { type: "draft", provider: draft.protocol, baseURL: draft.baseURL.trim(), apiKey }
        : { type: "saved-vendor", vendorId: draft.id };
      const result = await window.desktopApi.listRemoteModels(request);
      setRemoteModels(result.models);
      setRemoteSelectedIds(draft.models.map((model) => model.model));
      triggerToast(`已获取 ${result.models.length} 个远程模型`);
    } catch (error) {
      triggerToast(`获取模型列表失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRemotePending(false);
    }
  };

  const applyRemoteSelection = (selectedIds: string[]) => {
    if (!draft) return;
    setRemoteSelectedIds(selectedIds);
    if (remoteModels.length === 0) return;

    const byApiId = new Map(
      draft.models.map((model) => [catalogModelKey(model.model), model] as const),
    );
    const nextModels: ModelCatalogEntry[] = [];
    const seen = new Set<string>();
    for (const remote of remoteModels) {
      if (!selectedIds.includes(remote.id)) continue;
      const key = catalogModelKey(remote.id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const existing = byApiId.get(key);
      nextModels.push(existing ?? createCatalogEntriesFromRemoteIds([remote], draft.protocol)[0]!);
    }
    updateDraft({ models: nextModels });
  };

  const saveDraft = async () => {
    if (!draft) return;
    if (!draft.baseURL.trim() || !validHttpURL(draft.baseURL)) {
      triggerToast("请填写有效的 Base URL");
      return;
    }
    if (draft.models.length === 0) {
      triggerToast("请至少选择一个模型");
      return;
    }
    if (draft.models.some((model) => !model.model.trim() || !model.name.trim())) {
      triggerToast("请填写模型名称与 Model ID");
      return;
    }
    if (draft.models.some((model) => !validPricing(model.pricing))) {
      triggerToast("请填写有效的非负模型单价");
      return;
    }
    const existing = vendors.find((vendor) => vendor.id === draft.id);
    const apiKey = dialogApiKey.trim();
    if (!apiKey && !existing?.credentialConfigured) {
      triggerToast("请填写 API Key");
      return;
    }

    setCredentialPending(true);
    try {
      const vendor = materializeVendorDraft({
        ...draft,
        models: dedupeCatalogModels(draft.models),
      });
      const saved = await onSaveVendor(vendor, apiKey || undefined);
      if (!saved) return;
      if (vendor.models[0] && (!selectedModelId || draft.isNew)) {
        onSelectModel(vendor.models[0].id);
      }
      triggerToast(`${vendor.label} 已保存`);
      closeDialog();
    } finally {
      setCredentialPending(false);
    }
  };

  const deleteCurrentVendor = async () => {
    if (!draft || draft.isNew) return;
    const deleted = await onDeleteVendor(draft.id);
    if (!deleted) return;
    triggerToast("厂商已删除");
    closeDialog();
  };

  const renderPricingFields = (model: ModelCatalogEntry) => {
    const pricing = model.pricing ?? emptyPricing();
    const currency = pricing.currency;
    return (
      <div className="model-pricing-grid">
        <label className="model-pricing-currency">
          <span>计价货币</span>
          <Select
            aria-label={`${model.name} 计价货币`}
            value={currency}
            options={[
              { value: "CNY", label: "CNY" },
              { value: "USD", label: "USD" },
            ]}
            onChange={(value) =>
              updateDraftModel(model.id, {
                pricing: { ...pricing, currency: value as "CNY" | "USD" },
              })
            }
          />
        </label>
        <label>
          <span>普通输入 / 百万 tokens</span>
          <input
            type="number"
            min={0}
            step="any"
            aria-label={`${model.name} 普通输入单价`}
            value={Number.isFinite(pricing.inputPerMillion) ? pricing.inputPerMillion : ""}
            onChange={(event) =>
              updateDraftModel(model.id, {
                pricing: {
                  ...pricing,
                  inputPerMillion:
                    event.target.value === "" ? Number.NaN : Number(event.target.value),
                },
              })
            }
          />
        </label>
        <label>
          <span>缓存命中输入 / 百万 tokens</span>
          <input
            type="number"
            min={0}
            step="any"
            value={
              Number.isFinite(pricing.cachedInputPerMillion) ? pricing.cachedInputPerMillion : ""
            }
            onChange={(event) =>
              updateDraftModel(model.id, {
                pricing: {
                  ...pricing,
                  cachedInputPerMillion:
                    event.target.value === "" ? Number.NaN : Number(event.target.value),
                },
              })
            }
          />
        </label>
        <label>
          <span>输出 / 百万 tokens</span>
          <input
            type="number"
            min={0}
            step="any"
            value={Number.isFinite(pricing.outputPerMillion) ? pricing.outputPerMillion : ""}
            onChange={(event) =>
              updateDraftModel(model.id, {
                pricing: {
                  ...pricing,
                  outputPerMillion:
                    event.target.value === "" ? Number.NaN : Number(event.target.value),
                },
              })
            }
          />
        </label>
        <small className="model-pricing-hint">留空单价视为未配置；保存时需为有效非负数。</small>
      </div>
    );
  };

  return (
    <div className="model-management-layout">
      <div className="cursor-model-card">
        <div className="cursor-model-search-row">
          <input
            className="cursor-model-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索厂商或模型"
            aria-label="搜索厂商或模型"
          />
          <button
            type="button"
            className="cursor-model-icon-btn"
            aria-label="刷新"
            onClick={() => setQuery("")}
          >
            <RefreshIcon />
          </button>
        </div>
        <button type="button" className="cursor-model-add-btn" onClick={openAddKindPicker}>
          <PlusIcon />
          添加厂商
        </button>

        <div className="vendor-card-list">
          {filteredVendors.length === 0 ? (
            <p className="model-empty-hint">尚未配置厂商。点击「添加厂商」开始。</p>
          ) : (
            filteredVendors.map((vendor) => {
              const enabledCount = vendor.models.filter((model) => model.enabled !== false).length;
              return (
                <article key={vendor.id} className="vendor-card">
                  <div className="vendor-card-main">
                    <div className="vendor-card-title-row">
                      <h4>{vendor.label}</h4>
                      <span className="vendor-card-badge">{protocolLabel(vendor.protocol)}</span>
                    </div>
                    <p className="vendor-card-meta">
                      {vendor.baseURL || "未设置 Base URL"} · {enabledCount}/{vendor.models.length}{" "}
                      个模型启用
                      {vendor.credentialConfigured ? " · 凭据已配置" : " · 需要 API Key"}
                    </p>
                    <ul className="vendor-model-chips">
                      {vendor.models.map((model) => {
                        const flat = models.find((item) => item.id === model.id);
                        const selected = selectedModelId === model.id;
                        return (
                          <li key={model.id}>
                            <button
                              type="button"
                              className={`vendor-model-chip${selected ? " is-selected" : ""}${
                                model.enabled === false ? " is-disabled" : ""
                              }`}
                              onClick={() => onSelectModel(model.id)}
                              title={model.model}
                            >
                              {model.name}
                              {flat?.credentialConfigured && model.enabled !== false ? "" : ""}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  <div className="vendor-card-actions">
                    <label className="vendor-enable-toggle">
                      <input
                        type="checkbox"
                        checked={vendor.enabled !== false}
                        onChange={(event) => {
                          void onSetVendorEnabled(vendor.id, event.target.checked);
                        }}
                        aria-label={`启用厂商 ${vendor.label}`}
                      />
                      <span>启用</span>
                    </label>
                    <button
                      type="button"
                      className="cursor-model-icon-btn"
                      aria-label={`编辑厂商 ${vendor.label}`}
                      onClick={() => openEditVendor(vendor)}
                    >
                      <Edit3Icon />
                    </button>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </div>

      {dialogVisible ? (
        <div className="model-dialog-backdrop" role="presentation" onMouseDown={closeDialog}>
          <section
            ref={dialogRef}
            className="model-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={kindPickerOpen ? "选择厂商" : draft?.isNew ? "添加厂商" : "编辑厂商"}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="model-dialog-header">
              <div>
                <h3>{kindPickerOpen ? "选择厂商" : draft?.isNew ? "添加厂商" : "编辑厂商"}</h3>
                <p>
                  {kindPickerOpen
                    ? "选择要添加的模型服务商"
                    : "配置连接、获取并多选模型；高级设置可调整单价与 API 模式。"}
                </p>
              </div>
              <button
                type="button"
                className="model-dialog-close-btn"
                aria-label="关闭"
                onClick={closeDialog}
              >
                ×
              </button>
            </header>

            <div className="model-dialog-body">
              {kindPickerOpen ? (
                <div className="vendor-kind-picker">
                  {VENDOR_KIND_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="vendor-kind-option"
                      onClick={() => startAddVendor(option.value)}
                    >
                      <strong>{option.label}</strong>
                      <span>{option.hint}</span>
                    </button>
                  ))}
                </div>
              ) : draft ? (
                <div className="model-dialog-form">
                  <label>
                    <span>显示名称</span>
                    <input
                      value={draft.label}
                      onChange={(event) => updateDraft({ label: event.target.value })}
                    />
                  </label>

                  {(draft.kind === "deepseek" || draft.kind === "custom") && (
                    <label>
                      <span>协议</span>
                      <Select
                        aria-label="协议"
                        value={draft.protocol}
                        options={(
                          getModelVendorPreset(draft.kind)?.supportedProviders ?? [
                            "openai",
                            "anthropic",
                          ]
                        ).map((provider) => ({
                          value: provider,
                          label: protocolLabel(provider),
                        }))}
                        onChange={(value) =>
                          setDraft(
                            changeModelVendorDraftProtocol(draft, value as "openai" | "anthropic"),
                          )
                        }
                      />
                    </label>
                  )}

                  <label>
                    <span>Base URL</span>
                    <input
                      value={draft.baseURL}
                      onChange={(event) => updateDraft({ baseURL: event.target.value })}
                      placeholder="https://"
                    />
                  </label>

                  <label>
                    <span>API Key</span>
                    <input
                      type="password"
                      autoComplete="off"
                      value={dialogApiKey}
                      onChange={(event) => setDialogApiKey(event.target.value)}
                      placeholder={
                        vendors.find((vendor) => vendor.id === draft.id)?.credentialConfigured
                          ? "已配置，留空则保留"
                          : "填写 API Key"
                      }
                    />
                  </label>

                  <div className="model-remote-toolbar">
                    <button
                      type="button"
                      className="model-secondary-btn"
                      disabled={remotePending}
                      onClick={() => void fetchRemoteModels()}
                    >
                      {remotePending ? "获取中…" : "获取模型列表"}
                    </button>
                    <small className="model-pricing-hint">
                      勾选后写入下方已选模型；可同时选择多个。
                    </small>
                  </div>

                  {remoteModels.length > 0 ? (
                    <div className="model-remote-picker">
                      <input
                        className="cursor-model-search"
                        value={remoteQuery}
                        onChange={(event) => setRemoteQuery(event.target.value)}
                        placeholder="筛选远程模型"
                        aria-label="筛选远程模型"
                      />
                      <ul className="model-remote-list">
                        {filteredRemoteModels.map((model) => {
                          const checked = remoteSelectedIds.includes(model.id);
                          return (
                            <li key={model.id}>
                              <label className="model-remote-option">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => {
                                    const next = checked
                                      ? remoteSelectedIds.filter((id) => id !== model.id)
                                      : [...remoteSelectedIds, model.id];
                                    applyRemoteSelection(next);
                                  }}
                                />
                                <span>
                                  <strong>{model.displayName ?? model.id}</strong>
                                  {model.displayName ? <small>{model.id}</small> : null}
                                </span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}

                  <div className="model-selected-list">
                    <h4>已选模型（{draft.models.length}）</h4>
                    {draft.models.length === 0 ? (
                      <p className="model-empty-hint">请获取列表后勾选，或在高级设置中手动添加。</p>
                    ) : (
                      draft.models.map((model) => (
                        <div key={model.id} className="model-selected-row">
                          <div className="model-selected-row-main">
                            <strong>{model.name}</strong>
                            <span>{model.model}</span>
                          </div>
                          <label className="vendor-enable-toggle">
                            <input
                              type="checkbox"
                              checked={model.enabled !== false}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                updateDraftModel(model.id, { enabled });
                                if (!draft.isNew) {
                                  void onSetModelEnabled(model.id, enabled);
                                }
                              }}
                              aria-label={`启用模型 ${model.name}`}
                            />
                            <span>启用</span>
                          </label>
                          <button
                            type="button"
                            className="cursor-model-icon-btn"
                            aria-label={`删除模型 ${model.name}`}
                            onClick={() => void removeDraftModel(model.id)}
                          >
                            <TrashIcon />
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  <button
                    type="button"
                    className={`model-vendor-advanced-toggle${advancedOpen ? " is-open" : ""}`}
                    onClick={() => setAdvancedOpen((open) => !open)}
                    aria-expanded={advancedOpen}
                  >
                    <span>高级设置</span>
                    <span>{advancedOpen ? "收起" : "展开"}</span>
                  </button>

                  {advancedOpen ? (
                    <div className="model-vendor-advanced">
                      {draft.kind === "custom" ? (
                        <button
                          type="button"
                          className="model-secondary-btn"
                          onClick={() => {
                            const entries = createCatalogEntriesFromRemoteIds(
                              [{ id: `manual-${crypto.randomUUID()}`, displayName: "手动模型" }],
                              draft.protocol,
                            );
                            updateDraft({
                              models: [
                                ...draft.models,
                                {
                                  ...entries[0]!,
                                  model: "",
                                  name: "手动模型",
                                },
                              ],
                            });
                          }}
                        >
                          手动添加模型
                        </button>
                      ) : null}
                      {draft.models.map((model) => (
                        <div key={model.id} className="model-advanced-block">
                          <label>
                            <span>显示名称</span>
                            <input
                              value={model.name}
                              onChange={(event) =>
                                updateDraftModel(model.id, { name: event.target.value })
                              }
                            />
                          </label>
                          <label>
                            <span>Model ID</span>
                            <input
                              value={model.model}
                              onChange={(event) =>
                                updateDraftModel(model.id, { model: event.target.value })
                              }
                            />
                          </label>
                          {draft.protocol === "openai" ? (
                            <label>
                              <span>OpenAI API 模式</span>
                              <Select
                                aria-label={`${model.name} API 模式`}
                                value={model.openaiApiMode}
                                options={[
                                  { value: "responses", label: "Responses" },
                                  { value: "chat-completions", label: "Chat Completions" },
                                ]}
                                onChange={(value) =>
                                  updateDraftModel(model.id, {
                                    openaiApiMode: value as ModelCatalogEntry["openaiApiMode"],
                                  })
                                }
                              />
                            </label>
                          ) : null}
                          <label className="vendor-enable-toggle">
                            <input
                              type="checkbox"
                              checked={model.supports1MContext === true}
                              onChange={(event) =>
                                updateDraftModel(model.id, {
                                  supports1MContext: event.target.checked,
                                })
                              }
                            />
                            <span>声明支持 1M 上下文</span>
                          </label>
                          <label className="vendor-enable-toggle">
                            <input
                              type="checkbox"
                              checked={model.pricing != null}
                              onChange={(event) =>
                                updateDraftModel(model.id, {
                                  pricing: event.target.checked ? emptyPricing() : null,
                                })
                              }
                            />
                            <span>配置单价</span>
                          </label>
                          {model.pricing ? renderPricingFields(model) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            {!kindPickerOpen && draft ? (
              <footer className="model-dialog-footer">
                {!draft.isNew ? (
                  <button
                    type="button"
                    className="model-dialog-danger-btn"
                    disabled={credentialPending}
                    onClick={() => void deleteCurrentVendor()}
                  >
                    删除厂商
                  </button>
                ) : (
                  <span />
                )}
                <div className="model-dialog-actions">
                  <button type="button" className="model-secondary-btn" onClick={closeDialog}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="model-primary-btn"
                    disabled={credentialPending}
                    onClick={() => void saveDraft()}
                  >
                    {credentialPending ? "保存中…" : "保存"}
                  </button>
                </div>
              </footer>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}
