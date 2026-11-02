import {
  type DiscoverAgentModelsRequest,
  discoverAgentModelsSchema,
  type SaveAgentVendorRequest,
  saveAgentVendorSchema,
  type VendorConfiguration,
} from "@agent-harness/configuration/configuration-contract";
import { normalizeCredentialUrl } from "@agent-harness/configuration/credential-contract";
import type { RemoteModelInfo } from "@agent-harness/configuration/remote-models";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { Alert } from "../ui/components/alert/Alert";
import { Button } from "../ui/components/button/Button";
import { Dialog } from "../ui/components/dialog/Dialog";
import { Field } from "../ui/components/field/Field";
import { Input } from "../ui/components/input/Input";
import { Select } from "../ui/components/select/Select";
import { UnsavedChangesDialog } from "../ui/patterns/UnsavedChangesDialog";
import {
  type ConnectionAdapter,
  changeConnectionAdapter,
  connectionAdapter,
  connectionAdapters,
  connectionBindingChanged,
  connectionURL,
  modelIsSupported,
  newConnectionModel,
} from "./desktop-settings-model";

interface DesktopConnectionFormProps {
  vendor: VendorConfiguration;
  existing: boolean;
  configured: boolean;
  storageAvailable: boolean;
  pending: boolean;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onSave: (request: SaveAgentVendorRequest) => Promise<boolean>;
  onClose: () => void;
}

type CredentialAction = "keep" | "replace" | "remove";

export function DesktopConnectionForm({
  vendor,
  existing,
  configured,
  storageAvailable,
  pending,
  fallbackFocusRef,
  onSave,
  onClose,
}: DesktopConnectionFormProps) {
  const [draft, setDraft] = useState(vendor);
  // 配置协议的 API 模式属于模型；空连接也必须保留用户刚选的创建模式。
  const [adapter, setAdapter] = useState<ConnectionAdapter>(() => connectionAdapter(vendor));
  const [credentialAction, setCredentialAction] = useState<CredentialAction>(
    existing ? "keep" : "replace",
  );
  const [keyEdited, setKeyEdited] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [failure, setFailure] = useState("");
  const [fieldError, setFieldError] = useState<{ name?: string; address?: string; key?: string }>(
    {},
  );
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<RemoteModelInfo[] | null>(null);
  const [discoveryError, setDiscoveryError] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const prefix = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const discoveryRequest = useRef(0);
  const active = useRef(true);
  const saving = useRef(false);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(vendor) ||
    keyEdited ||
    credentialAction !== (existing ? "keep" : "replace");
  const createModel = (model = "", name = model) => ({
    ...newConnectionModel(draft, model, name),
    openaiApiMode:
      adapter === "openai-chat-completions"
        ? ("chat-completions" as const)
        : ("responses" as const),
  });
  const bindingChanged = connectionBindingChanged(vendor, draft);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      discoveryRequest.current += 1;
      if (keyRef.current) keyRef.current.value = "";
    };
  }, []);

  useEffect(() => {
    if (!dirty && !pending) return;
    const preventLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLeave);
    return () => window.removeEventListener("beforeunload", preventLeave);
  }, [dirty, pending]);

  const invalidateDiscovery = () => {
    discoveryRequest.current += 1;
    setDiscovering(false);
    setDiscovery(null);
    setDiscoveryError("");
  };
  const update = (next: VendorConfiguration) => {
    setDraft(next);
    setFieldError({});
    setFailure("");
    invalidateDiscovery();
  };
  const close = () => {
    if (pending || saving.current) return;
    if (dirty) setLeaving(true);
    else onClose();
  };

  const save = async () => {
    if (pending || saving.current) return;
    setFailure("");
    const errors: typeof fieldError = {};
    if (!draft.label.trim()) errors.name = "请输入连接名称。";
    let baseURL = draft.baseURL;
    try {
      if (baseURL.trim()) baseURL = normalizeCredentialUrl(baseURL);
    } catch {
      errors.address = "请输入 HTTPS 地址（本机服务可用 HTTP），不要在地址中嵌入用户名或密码。";
    }
    const apiKey = keyRef.current?.value.trim() ?? "";
    if (credentialAction === "replace" && !apiKey)
      errors.key = "请输入新的 API Key，或改为不配置凭据。";
    if (credentialAction === "keep" && bindingChanged && configured) {
      errors.key = "地址或协议已改变，原凭据不会用于新连接。请重新输入 Key，或明确移除凭据。";
    }
    setFieldError(errors);
    if (errors.name || errors.address || errors.key) {
      (errors.name ? nameRef : errors.address ? addressRef : keyRef).current?.focus();
      return;
    }
    const parsed = saveAgentVendorSchema.safeParse({
      vendor: { ...draft, baseURL },
      credential:
        credentialAction === "replace" ? { type: "replace", apiKey } : { type: credentialAction },
    });
    if (!parsed.success) {
      setFailure(
        "请检查连接名称、地址和每个模型的标识/显示名称；模型标识与显示名称不能为空，Key 不得超过 16384 个字符。",
      );
      nameRef.current?.focus();
      return;
    }
    discoveryRequest.current += 1;
    setDiscovering(false);
    saving.current = true;
    try {
      const saved = await onSave(parsed.data);
      if (!active.current) return;
      if (saved) {
        if (keyRef.current) keyRef.current.value = "";
        onClose();
      } else {
        setFailure(
          "未能保存连接。输入仍保留；请检查凭据存储、配置目录权限和连接设置后重试，或关闭后重新加载确认状态。",
        );
      }
    } finally {
      saving.current = false;
    }
  };

  const discover = async () => {
    if (pending || discovering) return;
    const requestId = ++discoveryRequest.current;
    setDiscoveryError("");
    setDiscovery(null);
    let request: DiscoverAgentModelsRequest;
    try {
      if (existing && !bindingChanged && credentialAction === "keep") {
        request = { type: "saved-vendor", vendorId: vendor.id };
      } else {
        request = {
          type: "draft",
          provider: draft.protocol,
          baseURL: connectionURL(draft),
          ...(draft.kind === "mimo-token-plan-cn"
            ? { modelAdapter: "mimo-token-plan-cn" as const }
            : {}),
          apiKey: keyRef.current?.value.trim() ?? "",
        };
      }
      const parsed = discoverAgentModelsSchema.safeParse(request);
      if (!parsed.success) {
        setDiscoveryError(
          "发现模型需要有效地址和 API Key；也可以直接手工添加模型。已有连接可保留已保存凭据后再试。",
        );
        return;
      }
      setDiscovering(true);
      const result = await window.desktopApi.listRemoteModels(parsed.data);
      if (!active.current || discoveryRequest.current !== requestId) return;
      setDiscovery(result.models);
    } catch {
      if (active.current && discoveryRequest.current === requestId) {
        setDiscoveryError(
          "无法发现模型。请检查地址、Key、网络与厂商是否支持模型列表；仍可手工添加模型。",
        );
      }
    } finally {
      if (active.current && discoveryRequest.current === requestId) setDiscovering(false);
    }
  };

  const updateModel = (id: string, patch: Partial<VendorConfiguration["models"][number]>) => {
    setDraft((current) => ({
      ...current,
      models: current.models.map((model) => (model.id === id ? { ...model, ...patch } : model)),
    }));
    setFailure("");
  };
  const query = modelSearch.trim().toLocaleLowerCase();
  const discoveredModels = discovery?.filter((model) =>
    `${model.id} ${model.displayName ?? ""}`.toLocaleLowerCase().includes(query),
  );

  return (
    <Dialog
      open
      purpose="form"
      title={existing ? "编辑连接" : "创建连接"}
      description="配置保存在桌面宿主；已保存的 API Key 不会读回界面。"
      initialFocusRef={nameRef}
      fallbackFocusRef={fallbackFocusRef}
      onRequestClose={close}
      footer={
        <>
          <Button disabled={pending} onClick={close}>
            取消
          </Button>
          <Button tone="primary" type="submit" form={`${prefix}-form`} busy={pending}>
            {pending ? "正在保存…" : "保存连接"}
          </Button>
        </>
      }
    >
      <form
        id={`${prefix}-form`}
        className="desktop-settings-form"
        noValidate
        aria-busy={pending}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field id={`${prefix}-name`} label="名称" required error={fieldError.name}>
          {(props) => (
            <Input
              {...props}
              ref={nameRef}
              value={draft.label}
              readOnly={pending}
              onChange={(event) => update({ ...draft, label: event.target.value })}
            />
          )}
        </Field>
        <Field id={`${prefix}-protocol`} label="厂商 / 协议">
          {(props) => (
            <Select
              id={props.id}
              aria-describedby={props["aria-describedby"]}
              disabled={pending}
              value={adapter}
              options={connectionAdapters}
              onValueChange={(value) => {
                const next = value as ConnectionAdapter;
                setAdapter(next);
                update(changeConnectionAdapter(draft, next));
              }}
            />
          )}
        </Field>
        <Field
          id={`${prefix}-address`}
          label="地址"
          error={fieldError.address}
          hint={
            draft.kind === "mimo-token-plan-cn"
              ? "MiMo Token Plan CN 使用固定中国区地址与 Responses 协议。"
              : "留空使用协议默认地址；兼容服务请填写厂商提供的地址。"
          }
        >
          {(props) => (
            <Input
              {...props}
              ref={addressRef}
              type="url"
              autoComplete="off"
              spellCheck={false}
              value={draft.baseURL}
              readOnly={pending || draft.kind === "mimo-token-plan-cn"}
              onChange={(event) => update({ ...draft, baseURL: event.target.value })}
            />
          )}
        </Field>
        <label className="desktop-settings-check">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={pending}
            onChange={(event) => update({ ...draft, enabled: event.target.checked })}
          />
          启用此连接
        </label>
        <Field
          id={`${prefix}-credential-action`}
          label="API Key 操作"
          hint={configured ? "此连接已有可用凭据；密钥不会回显。" : "此连接尚未检测到可用凭据。"}
        >
          {(props) => (
            <Select
              id={props.id}
              aria-describedby={props["aria-describedby"]}
              disabled={pending}
              value={credentialAction}
              options={[
                ...(existing ? [{ value: "keep", label: "保留已保存凭据" }] : []),
                { value: "replace", label: "输入 / 替换 API Key", disabled: !storageAvailable },
                { value: "remove", label: existing ? "移除已保存凭据" : "暂不配置凭据" },
              ]}
              onValueChange={(value) => {
                setCredentialAction(value as CredentialAction);
                setFieldError({});
                if (keyRef.current) keyRef.current.value = "";
                setKeyEdited(false);
                invalidateDiscovery();
              }}
            />
          )}
        </Field>
        {credentialAction === "replace" && (
          <Field
            id={`${prefix}-key`}
            label="新的 API Key"
            required
            error={fieldError.key}
            hint="仅用于这次配置提交或模型发现；不写入浏览器存储。"
          >
            {(props) => (
              <Input
                {...props}
                ref={keyRef}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                autoCapitalize="none"
                readOnly={pending || !storageAvailable}
                maxLength={16384}
                onChange={() => {
                  setKeyEdited(true);
                  setFieldError({});
                  invalidateDiscovery();
                }}
              />
            )}
          </Field>
        )}
        {fieldError.key && credentialAction !== "replace" && (
          <Alert title="请确认凭据操作" tone="error" announce="assertive">
            {fieldError.key}
          </Alert>
        )}
        {!storageAvailable && (
          <Alert title="凭据存储不可用" tone="error">
            请恢复系统安全存储后再输入 Key；仍可编辑不含密钥的连接与模型。
          </Alert>
        )}
        {bindingChanged && configured && (
          <p className="desktop-settings-hint">
            改变地址或协议会使旧凭据绑定失效，必须重新配置 Key 才能连接。
          </p>
        )}
        <section className="desktop-settings-model-editor" aria-label="连接模型">
          <div className="desktop-settings-actions">
            <h3>模型</h3>
            <Button
              disabled={pending}
              onClick={() => setDraft({ ...draft, models: [...draft.models, createModel()] })}
            >
              手工添加模型
            </Button>
            <Button disabled={pending} busy={discovering} onClick={() => void discover()}>
              {discovering ? "正在发现…" : "发现模型"}
            </Button>
          </div>
          <p className="desktop-settings-hint">
            模型标识必须与厂商一致。手工添加不表示厂商支持该模型；只有保存后才会进入会话菜单。
          </p>
          {draft.models.length === 0 && (
            <p className="ui-settings-empty">暂无模型，可发现或手工添加。</p>
          )}
          {draft.models.map((model, index) => (
            <div key={model.id} className="desktop-settings-model-card">
              <Field id={`${prefix}-${model.id}-model`} label={`模型 ${index + 1} 标识`} required>
                {(props) => (
                  <Input
                    {...props}
                    value={model.model}
                    readOnly={pending}
                    spellCheck={false}
                    onChange={(event) => updateModel(model.id, { model: event.target.value })}
                  />
                )}
              </Field>
              <Field
                id={`${prefix}-${model.id}-name`}
                label={`模型 ${index + 1} 显示名称`}
                required
              >
                {(props) => (
                  <Input
                    {...props}
                    value={model.name}
                    readOnly={pending}
                    onChange={(event) => updateModel(model.id, { name: event.target.value })}
                  />
                )}
              </Field>
              {draft.protocol === "openai" && draft.kind !== "mimo-token-plan-cn" && (
                <Field id={`${prefix}-${model.id}-mode`} label={`模型 ${index + 1} API 模式`}>
                  {(props) => (
                    <Select
                      id={props.id}
                      value={model.openaiApiMode}
                      disabled={pending}
                      options={[
                        { value: "responses", label: "Responses" },
                        { value: "chat-completions", label: "Chat Completions" },
                      ]}
                      onValueChange={(value) =>
                        updateModel(model.id, {
                          openaiApiMode: value as "responses" | "chat-completions",
                        })
                      }
                    />
                  )}
                </Field>
              )}
              <div className="desktop-settings-actions">
                <label className="desktop-settings-check">
                  <input
                    type="checkbox"
                    checked={model.enabled}
                    disabled={pending}
                    onChange={(event) => updateModel(model.id, { enabled: event.target.checked })}
                  />
                  启用模型 {index + 1}
                </label>
                <Button
                  tone="danger"
                  disabled={pending}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      models: draft.models.filter((entry) => entry.id !== model.id),
                    })
                  }
                  aria-label={`移除模型 ${index + 1}`}
                >
                  移除
                </Button>
              </div>
              {!modelIsSupported(draft, model) && (
                <p className="desktop-settings-hint">
                  当前适配器不支持此模型；可保存配置，但无法用于会话。
                </p>
              )}
            </div>
          ))}
          {discoveryError && (
            <Alert title="模型发现未完成" tone="error" announce="assertive">
              {discoveryError}
            </Alert>
          )}
          {discovery !== null && (
            <div className="desktop-settings-discovery">
              <Input
                type="search"
                aria-label="搜索发现的模型"
                placeholder="搜索发现的模型"
                value={modelSearch}
                onChange={(event) => setModelSearch(event.target.value)}
              />
              <p role="status" className="desktop-settings-hint">
                发现 {discovery.length} 个模型；选择添加后需保存连接。
              </p>
              {discoveredModels?.map((model) => {
                const added = draft.models.some((entry) => entry.model === model.id);
                return (
                  <div key={model.id} className="desktop-settings-discovery-row">
                    <span>
                      {model.displayName || model.id}
                      <small>
                        {model.id}
                        {model.supported === false ? " · 当前适配器不支持" : ""}
                      </small>
                    </span>
                    <Button
                      disabled={pending || added || model.supported === false}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          models: [
                            ...draft.models,
                            createModel(model.id, model.displayName || model.id),
                          ],
                        })
                      }
                    >
                      {added ? "已添加" : "添加"}
                    </Button>
                  </div>
                );
              })}
              {discoveredModels?.length === 0 && (
                <p className="ui-settings-empty">没有匹配模型，请手工添加。</p>
              )}
            </div>
          )}
        </section>
        {failure && (
          <Alert title="连接未保存" tone="error" announce="assertive">
            {failure}
          </Alert>
        )}
        {pending && (
          <p role="status" className="desktop-settings-hint">
            等待宿主保存结果。保存期间请勿关闭窗口；关闭页面不能撤销已提交的更改。
          </p>
        )}
      </form>
      <UnsavedChangesDialog
        open={leaving}
        fallbackFocusRef={nameRef}
        onContinueEditing={() => setLeaving(false)}
        onDiscard={onClose}
      />
    </Dialog>
  );
}
