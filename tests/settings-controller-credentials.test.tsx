// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppBootstrapSnapshot } from "../src/renderer/src/app/appBootstrap";
import { useSettingsController } from "../src/renderer/src/app/useSettingsController";
import { resolveAgentGatewayPreferences } from "../src/shared/agent-gateway-config";
import { DEFAULT_AGENT_STEP_LIMITS } from "../src/shared/agent-step-limits";

const bootstrap: AppBootstrapSnapshot = {
  persistedUiSettings: {},
  initialColorScheme: "dark",
  initialComputedScheme: "dark",
  vendors: [
    {
      id: "vendor-one",
      kind: "custom",
      label: "Vendor One",
      protocol: "openai",
      baseURL: "https://old.example.com/v1",
      enabled: true,
      credentialConfigured: false,
      models: [
        {
          id: "model-one",
          name: "Model One",
          model: "model-one",
          openaiApiMode: "responses",
          enabled: true,
          pricing: null,
        },
      ],
    },
  ],
  models: [
    {
      id: "model-one",
      vendorId: "vendor-one",
      vendorKind: "custom",
      vendorLabel: "Vendor One",
      name: "Model One",
      provider: "openai",
      model: "model-one",
      baseURL: "https://old.example.com/v1",
      openaiApiMode: "responses",
      enabled: true,
      credentialConfigured: false,
    },
  ],
  selectedModelId: "model-one",
  agentStepLimits: DEFAULT_AGENT_STEP_LIMITS,
  agentGatewayPreferences: resolveAgentGatewayPreferences(),
  credentialReentryRequired: false,
};

function SettingsHarness({ notify }: { notify: (message: string) => void }) {
  const controller = useSettingsController(bootstrap, undefined, notify);
  const vendor = controller.vendors[0];
  return (
    <>
      <output aria-label="enabled models">
        {controller.enabledModels.map((item) => item.id).join(",")}
      </output>
      <output aria-label="credential configured">{String(vendor?.credentialConfigured)}</output>
      <button
        type="button"
        onClick={() => {
          if (vendor)
            void controller.saveVendor({
              ...vendor,
              baseURL: "https://new.example.com/v1",
            });
        }}
      >
        change binding
      </button>
      <button
        type="button"
        onClick={() => {
          if (vendor) void controller.saveVendor(vendor, "new-secret");
        }}
      >
        save key
      </button>
      <button
        type="button"
        onClick={() =>
          controller.setAgentGatewayPreferences({
            ...controller.agentGatewayPreferences,
            webSearchEndpoint: "https://search-proxy.example.com/v1",
          })
        }
      >
        change search endpoint
      </button>
    </>
  );
}

describe("useSettingsController credentials", () => {
  afterEach(cleanup);

  it("removes an old binding and excludes the model until a matching key exists", async () => {
    const deleteModelCredential = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        saveAgentSettings: vi.fn(async (value) => value),
        getCredentialStatus: vi.fn().mockImplementation(async (request) => ({
          storage: { state: "secure", backend: "unknown" },
          models: request.models.map((binding: { vendorId: string; baseURL?: string }) => ({
            vendorId: binding.vendorId,
            configured: binding.baseURL === "https://old.example.com/v1",
          })),
          webSearchConfigured: false,
        })),
        deleteModelCredential,
      },
    });

    render(<SettingsHarness notify={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByLabelText("enabled models").textContent).toBe("model-one"),
    );
    fireEvent.click(screen.getByRole("button", { name: "change binding" }));

    await waitFor(() =>
      expect(deleteModelCredential).toHaveBeenCalledWith({
        vendorId: "vendor-one",
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("credential configured").textContent).toBe("false"),
    );
    expect(screen.getByLabelText("enabled models").textContent).toBe("");
  });

  it("ignores a stale status response after a credential write succeeds", async () => {
    let resolveStatus!: (value: {
      storage: { state: "secure"; backend: "unknown" };
      models: Array<{ vendorId: string; configured: boolean }>;
      webSearchConfigured: boolean;
    }) => void;
    const status = new Promise<Parameters<typeof resolveStatus>[0]>((resolve) => {
      resolveStatus = resolve;
    });
    const setModelCredentials = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        saveAgentSettings: vi.fn(async (value) => value),
        getCredentialStatus: vi.fn().mockReturnValue(status),
        setModelCredentials,
      },
    });

    render(<SettingsHarness notify={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "save key" }));

    await waitFor(() => expect(setModelCredentials).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByLabelText("credential configured").textContent).toBe("true"),
    );
    await act(async () => {
      resolveStatus({
        storage: { state: "secure", backend: "unknown" },
        models: [{ vendorId: "vendor-one", configured: false }],
        webSearchConfigured: false,
      });
      await status;
    });

    expect(screen.getByLabelText("credential configured").textContent).toBe("true");
  });

  it("fails closed when credential status cannot be read", async () => {
    const notify = vi.fn();
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        saveAgentSettings: vi.fn(async (value) => value),
        getCredentialStatus: vi.fn().mockRejectedValue(new Error("corrupt store")),
      },
    });

    render(<SettingsHarness notify={notify} />);

    await waitFor(() => expect(screen.getByLabelText("enabled models").textContent).toBe(""));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("凭据状态读取失败")),
    );
  });

  it("clears a previously configured model when a later status refresh fails", async () => {
    const notify = vi.fn();
    const getCredentialStatus = vi
      .fn()
      .mockResolvedValueOnce({
        storage: { state: "secure", backend: "unknown" },
        models: [{ vendorId: "vendor-one", configured: true }],
        webSearchConfigured: false,
      })
      .mockRejectedValueOnce(new Error("refresh failed"));
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { saveAgentSettings: vi.fn(async (value) => value), getCredentialStatus },
    });

    render(<SettingsHarness notify={notify} />);
    await waitFor(() =>
      expect(screen.getByLabelText("enabled models").textContent).toBe("model-one"),
    );

    fireEvent.click(screen.getByRole("button", { name: "change search endpoint" }));

    await waitFor(() => expect(getCredentialStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByLabelText("enabled models").textContent).toBe(""));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("凭据状态读取失败")),
    );
  });
});
