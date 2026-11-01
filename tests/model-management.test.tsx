// @vitest-environment jsdom

import { getModelProfile, getModelSupport } from "@agent-harness/models/model-profiles";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mimoProfile = getModelProfile("mimo-token-plan-cn");
if (mimoProfile?.endpoint?.kind !== "fixed")
  throw new Error("The MiMo fixed endpoint profile is required.");
const mimoBaseURL = mimoProfile.endpoint.url;
const mimoSupport = getModelSupport("mimo-token-plan-cn", "mimo-v2.6-pro");
if (!mimoSupport?.supported) throw new Error("The MiMo Pro support profile is required.");
const mimoReasoningEfforts = mimoSupport.reasoningEfforts;

import { ModelManagement } from "../app/renderer/src/components/ModelManagement";
import type { ModelVendorConnection } from "../app/renderer/src/modelCatalog";
import { flattenVendors } from "../app/renderer/src/modelCatalog";

function deepseekVendor(): ModelVendorConnection {
  return {
    id: "deepseek",
    kind: "deepseek",
    label: "DeepSeek",
    protocol: "anthropic",
    baseURL: "https://api.deepseek.com/anthropic",
    enabled: true,
    credentialConfigured: true,
    models: [
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        model: "deepseek-v4-flash",
        openaiApiMode: "responses",
        supports1MContext: true,
        enabled: true,
        pricing: {
          currency: "CNY",
          inputPerMillion: 1,
          cachedInputPerMillion: 0.02,
          outputPerMillion: 2,
          updatedAt: "2026-07-31",
        },
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        model: "deepseek-v4-pro",
        openaiApiMode: "chat-completions",
        supports1MContext: true,
        enabled: true,
        pricing: {
          currency: "CNY",
          inputPerMillion: 3,
          cachedInputPerMillion: 0.025,
          outputPerMillion: 6,
          updatedAt: "2026-07-31",
        },
      },
    ],
  };
}

describe("ModelManagement vendor onboarding", () => {
  afterEach(cleanup);
  it("discovers MiMo drafts and preserves every effort through save and reopen", async () => {
    const listRemoteModels = vi.fn().mockResolvedValue({
      models: [
        { id: "mimo-v2.6-pro", displayName: "MiMo Pro", supported: true },
        { id: "unknown", supported: false, unsupportedReason: "当前适配器未支持此模型" },
      ],
    });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { listRemoteModels },
    });
    let saved: ModelVendorConnection | undefined;
    const onSaveVendor = vi.fn(async (vendor: ModelVendorConnection) => {
      saved = { ...vendor, credentialConfigured: true };
      return true;
    });
    const props = {
      onSelectModel: vi.fn(),
      onSaveVendor,
      onDeleteVendor: vi.fn().mockResolvedValue(true),
      onDeleteModel: vi.fn().mockResolvedValue(true),
      onSetVendorEnabled: vi.fn().mockResolvedValue(true),
      onSetModelEnabled: vi.fn().mockResolvedValue(true),
      triggerToast: vi.fn(),
    };
    const view = render(<ModelManagement {...props} vendors={[]} models={[]} selectedModelId="" />);
    fireEvent.click(screen.getByRole("button", { name: "添加厂商" }));
    fireEvent.click(screen.getByRole("button", { name: /MiMo Token Plan 中国/ }));
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole("combobox", { name: "协议" })).toBeNull();
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
    const checkbox = await screen.findByRole("checkbox", { name: /^MiMo Pro/ });
    expect(listRemoteModels).toHaveBeenCalledWith({
      type: "draft",
      provider: "openai",
      baseURL: mimoBaseURL,
      apiKey: "test-secret",
      modelAdapter: "mimo-token-plan-cn",
    });
    expect((screen.getByRole("checkbox", { name: /^unknown/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: /高级设置/ }));
    expect(screen.queryByRole("combobox", { name: /API 模式/ })).toBeNull();
    for (const effort of mimoReasoningEfforts) {
      fireEvent.click(screen.getByRole("combobox", { name: "MiMo Pro 思考强度" }));
      fireEvent.click(screen.getByRole("option", { name: effort, exact: true }));
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() => expect(saved?.models[0]?.reasoningEffort).toBe(effort));
      expect(saved?.models[0]?.openaiApiMode).toBe("responses");
      expect(flattenVendors([saved!])[0]?.reasoningEffort).toBe(effort);
      view.rerender(
        <ModelManagement
          {...props}
          vendors={[saved!]}
          models={flattenVendors([saved!])}
          selectedModelId=""
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "编辑厂商 MiMo Token Plan 中国" }));
      fireEvent.click(screen.getByRole("button", { name: /高级设置/ }));
      expect(screen.getByRole("combobox", { name: "MiMo Pro 思考强度" }).textContent).toContain(
        effort,
      );
    }
    fireEvent.click(screen.getByRole("combobox", { name: "MiMo Pro 思考强度" }));
    fireEvent.click(screen.getByRole("option", { name: "默认（不发送）" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(saved!.models[0]).not.toHaveProperty("reasoningEffort"));
  });

  it("saves a DeepSeek vendor with one API key", async () => {
    const onSaveVendor = vi.fn().mockResolvedValue(true);
    const onSelectModel = vi.fn();
    const triggerToast = vi.fn();
    render(
      <ModelManagement
        vendors={[]}
        models={[]}
        selectedModelId=""
        onSelectModel={onSelectModel}
        onSaveVendor={onSaveVendor}
        onDeleteVendor={vi.fn().mockResolvedValue(true)}
        onDeleteModel={vi.fn().mockResolvedValue(true)}
        onSetVendorEnabled={vi.fn().mockResolvedValue(true)}
        onSetModelEnabled={vi.fn().mockResolvedValue(true)}
        triggerToast={triggerToast}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加厂商" }));
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek/ }));
    const dialog = screen.getByRole("dialog", { name: "添加厂商" });
    expect(document.activeElement).toBe(within(dialog).getByRole("textbox", { name: "显示名称" }));
    fireEvent.change(within(dialog).getByLabelText("API Key"), {
      target: { value: "deepseek-secret" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSaveVendor).toHaveBeenCalledTimes(1));
    const [savedVendor, apiKey] = onSaveVendor.mock.calls[0]!;
    expect(apiKey).toBe("deepseek-secret");
    expect(savedVendor).toMatchObject({
      id: "deepseek",
      kind: "deepseek",
      protocol: "anthropic",
      baseURL: "https://api.deepseek.com/anthropic",
    });
    expect(savedVendor.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "deepseek-v4-flash" }),
        expect.objectContaining({ id: "deepseek-v4-pro" }),
      ]),
    );
    expect(onSelectModel).toHaveBeenCalledWith("deepseek-v4-flash");
    expect(triggerToast).toHaveBeenCalledWith("DeepSeek 已保存");
  });

  it("keeps save visible after expanding advanced settings", () => {
    const vendor = deepseekVendor();
    render(
      <ModelManagement
        vendors={[vendor]}
        models={flattenVendors([vendor])}
        selectedModelId="deepseek-v4-flash"
        onSelectModel={vi.fn()}
        onSaveVendor={vi.fn().mockResolvedValue(true)}
        onDeleteVendor={vi.fn().mockResolvedValue(true)}
        onDeleteModel={vi.fn().mockResolvedValue(true)}
        onSetVendorEnabled={vi.fn().mockResolvedValue(true)}
        onSetModelEnabled={vi.fn().mockResolvedValue(true)}
        triggerToast={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑厂商 DeepSeek" }));
    const dialog = screen.getByRole("dialog", { name: "编辑厂商" });
    fireEvent.click(within(dialog).getByRole("button", { name: /高级设置/ }));
    expect(within(dialog).getByRole("button", { name: "保存" })).toBeTruthy();
  });

  it("edits pricing and rejects an empty required price", async () => {
    const onSaveVendor = vi.fn().mockResolvedValue(true);
    const triggerToast = vi.fn();
    const vendor: ModelVendorConnection = {
      id: "custom-1",
      kind: "custom",
      label: "Custom",
      protocol: "openai",
      baseURL: "https://example.com/v1",
      enabled: true,
      credentialConfigured: true,
      models: [
        {
          id: "custom-priced",
          name: "Priced Model",
          model: "priced-model",
          openaiApiMode: "responses",
          enabled: true,
          pricing: {
            currency: "USD",
            inputPerMillion: 5,
            cachedInputPerMillion: 0.5,
            outputPerMillion: 30,
            updatedAt: "2026-08-01",
          },
        },
      ],
    };
    render(
      <ModelManagement
        vendors={[vendor]}
        models={flattenVendors([vendor])}
        selectedModelId="custom-priced"
        onSelectModel={vi.fn()}
        onSaveVendor={onSaveVendor}
        onDeleteVendor={vi.fn().mockResolvedValue(true)}
        onDeleteModel={vi.fn().mockResolvedValue(true)}
        onSetVendorEnabled={vi.fn().mockResolvedValue(true)}
        onSetModelEnabled={vi.fn().mockResolvedValue(true)}
        triggerToast={triggerToast}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑厂商 Custom" }));
    const dialog = screen.getByRole("dialog", { name: "编辑厂商" });
    const inputPrice = within(dialog).getByRole("spinbutton", {
      name: "Priced Model 普通输入单价",
    });
    expect((inputPrice as HTMLInputElement).value).toBe("5");
    fireEvent.change(inputPrice, { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    expect(onSaveVendor).not.toHaveBeenCalled();
    expect(triggerToast).toHaveBeenCalledWith("请填写有效的非负模型单价");
  });

  it("keeps an edited API key separate from persisted vendor metadata", async () => {
    const onSaveVendor = vi.fn().mockResolvedValue(true);
    const vendor: ModelVendorConnection = {
      id: "custom-secure",
      kind: "custom",
      label: "Secure",
      protocol: "openai",
      baseURL: "https://example.com/v1",
      enabled: true,
      credentialConfigured: true,
      models: [
        {
          id: "custom-secure-model",
          name: "Secure Model",
          model: "secure-model",
          openaiApiMode: "responses",
          enabled: true,
          pricing: null,
        },
      ],
    };
    render(
      <ModelManagement
        vendors={[vendor]}
        models={flattenVendors([vendor])}
        selectedModelId="custom-secure-model"
        onSelectModel={vi.fn()}
        onSaveVendor={onSaveVendor}
        onDeleteVendor={vi.fn().mockResolvedValue(true)}
        onDeleteModel={vi.fn().mockResolvedValue(true)}
        onSetVendorEnabled={vi.fn().mockResolvedValue(true)}
        onSetModelEnabled={vi.fn().mockResolvedValue(true)}
        triggerToast={vi.fn()}
      />,
    );

    expect(screen.getByText(/凭据已配置/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "编辑厂商 Secure" }));
    const dialog = screen.getByRole("dialog", { name: "编辑厂商" });
    const keyInput = within(dialog).getByLabelText("API Key");
    expect((keyInput as HTMLInputElement).value).toBe("");
    fireEvent.change(keyInput, { target: { value: "replacement-secret" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSaveVendor).toHaveBeenCalledTimes(1));
    const [savedVendor, apiKey] = onSaveVendor.mock.calls[0]!;
    expect(apiKey).toBe("replacement-secret");
    expect(savedVendor).not.toHaveProperty("apiKey");
  });

  it("discovers an unchanged saved vendor without sending a connection binding", async () => {
    const listRemoteModels = vi.fn().mockResolvedValue({ models: [] });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { listRemoteModels },
    });
    const vendor = deepseekVendor();
    render(
      <ModelManagement
        vendors={[vendor]}
        models={flattenVendors([vendor])}
        selectedModelId="deepseek-v4-flash"
        onSelectModel={vi.fn()}
        onSaveVendor={vi.fn().mockResolvedValue(true)}
        onDeleteVendor={vi.fn().mockResolvedValue(true)}
        onDeleteModel={vi.fn().mockResolvedValue(true)}
        onSetVendorEnabled={vi.fn().mockResolvedValue(true)}
        onSetModelEnabled={vi.fn().mockResolvedValue(true)}
        triggerToast={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑厂商 DeepSeek" }));
    fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
    await waitFor(() =>
      expect(listRemoteModels).toHaveBeenCalledExactlyOnceWith({
        type: "saved-vendor",
        vendorId: "deepseek",
      }),
    );
  });

  it("requires a draft key for a changed address instead of borrowing the saved key", async () => {
    const listRemoteModels = vi.fn().mockResolvedValue({ models: [] });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { listRemoteModels },
    });
    const vendor = deepseekVendor();
    const triggerToast = vi.fn();
    render(
      <ModelManagement
        vendors={[vendor]}
        models={flattenVendors([vendor])}
        selectedModelId="deepseek-v4-flash"
        onSelectModel={vi.fn()}
        onSaveVendor={vi.fn().mockResolvedValue(true)}
        onDeleteVendor={vi.fn().mockResolvedValue(true)}
        onDeleteModel={vi.fn().mockResolvedValue(true)}
        onSetVendorEnabled={vi.fn().mockResolvedValue(true)}
        onSetModelEnabled={vi.fn().mockResolvedValue(true)}
        triggerToast={triggerToast}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑厂商 DeepSeek" }));
    const dialog = screen.getByRole("dialog", { name: "编辑厂商" });
    fireEvent.change(within(dialog).getByLabelText("Base URL"), {
      target: { value: "https://other.example.com/v1" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "获取模型列表" }));
    expect(listRemoteModels).not.toHaveBeenCalled();
    expect(triggerToast).toHaveBeenCalledWith(expect.stringContaining("连接地址变更"));
    fireEvent.change(within(dialog).getByLabelText("API Key"), {
      target: { value: "draft-secret" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "获取模型列表" }));
    await waitFor(() =>
      expect(listRemoteModels).toHaveBeenCalledExactlyOnceWith({
        type: "draft",
        provider: "anthropic",
        baseURL: "https://other.example.com/v1",
        apiKey: "draft-secret",
      }),
    );
  });

  it("keeps remote checkboxes and renamed model controls accessible by their current names", async () => {
    const vendor = deepseekVendor();
    const onSaveVendor = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        listRemoteModels: vi.fn().mockResolvedValue({
          models: [
            { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash" },
            { id: "remote/beta:v2", displayName: "Remote Beta" },
          ],
        }),
      },
    });
    render(
      <ModelManagement
        vendors={[vendor]}
        models={flattenVendors([vendor])}
        selectedModelId="deepseek-v4-flash"
        onSelectModel={vi.fn()}
        onSaveVendor={onSaveVendor}
        onDeleteVendor={vi.fn().mockResolvedValue(true)}
        onDeleteModel={vi.fn().mockResolvedValue(true)}
        onSetVendorEnabled={vi.fn().mockResolvedValue(true)}
        onSetModelEnabled={vi.fn().mockResolvedValue(true)}
        triggerToast={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑厂商 DeepSeek" }));
    fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
    const remote = await screen.findByRole("checkbox", { name: /^Remote Beta/, checked: false });
    fireEvent.click(remote);
    expect(screen.getByRole("checkbox", { name: /^Remote Beta/, checked: true })).toBe(remote);
    fireEvent.click(screen.getByRole("checkbox", { name: /^DeepSeek V4 Flash/, checked: true }));
    fireEvent.click(screen.getByRole("button", { name: /高级设置/ }));
    const nameInput = screen.getByDisplayValue("Remote Beta");
    fireEvent.change(nameInput, { target: { value: "Beta [renamed]" } });
    expect(screen.getByRole("checkbox", { name: "启用模型 Beta [renamed]" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(onSaveVendor).toHaveBeenCalledWith(
        expect.objectContaining({
          models: [expect.objectContaining({ model: "remote/beta:v2", name: "Beta [renamed]" })],
        }),
        undefined,
      ),
    );
  });
});
