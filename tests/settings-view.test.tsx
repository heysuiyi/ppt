// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESIGN_SYSTEM } from "../src/design-system";
import { SettingsView } from "../src/renderer/src/app/SettingsView";
import { MAX_UI_FONT_SIZE } from "../src/renderer/src/app/uiTypography";
import {
  DEFAULT_WEB_SEARCH_ENDPOINT,
  resolveAgentGatewayPreferences,
} from "../src/shared/agent-gateway-config";
import { DEFAULT_AGENT_STEP_LIMITS } from "../src/shared/agent-step-limits";
import { MAX_OUTPUT_TOKENS } from "../src/shared/generation-settings-inputs";

type SettingsRegionProps = ComponentProps<typeof SettingsView>["controller"] &
  Pick<
    ComponentProps<typeof SettingsView>,
    "activeCategory" | "activeSessionId" | "localStoragePath" | "onOpenWorkspace" | "notify"
  >;

function SettingsRegion({
  activeCategory,
  activeSessionId,
  localStoragePath,
  onOpenWorkspace,
  notify,
  ...controller
}: SettingsRegionProps) {
  return (
    <SettingsView
      activeCategory={activeCategory}
      activeSessionId={activeSessionId}
      localStoragePath={localStoragePath}
      onOpenWorkspace={onOpenWorkspace}
      notify={notify}
      controller={controller}
      onSelectCategory={vi.fn()}
      onBackToWorkspace={vi.fn()}
      onStartPanelResize={vi.fn()}
    />
  );
}

function renderSearchSettings(overrides: Partial<ComponentProps<typeof SettingsRegion>> = {}) {
  const props: ComponentProps<typeof SettingsRegion> = {
    saveStatus: "saved",
    activeCategory: "web-search",
    vendors: [],
    models: [],
    selectedModelId: "",
    selectModel: vi.fn(),
    saveVendor: vi.fn().mockResolvedValue(true),
    deleteVendor: vi.fn().mockResolvedValue(true),
    deleteModel: vi.fn().mockResolvedValue(true),
    setVendorEnabled: vi.fn().mockResolvedValue(true),
    setModelEnabled: vi.fn().mockResolvedValue(true),
    credentialStorageStatus: {
      state: "degraded",
      backend: "basic_text",
      warning: "linux-basic-text",
    },
    webSearchCredentialConfigured: true,
    saveWebSearchCredential: vi.fn().mockResolvedValue(true),
    deleteWebSearchCredential: vi.fn().mockResolvedValue(true),
    selectedDesignSystem: DEFAULT_DESIGN_SYSTEM,
    defaultTemplateId: "default",
    setDefaultTemplateId: vi.fn(),
    localStoragePath: "",
    onOpenWorkspace: vi.fn(),
    agentStepLimits: DEFAULT_AGENT_STEP_LIMITS,
    setAgentStepLimits: vi.fn(),
    agentGatewayPreferences: resolveAgentGatewayPreferences(),
    setAgentGatewayPreferences: vi.fn(),
    executionStrategy: "REQUEST_APPROVAL",
    setExecutionStrategy: vi.fn(),
    colorScheme: "dark",
    setColorScheme: vi.fn(),
    uiThemeId: "studio",
    setUiThemeId: vi.fn(),
    uiThemes: [],
    refreshUiThemes: vi.fn(),
    openUiThemesDirectory: vi.fn(),
    uiFontFamily: "system",
    setUiFontFamily: vi.fn(),
    uiFontSize: 14,
    setUiFontSize: vi.fn(),
    uiLineHeight: 1.5,
    setUiLineHeight: vi.fn(),
    notify: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<SettingsRegion {...props} />) };
}

describe("SettingsRegion credential controls", () => {
  afterEach(cleanup);

  beforeEach(() => {
    const pending = new Promise<never>(() => undefined);
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        listApplicationTemplates: vi.fn().mockReturnValue(pending),
        getApplicationDataPath: vi.fn().mockReturnValue(pending),
      },
    });
  });

  it("keeps the Tavily key in local draft state and saves it explicitly", async () => {
    const saveWebSearchCredential = vi.fn().mockResolvedValue(true);
    renderSearchSettings({ saveWebSearchCredential });

    expect(screen.getByText(/Linux basic_text/)).toBeTruthy();
    expect(screen.getByText(/已配置（系统安全存储或环境变量）/)).toBeTruthy();
    const keyInput = screen.getByLabelText("Tavily API Key");
    fireEvent.change(keyInput, { target: { value: "tvly-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(saveWebSearchCredential).toHaveBeenCalledWith(
        "tvly-secret",
        DEFAULT_WEB_SEARCH_ENDPOINT,
      ),
    );
    expect((keyInput as HTMLInputElement).value).toBe("");
  });

  it("clears the secure-store entry only through the explicit action", async () => {
    const deleteWebSearchCredential = vi.fn().mockResolvedValue(true);
    renderSearchSettings({ deleteWebSearchCredential });

    fireEvent.click(screen.getByRole("button", { name: "清除" }));

    await waitFor(() => expect(deleteWebSearchCredential).toHaveBeenCalledTimes(1));
  });

  it("excludes models without a resolved credential from fallback choices", () => {
    renderSearchSettings({
      activeCategory: "models",
      credentialStorageStatus: { state: "secure", backend: "unknown" },
      selectedModelId: "primary",
      models: [
        {
          id: "primary",
          name: "Primary",
          provider: "openai",
          model: "primary",
          baseURL: "https://example.com/v1",
          openaiApiMode: "responses",
          credentialConfigured: true,
        },
        {
          id: "configured-fallback",
          name: "Configured Fallback",
          provider: "openai",
          model: "configured",
          baseURL: "https://example.com/v1",
          openaiApiMode: "responses",
          credentialConfigured: true,
        },
        {
          id: "missing-fallback",
          name: "Missing Fallback",
          provider: "openai",
          model: "missing",
          baseURL: "https://example.com/v1",
          openaiApiMode: "responses",
          credentialConfigured: false,
        },
      ],
    });

    expect(screen.getByText("2 个模型可用")).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox", { name: "服务繁忙时备用模型" }));
    expect(screen.getByRole("option", { name: /Configured Fallback/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Missing Fallback/ })).toBeNull();
  });

  it("keeps an unsaved Tavily key draft while switching categories", () => {
    const view = renderSearchSettings();
    fireEvent.change(screen.getByLabelText("Tavily API Key"), {
      target: { value: "tvly-unsaved" },
    });

    view.rerender(<SettingsRegion {...view.props} activeCategory="agent" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Agent 行为");
    expect(screen.queryByLabelText("Tavily API Key")).toBeNull();

    view.rerender(<SettingsRegion {...view.props} activeCategory="web-search" />);
    expect((screen.getByLabelText("Tavily API Key") as HTMLInputElement).value).toBe(
      "tvly-unsaved",
    );
  });

  it("does not load presentation or storage data for unrelated categories", () => {
    const listApplicationTemplates = vi.fn();
    const getApplicationDataPath = vi.fn();
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { listApplicationTemplates, getApplicationDataPath },
    });

    renderSearchSettings({ activeCategory: "agent", saveStatus: "saving" });

    expect(screen.getByText("保存中…")).toBeTruthy();
    expect(listApplicationTemplates).not.toHaveBeenCalled();
    expect(getApplicationDataPath).not.toHaveBeenCalled();
  });

  it("normalizes output length and appearance drafts on blur", () => {
    const setAgentGatewayPreferences = vi.fn();
    const runtime = renderSearchSettings({
      activeCategory: "models",
      setAgentGatewayPreferences,
    });
    const outputLength = screen.getByRole("spinbutton");
    fireEvent.change(outputLength, { target: { value: "999999999" } });
    fireEvent.blur(outputLength);
    expect(setAgentGatewayPreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      }),
    );

    const setUiFontSize = vi.fn();
    runtime.rerender(
      <SettingsRegion
        {...runtime.props}
        activeCategory="appearance"
        setUiFontSize={setUiFontSize}
      />,
    );
    const fontSize = screen.getByLabelText("基准字号");
    fireEvent.change(fontSize, { target: { value: "999" } });
    fireEvent.blur(fontSize);
    expect(setUiFontSize).toHaveBeenCalledWith(MAX_UI_FONT_SIZE);
  });
});

describe("SettingsRegion presentation settings", () => {
  afterEach(cleanup);

  const libraryTemplate = {
    id: "library-template",
    revisionId: "revision-1",
    name: "Brand Template",
    kind: "uploaded" as const,
    supportLevel: "design-reference" as const,
    description: "Brand reference",
  };

  function installPresentationApi(applyTemplateToProject = vi.fn().mockResolvedValue(undefined)) {
    const api = {
      listApplicationTemplates: vi.fn().mockResolvedValue([libraryTemplate]),
      getProjectTemplatePolicy: vi.fn().mockResolvedValue({
        version: 1,
        mode: "auto",
        defaultTemplateId: "minimal",
      }),
      listProjectTemplates: vi.fn().mockResolvedValue([]),
      getProjectTemplatePack: vi.fn().mockResolvedValue(null),
      applyTemplateToProject,
    };
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: api,
    });
    return api;
  }

  it("loads template data only when the presentation category is active", async () => {
    const api = installPresentationApi();
    renderSearchSettings({
      activeCategory: "templates",
      activeSessionId: "session-1",
    });

    await waitFor(() => expect(api.listApplicationTemplates).toHaveBeenCalledTimes(1));
    expect(api.getProjectTemplatePolicy).toHaveBeenCalledWith("session-1");
    expect(api.listProjectTemplates).toHaveBeenCalledWith("session-1");
    expect(api.getProjectTemplatePack).toHaveBeenCalledWith("session-1");
    expect(await screen.findByText(/Brand Template（仅在模板库）/)).toBeTruthy();
  });

  it("applies a library template and reports success", async () => {
    const api = installPresentationApi();
    const notify = vi.fn();
    renderSearchSettings({
      activeCategory: "templates",
      activeSessionId: "session-1",
      notify,
    });

    fireEvent.click(await screen.findByRole("button", { name: /Brand Template（仅在模板库）/ }));
    await waitFor(() =>
      expect(api.applyTemplateToProject).toHaveBeenCalledWith(
        "session-1",
        "library-template",
        "revision-1",
      ),
    );
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith("已把「Brand Template」应用到当前项目"),
    );
  });

  it("reports a template application failure", async () => {
    installPresentationApi(vi.fn().mockRejectedValue(new Error("template failed")));
    const notify = vi.fn();
    renderSearchSettings({
      activeCategory: "templates",
      activeSessionId: "session-1",
      notify,
    });

    fireEvent.click(await screen.findByRole("button", { name: /Brand Template（仅在模板库）/ }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("template failed"));
  });
});
