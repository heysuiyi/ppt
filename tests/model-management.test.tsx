// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelManagement } from "../src/renderer/src/components/ModelManagement";
import type { ModelVendorConnection } from "../src/renderer/src/modelCatalog";
import { flattenVendors } from "../src/renderer/src/modelCatalog";

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
});
