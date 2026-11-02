import {
  agentPreferencesSchema,
  type VendorConfiguration,
} from "@agent-harness/configuration/configuration-contract";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Alert } from "../ui/components/alert/Alert";
import { Button } from "../ui/components/button/Button";
import { Dialog } from "../ui/components/dialog/Dialog";
import { Field } from "../ui/components/field/Field";
import { Input } from "../ui/components/input/Input";
import { Select } from "../ui/components/select/Select";
import { UnsavedChangesDialog } from "../ui/patterns/UnsavedChangesDialog";
import type { UiTheme } from "../ui/provider/UiProvider";
import { DesktopConnectionForm } from "./DesktopConnectionForm";
import { connectionAddress, modelIsSupported, newConnection } from "./desktop-settings-model";
import { useDesktopConfiguration } from "./useDesktopConfiguration";
import "./desktop-settings.css";

export interface DesktopSettingsProps {
  onBack: () => void;
  onChanged: () => void;
  theme?: UiTheme;
  onThemeChange?: (theme: UiTheme) => void;
}

type SettingsSection = "models" | "workflow" | "appearance";

export function DesktopSettings({ onBack, onChanged, theme, onThemeChange }: DesktopSettingsProps) {
  const { snapshot, loading, pending, error, notice, reload, commit } =
    useDesktopConfiguration(onChanged);
  const [section, setSection] = useState<SettingsSection>("models");
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<{ vendor: VendorConfiguration; existing: boolean } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<VendorConfiguration | null>(null);
  const [stepEnabledDraft, setStepEnabled] = useState<boolean | null>(null);
  const [stepCountDraft, setStepCount] = useState<string | null>(null);
  const stepEnabled = stepEnabledDraft ?? snapshot?.settings.stepLimits.enabled ?? true;
  const stepCount = stepCountDraft ?? String(snapshot?.settings.stepLimits.mainMaxSteps ?? "");
  const [preferenceError, setPreferenceError] = useState("");
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const stepRef = useRef<HTMLInputElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const prefix = useId();
  const title = section === "models" ? "模型" : section === "workflow" ? "运行偏好" : "外观";
  const preferencesDirty = Boolean(
    snapshot &&
      (stepEnabled !== snapshot.settings.stepLimits.enabled ||
        stepCount !== String(snapshot.settings.stepLimits.mainMaxSteps)),
  );

  useLayoutEffect(() => {
    backRef.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (!snapshot) return;
    setStepEnabled(null);
    setStepCount(null);
    setPreferenceError("");
  }, [snapshot]);
  useEffect(() => {
    if (!preferencesDirty && !pending) return;
    const preventLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLeave);
    return () => window.removeEventListener("beforeunload", preventLeave);
  }, [preferencesDirty, pending]);

  const navigate = (action: () => void) => {
    if (pending) return;
    if (preferencesDirty) setLeave(() => action);
    else action();
  };
  const resetPreferences = () => {
    if (!snapshot) return;
    setStepEnabled(null);
    setStepCount(null);
    setPreferenceError("");
  };
  const savePreferences = async () => {
    if (!snapshot || pending) return;
    const settings = snapshot.settings;
    const preferences = agentPreferencesSchema.safeParse({
      gateway: settings.gateway,
      executionStrategy: settings.executionStrategy,
      defaultTemplateId: settings.defaultTemplateId,
      stepLimits: { ...settings.stepLimits, enabled: stepEnabled, mainMaxSteps: Number(stepCount) },
    });
    if (!preferences.success || !/^\d+$/.test(stepCount)) {
      setPreferenceError("请输入 1 到 200 之间的整数模型轮数。关闭限制时仍需保留有效轮数设置。 ");
      stepRef.current?.focus();
      return;
    }
    setPreferenceError("");
    await commit(
      () => window.desktopApi.saveAgentPreferences(preferences.data),
      "运行偏好已保存，下次执行生效。",
    );
  };
  const setDefaultModel = async (modelId: string) => {
    await commit(async () => {
      const result = await window.harnessDesktop.setDefaultModel(modelId || undefined);
      if (!result.ok) throw new Error("Default model was not saved.");
      const current = await window.desktopApi.getAgentConfiguration();
      if (!current) throw new Error("Configuration is unavailable.");
      return current;
    }, "默认模型已保存，新会话将使用此设置。");
  };
  const query = search.trim().toLocaleLowerCase();
  const allModels =
    snapshot?.settings.vendors.flatMap((vendor) =>
      vendor.models.map((model) => ({ vendor, model })),
    ) ?? [];
  const models = allModels.filter(({ model, vendor }) =>
    `${model.name} ${model.model} ${vendor.label}`.toLocaleLowerCase().includes(query),
  );
  const hasCredential = (vendorId: string) =>
    snapshot?.credentials.models.some(
      (credential) => credential.vendorId === vendorId && credential.configured,
    ) ?? false;
  const usable = (vendor: VendorConfiguration, model: VendorConfiguration["models"][number]) =>
    vendor.enabled &&
    model.enabled &&
    hasCredential(vendor.id) &&
    snapshot?.credentials.storage.state !== "unavailable" &&
    modelIsSupported(vendor, model);

  return (
    <div className="ui-settings-screen desktop-settings-screen">
      <aside className="ui-settings-sidebar">
        <button
          ref={backRef}
          type="button"
          className="ui-settings-back"
          disabled={pending}
          onClick={() => navigate(onBack)}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="m9 4-6 6 6 6M3 10h14" />
          </svg>
          返回会话
        </button>
        <p className="ui-settings-sidebar-title">设置</p>
        <nav className="ui-settings-navigation" aria-label="设置分类">
          <button
            type="button"
            disabled={pending}
            aria-current={section === "models" ? "page" : undefined}
            onClick={() => navigate(() => setSection("models"))}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="m10 2 7 4v8l-7 4-7-4V6l7-4Zm0 8 7-4M10 10 3 6m7 4v8" />
            </svg>
            模型
          </button>
          <button
            type="button"
            disabled={pending}
            aria-current={section === "workflow" ? "page" : undefined}
            onClick={() => navigate(() => setSection("workflow"))}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M3 5h14M3 10h14M3 15h14M7 3v4m6 1v4m-6 1v4" />
            </svg>
            运行偏好
          </button>
          {theme && onThemeChange && (
            <button
              type="button"
              disabled={pending}
              aria-current={section === "appearance" ? "page" : undefined}
              onClick={() => navigate(() => setSection("appearance"))}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <circle cx="10" cy="10" r="7" />
                <path d="M10 3v14M10 3a7 7 0 0 1 0 14Z" fill="currentColor" />
              </svg>
              外观
            </button>
          )}
        </nav>
      </aside>
      <div className="ui-settings-body">
        <header className="ui-settings-topbar">
          <span>设置</span>
          <span aria-hidden="true">/</span>
          <span>{title}</span>
        </header>
        <main
          className="ui-settings-main"
          aria-label={`${title}设置`}
          aria-busy={loading || pending}
        >
          <div className="ui-settings-content">
            {loading && <p role="status">正在读取配置…</p>}
            {error && (
              <Alert title="配置操作未完成" tone="error" announce="assertive">
                {error}
                <div className="desktop-settings-actions">
                  <Button
                    disabled={pending || loading}
                    onClick={() =>
                      navigate(() => {
                        void reload();
                      })
                    }
                  >
                    重新加载配置
                  </Button>
                </div>
              </Alert>
            )}
            {notice && (
              <p className="ui-settings-save-status" role="status">
                {notice}
              </p>
            )}
            {snapshot && !loading && (
              <>
                {snapshot.credentials.storage.state !== "secure" && (
                  <Alert
                    title={
                      snapshot.credentials.storage.state === "unavailable"
                        ? "系统凭据存储不可用"
                        : "系统凭据保护已降级"
                    }
                    tone={snapshot.credentials.storage.state === "unavailable" ? "error" : "info"}
                  >
                    {snapshot.credentials.storage.state === "unavailable"
                      ? "请恢复操作系统的安全存储后再配置 Key 或运行模型。现有密钥不会显示在界面。"
                      : "当前系统未提供完整的安全凭据保护，请检查系统密钥环配置后再保存敏感凭据。"}
                  </Alert>
                )}
                {section === "models" && (
                  <>
                    <section className="ui-settings-section" aria-labelledby={`${prefix}-models`}>
                      <header className="ui-settings-heading">
                        <h1 id={`${prefix}-models`}>模型</h1>
                        <p>管理真实连接中的模型，启用后可在会话模型菜单中选择。</p>
                      </header>
                      <Field
                        id={`${prefix}-default`}
                        label="默认模型"
                        hint="沿用 CLI 的默认模型规则；桌面配置独立保存，不改变已有会话绑定。"
                      >
                        {(props) => (
                          <Select
                            id={props.id}
                            aria-describedby={props["aria-describedby"]}
                            value={snapshot.settings.cli?.defaultModelId ?? ""}
                            disabled={pending}
                            options={[
                              { value: "", label: "未设置默认模型" },
                              ...allModels.map(({ vendor, model }) => ({
                                value: model.id,
                                label: `${model.name} · ${vendor.label}`,
                                disabled: !usable(vendor, model),
                              })),
                            ]}
                            onValueChange={(value) => {
                              void setDefaultModel(value);
                            }}
                          />
                        )}
                      </Field>
                      <div className="ui-settings-model-list">
                        <div className="ui-settings-search">
                          <Input
                            type="search"
                            aria-label="搜索模型"
                            placeholder="搜索模型或连接"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                          />
                        </div>
                        {models.map(({ vendor, model }) => (
                          <div key={model.id} className="ui-settings-model-row">
                            <span className="ui-settings-model-name">
                              {model.name}
                              <small className="desktop-settings-model-meta">
                                {vendor.label} · {model.model}
                                {!vendor.enabled
                                  ? " · 连接已停用"
                                  : !hasCredential(vendor.id)
                                    ? " · 请配置 Key"
                                    : !modelIsSupported(vendor, model)
                                      ? " · 适配器不支持"
                                      : ""}
                                {snapshot.settings.cli?.defaultModelId === model.id
                                  ? " · 默认"
                                  : ""}
                              </small>
                            </span>
                            <input
                              type="checkbox"
                              role="switch"
                              className="ui-settings-model-switch"
                              aria-label={`启用模型 ${model.name}`}
                              checked={model.enabled}
                              disabled={pending}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                void commit(
                                  () =>
                                    window.desktopApi.saveAgentVendor({
                                      vendor: {
                                        ...vendor,
                                        models: vendor.models.map((entry) =>
                                          entry.id === model.id ? { ...entry, enabled } : entry,
                                        ),
                                      },
                                      credential: { type: "keep" },
                                    }),
                                  enabled ? "模型已启用。" : "模型已停用。",
                                );
                              }}
                            />
                          </div>
                        ))}
                        {models.length === 0 && (
                          <p className="ui-settings-empty" role="status">
                            {allModels.length
                              ? "没有匹配的模型"
                              : "尚未配置模型。请创建连接并添加模型。"}
                          </p>
                        )}
                      </div>
                    </section>
                    <section
                      className="ui-settings-section"
                      aria-labelledby={`${prefix}-connections`}
                    >
                      <header className="ui-settings-connection-heading">
                        <h2 id={`${prefix}-connections`}>连接</h2>
                        <Button
                          tone="primary"
                          disabled={pending}
                          onClick={() => setEditor({ vendor: newConnection(), existing: false })}
                        >
                          创建连接
                        </Button>
                      </header>
                      <div className="ui-settings-connections">
                        {snapshot.settings.vendors.map((vendor) => (
                          <div key={vendor.id} className="ui-settings-connection-row">
                            <div className="ui-settings-connection-details">
                              <h3>
                                {vendor.label}
                                {!vendor.enabled ? " · 已停用" : ""}
                              </h3>
                              <code>{connectionAddress(vendor.baseURL)}</code>
                              <small className="desktop-settings-hint">
                                {hasCredential(vendor.id) ? "凭据已配置" : "未配置凭据"} ·{" "}
                                {vendor.models.length} 个模型
                              </small>
                            </div>
                            <div className="desktop-settings-actions">
                              <Button
                                disabled={pending}
                                aria-label={`编辑 ${vendor.label}`}
                                onClick={() => setEditor({ vendor, existing: true })}
                              >
                                编辑
                              </Button>
                              <Button
                                tone="danger"
                                disabled={pending}
                                aria-label={`删除 ${vendor.label}`}
                                onClick={() => setDeleting(vendor)}
                              >
                                删除
                              </Button>
                            </div>
                          </div>
                        ))}
                        {snapshot.settings.vendors.length === 0 && (
                          <p className="ui-settings-empty">尚无连接</p>
                        )}
                      </div>
                    </section>
                  </>
                )}
                {section === "workflow" && (
                  <section className="ui-settings-section" aria-labelledby={`${prefix}-workflow`}>
                    <header className="ui-settings-heading">
                      <h1 id={`${prefix}-workflow`}>运行偏好</h1>
                      <p>
                        保存到真实配置，下次执行生效。新会话默认启用工作区工具，写操作仍需宿主审批。
                      </p>
                    </header>
                    <form
                      className="desktop-settings-preferences"
                      noValidate
                      onSubmit={(event) => {
                        event.preventDefault();
                        void savePreferences();
                      }}
                    >
                      <label className="desktop-settings-check">
                        <input
                          type="checkbox"
                          checked={stepEnabled}
                          disabled={pending}
                          onChange={(event) => setStepEnabled(event.target.checked)}
                        />
                        限制每次请求的模型轮数
                      </label>
                      <Field
                        id={`${prefix}-steps`}
                        label="最多模型轮数"
                        required
                        error={preferenceError}
                        hint="1–200。关闭后仍有宿主内部安全上限，并非无限执行。"
                      >
                        {(props) => (
                          <Input
                            {...props}
                            ref={stepRef}
                            type="number"
                            min={1}
                            max={200}
                            step={1}
                            value={stepCount}
                            readOnly={pending}
                            onChange={(event) => {
                              setStepCount(event.target.value);
                              setPreferenceError("");
                            }}
                          />
                        )}
                      </Field>
                      <div className="desktop-settings-actions">
                        <Button
                          type="submit"
                          tone="primary"
                          busy={pending}
                          disabled={!preferencesDirty}
                        >
                          {pending ? "正在保存…" : "保存偏好"}
                        </Button>
                        <Button disabled={pending || !preferencesDirty} onClick={resetPreferences}>
                          还原修改
                        </Button>
                        {preferencesDirty && (
                          <span className="desktop-settings-hint" role="status">
                            有未保存修改
                          </span>
                        )}
                      </div>
                    </form>
                  </section>
                )}
                {section === "appearance" && theme && onThemeChange && (
                  <section className="ui-settings-section" aria-labelledby={`${prefix}-appearance`}>
                    <header className="ui-settings-heading">
                      <h1 id={`${prefix}-appearance`}>外观</h1>
                      <p>主题立即生效并由桌面工作区保存。</p>
                    </header>
                    <fieldset className="ui-settings-theme-picker">
                      <legend>界面主题</legend>
                      {(["light", "dark"] as const).map((value) => (
                        <label key={value} className="ui-settings-theme-option">
                          <input
                            type="radio"
                            name={`${prefix}-theme`}
                            value={value}
                            checked={theme === value}
                            onChange={() => onThemeChange(value)}
                          />
                          <span>{value === "light" ? "浅色" : "深色"}</span>
                        </label>
                      ))}
                    </fieldset>
                  </section>
                )}
              </>
            )}
          </div>
        </main>
      </div>
      {editor && snapshot && (
        <DesktopConnectionForm
          key={editor.vendor.id}
          vendor={editor.vendor}
          existing={editor.existing}
          configured={hasCredential(editor.vendor.id)}
          storageAvailable={snapshot.credentials.storage.state !== "unavailable"}
          pending={pending}
          fallbackFocusRef={backRef}
          onSave={(request) =>
            commit(
              () => window.desktopApi.saveAgentVendor(request),
              "连接已保存。仅新会话或后续执行使用更新后的配置。",
            )
          }
          onClose={() => setEditor(null)}
        />
      )}
      {deleting && (
        <Dialog
          open
          purpose="confirm"
          title="删除连接？"
          description={`将删除连接“${deleting.label}”、其模型和已保存的凭据。已有会话记录不会删除，但可能无法继续使用该连接。`}
          initialFocusRef={cancelDeleteRef}
          fallbackFocusRef={backRef}
          onRequestClose={() => {
            if (!pending) setDeleting(null);
          }}
          footer={
            <>
              <Button ref={cancelDeleteRef} disabled={pending} onClick={() => setDeleting(null)}>
                取消
              </Button>
              <Button
                tone="danger"
                busy={pending}
                onClick={() => {
                  void commit(
                    () => window.desktopApi.deleteAgentVendor(deleting.id),
                    "连接已删除。",
                  ).then((saved) => {
                    if (saved) setDeleting(null);
                  });
                }}
              >
                删除连接
              </Button>
            </>
          }
        >
          {error && (
            <Alert title="删除未完成" tone="error" announce="assertive">
              请确认配置目录权限和凭据存储可用后重试；也可取消并重新加载配置确认状态。
            </Alert>
          )}
          {pending && <p role="status">正在删除，请等待宿主返回结果。</p>}
        </Dialog>
      )}
      <UnsavedChangesDialog
        open={leave !== null}
        fallbackFocusRef={backRef}
        onContinueEditing={() => setLeave(null)}
        onDiscard={() => {
          const action = leave;
          setLeave(null);
          resetPreferences();
          action?.();
        }}
      />
    </div>
  );
}
