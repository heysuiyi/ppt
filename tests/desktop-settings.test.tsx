// @vitest-environment jsdom

import type {
  AgentConfigurationSnapshot,
  AgentPreferences,
  SaveAgentVendorRequest,
} from "@agent-harness/configuration/configuration-contract";
import { DEFAULT_AGENT_GATEWAY_CONFIG } from "@agent-harness/configuration/gateway-settings";
import type { ListRemoteModelsResult } from "@agent-harness/configuration/remote-models";
import { DEFAULT_AGENT_STEP_LIMITS } from "@agent-harness/configuration/step-limits";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopSettings } from "../app/renderer/src/desktop/DesktopSettings";
import {
  changeConnectionAdapter,
  connectionAddress,
  connectionBindingChanged,
  connectionURL,
  newConnectionModel,
} from "../app/renderer/src/desktop/desktop-settings-model";
import { useDesktopConfiguration } from "../app/renderer/src/desktop/useDesktopConfiguration";
import { UiProvider } from "../app/renderer/src/ui/provider/UiProvider";

function initialConfiguration(): AgentConfigurationSnapshot {
  return {
    settings: {
      vendors: [
        {
          id: "vendor",
          kind: "openai",
          label: "OpenAI",
          protocol: "openai",
          baseURL: "https://api.openai.com/v1",
          enabled: true,
          models: [
            {
              id: "model",
              name: "GPT",
              model: "gpt-4o",
              openaiApiMode: "responses",
              enabled: true,
            },
          ],
        },
      ],
      gateway: { ...DEFAULT_AGENT_GATEWAY_CONFIG, webSearchTimeoutMs: 1234 },
      stepLimits: { ...DEFAULT_AGENT_STEP_LIMITS },
      executionStrategy: "REQUEST_APPROVAL",
      defaultTemplateId: "preserved-template",
      cli: { defaultModelId: "model" },
    },
    credentials: {
      storage: { state: "secure", backend: "unknown" },
      models: [{ vendorId: "vendor", configured: true }],
      webSearchConfigured: false,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function installApi() {
  let current = initialConfiguration();
  const api = {
    getAgentConfiguration: vi.fn(
      async (): Promise<AgentConfigurationSnapshot | undefined> => current,
    ),
    initializeAgentConfiguration: vi.fn(async () => current),
    saveAgentVendor: vi.fn(async (request: SaveAgentVendorRequest) => {
      const present = current.settings.vendors.some((vendor) => vendor.id === request.vendor.id);
      current = {
        ...current,
        settings: {
          ...current.settings,
          vendors: present
            ? current.settings.vendors.map((vendor) =>
                vendor.id === request.vendor.id ? request.vendor : vendor,
              )
            : [...current.settings.vendors, request.vendor],
        },
      };
      return current;
    }),
    deleteAgentVendor: vi.fn(async (id: string) => {
      current = {
        ...current,
        settings: {
          ...current.settings,
          vendors: current.settings.vendors.filter((vendor) => vendor.id !== id),
          cli: {},
        },
      };
      return current;
    }),
    saveAgentPreferences: vi.fn(async (preferences: AgentPreferences) => {
      current = { ...current, settings: { ...current.settings, ...preferences } };
      return current;
    }),
    listRemoteModels: vi.fn(
      async (): Promise<ListRemoteModelsResult> => ({
        models: [{ id: "remote-model", displayName: "Discovered" }],
      }),
    ),
  };
  const harness = {
    setDefaultModel: vi.fn(async (modelId?: string) => {
      current = { ...current, settings: { ...current.settings, cli: { defaultModelId: modelId } } };
      return { ok: true as const, value: {} };
    }),
  };
  Object.defineProperty(window, "desktopApi", { configurable: true, value: api });
  Object.defineProperty(window, "harnessDesktop", { configurable: true, value: harness });
  return { api, harness };
}

beforeEach(() => {
  // jsdom 不提供 Chromium 的 top-layer 和定位观察器；只补浏览器能力，不替代业务 UI。
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "showPopover", {
    configurable: true,
    value: function (this: HTMLElement) {
      this.dataset.testPopoverOpen = "true";
      this.style.display = "block";
    },
  });
  Object.defineProperty(HTMLElement.prototype, "hidePopover", {
    configurable: true,
    value: function (this: HTMLElement) {
      delete this.dataset.testPopoverOpen;
      this.style.display = "none";
    },
  });
  Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
    configurable: true,
    value: () => true,
  });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector) {
    return selector === ":popover-open"
      ? (this as HTMLElement).dataset.testPopoverOpen === "true"
      : matches.call(this, selector);
  });
  const querySelector = document.querySelector.bind(document);
  vi.spyOn(document, "querySelector").mockImplementation(
    <E extends Element = Element>(selector: string): E | null =>
      querySelector<E>(selector === "dialog:modal" ? "dialog[open]" : selector),
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 20,
    y: 20,
    top: 20,
    left: 20,
    bottom: 50,
    right: 220,
    width: 200,
    height: 30,
    toJSON: () => ({}),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("CSS", { escape: (value: string) => value });
});
afterEach(async () => {
  cleanup();
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderSettings(onChanged = vi.fn(), onBack = vi.fn(), onThemeChange = vi.fn()) {
  render(
    <UiProvider theme="dark">
      <DesktopSettings
        onBack={onBack}
        onChanged={onChanged}
        theme="dark"
        onThemeChange={onThemeChange}
      />
    </UiProvider>,
  );
  return { onChanged, onBack, onThemeChange };
}

async function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("桌面真实配置设置", () => {
  it("没有配置时只初始化空配置，不传入旧 UI 数据", async () => {
    const { api } = installApi();
    api.getAgentConfiguration.mockResolvedValueOnce(undefined);
    renderSettings();
    await screen.findByRole("button", { name: "创建连接" });
    expect(api.initializeAgentConfiguration).toHaveBeenCalledWith();
  });

  it("新连接只把新输入的 Key 发送给安全配置 IPC，保存后清空且不写浏览器存储", async () => {
    const { api } = installApi();
    const { onChanged } = renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "创建连接" }));
    const dialog = screen.getByRole("dialog", { name: "创建连接" });
    await choose("厂商 / 协议", "OpenAI Chat Completions");
    expect(within(dialog).getByRole("combobox", { name: "厂商 / 协议" }).textContent).toContain(
      "OpenAI Chat Completions",
    );
    fireEvent.change(within(dialog).getByLabelText(/^名称/), {
      target: { value: "Private connection" },
    });
    const key = within(dialog).getByLabelText(/^新的 API Key/) as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(key.value).toBe("");
    fireEvent.change(key, { target: { value: "new-test-secret" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "手工添加模型" }));
    fireEvent.change(within(dialog).getByLabelText(/^模型 1 标识/), {
      target: { value: "manual-model" },
    });
    fireEvent.change(within(dialog).getByLabelText(/^模型 1 显示名称/), {
      target: { value: "Manual model" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存连接" }));
    await waitFor(() => expect(api.saveAgentVendor).toHaveBeenCalledTimes(1));
    expect(api.saveAgentVendor.mock.calls[0]![0]).toMatchObject({
      vendor: {
        label: "Private connection",
        models: [
          {
            model: "manual-model",
            name: "Manual model",
            enabled: true,
            openaiApiMode: "chat-completions",
          },
        ],
      },
      credential: { type: "replace", apiKey: "new-test-secret" },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(localStorage.length).toBe(0);
    expect(document.body.textContent).not.toContain("new-test-secret");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("已有连接不读回 Key，保留凭据发现模型，过期发现结果不污染改过地址的草稿", async () => {
    const { api } = installApi();
    const discovery = deferred<{ models: { id: string }[] }>();
    api.listRemoteModels.mockImplementationOnce(() => discovery.promise);
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "编辑 OpenAI" }));
    expect(screen.queryByLabelText(/^新的 API Key/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "发现模型" }));
    expect(api.listRemoteModels).toHaveBeenCalledWith({ type: "saved-vendor", vendorId: "vendor" });
    fireEvent.change(screen.getByLabelText("地址"), {
      target: { value: "https://changed.example/v1" },
    });
    await act(async () => discovery.resolve({ models: [{ id: "stale-result" }] }));
    expect(screen.queryByText("stale-result")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    await screen.findByText(/原凭据不会用于新连接/);
    expect(api.saveAgentVendor).not.toHaveBeenCalled();
  });

  it("发现结果选择后才保存模型，取消未保存编辑需要确认", async () => {
    const { api } = installApi();
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "编辑 OpenAI" }));
    fireEvent.click(screen.getByRole("button", { name: "发现模型" }));
    await screen.findByText("Discovered");
    fireEvent.click(screen.getByRole("button", { name: "添加", exact: true }));
    expect(api.saveAgentVendor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消", exact: true }));
    await screen.findByRole("dialog", { name: "放弃修改？" });
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    await waitFor(() => expect(api.saveAgentVendor).toHaveBeenCalledTimes(1));
    expect(api.saveAgentVendor.mock.calls[0]![0]).toMatchObject({
      credential: { type: "keep" },
      vendor: { models: [{ id: "model" }, { model: "remote-model", name: "Discovered" }] },
    });
  });

  it("删除需明确确认；默认模型通过 CLI 同源偏好入口而不是 gateway fallback", async () => {
    const { api, harness } = installApi();
    renderSettings();
    await screen.findByRole("button", { name: "编辑 OpenAI" });
    await choose("默认模型", "未设置默认模型");
    await waitFor(() => expect(harness.setDefaultModel).toHaveBeenCalledWith(undefined));
    expect(api.saveAgentPreferences).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除 OpenAI" }));
    expect(api.deleteAgentVendor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除连接", exact: true }));
    await waitFor(() => expect(api.deleteAgentVendor).toHaveBeenCalledWith("vendor"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("偏好保留不属于新宿主的字段，离开确认和主题开关真实可用", async () => {
    const { api } = installApi();
    const { onBack, onThemeChange } = renderSettings();
    await screen.findByRole("button", { name: "创建连接" });
    fireEvent.click(screen.getByRole("button", { name: "运行偏好", exact: true }));
    fireEvent.change(screen.getByLabelText(/^最多模型轮数/), { target: { value: "35" } });
    fireEvent.click(screen.getByRole("button", { name: "返回会话" }));
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "保存偏好" }));
    await waitFor(() =>
      expect(api.saveAgentPreferences).toHaveBeenCalledWith({
        gateway: { ...DEFAULT_AGENT_GATEWAY_CONFIG, webSearchTimeoutMs: 1234 },
        executionStrategy: "REQUEST_APPROVAL",
        defaultTemplateId: "preserved-template",
        stepLimits: { ...DEFAULT_AGENT_STEP_LIMITS, mainMaxSteps: 35 },
      }),
    );
    await screen.findByText(/运行偏好已保存/);
    fireEvent.click(screen.getByRole("button", { name: "外观", exact: true }));
    fireEvent.click(screen.getByRole("radio", { name: "浅色" }));
    expect(onThemeChange).toHaveBeenCalledWith("light");
  });

  it("保存失败不回显 SDK 异常或密钥，保留编辑供用户修正", async () => {
    const { api } = installApi();
    api.saveAgentVendor.mockRejectedValueOnce(new Error("private-sdk-secret-details"));
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "编辑 OpenAI" }));
    fireEvent.change(screen.getByLabelText(/^名称/), { target: { value: "Retained" } });
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    await screen.findByText(/未能保存连接/);
    expect((screen.getByLabelText(/^名称/) as HTMLInputElement).value).toBe("Retained");
    expect(document.body.textContent).not.toContain("private-sdk-secret-details");
  });

  it("写入 pending 阻止重复提交，卸载后不通知已失效页面", async () => {
    installApi();
    const changed = vi.fn();
    const write = deferred<AgentConfigurationSnapshot>();
    const operation = vi.fn(() => write.promise);
    const hook = renderHook(() => useDesktopConfiguration(changed));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    let first!: Promise<boolean>;
    act(() => {
      first = hook.result.current.commit(operation, "Saved");
    });
    await act(async () => {
      expect(await hook.result.current.commit(operation, "Duplicate")).toBe(false);
    });
    expect(operation).toHaveBeenCalledTimes(1);
    hook.unmount();
    await act(async () => {
      write.resolve(initialConfiguration());
      expect(await first).toBe(false);
    });
    expect(changed).not.toHaveBeenCalled();
  });

  it("MiMo 协议取公开固定地址并约束 Responses，连接列表隐藏嵌入的秘密", () => {
    const original = initialConfiguration().settings.vendors[0]!;
    const mimo = changeConnectionAdapter(original, "mimo-token-plan-cn");
    expect(mimo.kind).toBe("mimo-token-plan-cn");
    expect(mimo.protocol).toBe("openai");
    expect(mimo.baseURL).toMatch(/^https:\/\//);
    expect(mimo.models[0]?.openaiApiMode).toBe("responses");
    expect(newConnectionModel(mimo, "mimo-v2.6-pro").openaiApiMode).toBe("responses");
    expect(connectionAddress("https://user:password@example.test/v1?token=hidden#secret")).toBe(
      "https://example.test/v1",
    );
    expect(
      connectionBindingChanged(original, { ...original, baseURL: `${original.baseURL}/` }),
    ).toBe(false);
    expect(connectionBindingChanged(original, { ...original, baseURL: "" })).toBe(false);
    expect(connectionURL({ ...original, baseURL: "" })).toBe(original.baseURL);
  });
});
