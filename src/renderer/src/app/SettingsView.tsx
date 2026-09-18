import type { ComponentProps } from "react";
import { SettingsSidebar } from "../components/SettingsSidebar";
import { AgentBehaviorSettingsPanel } from "../components/settings/AgentSettingsPanels";
import { AppearanceSettingsPanel } from "../components/settings/AppearanceSettingsPanel";
import { DataSettingsPanel } from "../components/settings/DataSettingsPanel";
import {
  ModelListSettingsPanel,
  ModelRuntimeSettingsPanel,
  useWebSearchSettings,
  type WebSearchSettingsController,
  WebSearchSettingsPanel,
} from "../components/settings/ModelSettingsPanels";
import { PresentationSettingsPanel } from "../components/settings/PresentationSettingsPanel";
import { SettingsPanel } from "../components/settings/SettingsPrimitives";
import { TokenUsageOverview } from "../components/TokenUsageOverview";
import { cx } from "../lib/cx";
import type { SettingsCategory } from "../settingsCategories";
import type { SettingsController } from "./useSettingsController";
import type { ResizablePanel } from "./useWorkbenchLayout";

interface SettingsViewProps {
  activeCategory: ComponentProps<typeof SettingsSidebar>["activeCategory"];
  onSelectCategory: ComponentProps<typeof SettingsSidebar>["onSelectCategory"];
  onBackToWorkspace: () => void;
  controller: Pick<
    SettingsController,
    | "vendors"
    | "models"
    | "selectedModelId"
    | "selectModel"
    | "saveVendor"
    | "deleteVendor"
    | "deleteModel"
    | "setVendorEnabled"
    | "setModelEnabled"
    | "credentialStorageStatus"
    | "webSearchCredentialConfigured"
    | "saveWebSearchCredential"
    | "deleteWebSearchCredential"
    | "selectedDesignSystem"
    | "defaultTemplateId"
    | "setDefaultTemplateId"
    | "agentStepLimits"
    | "setAgentStepLimits"
    | "agentGatewayPreferences"
    | "setAgentGatewayPreferences"
    | "executionStrategy"
    | "setExecutionStrategy"
    | "colorScheme"
    | "setColorScheme"
    | "uiThemeId"
    | "setUiThemeId"
    | "uiThemes"
    | "refreshUiThemes"
    | "openUiThemesDirectory"
    | "uiFontFamily"
    | "setUiFontFamily"
    | "uiFontSize"
    | "setUiFontSize"
    | "uiLineHeight"
    | "setUiLineHeight"
    | "saveStatus"
  >;
  localStoragePath: string;
  onOpenWorkspace: () => void;
  notify: (message: string) => void;
  onStartPanelResize: (panel: ResizablePanel, startClientX: number) => void;
  activeSessionId?: string;
}

const categoryTitles: Record<SettingsCategory, string> = {
  appearance: "外观",
  models: "模型",
  "web-search": "联网搜索",
  templates: "模板",
  agent: "Agent 行为",
  data: "数据与日志",
  usage: "用量",
};

function renderCategory(
  props: SettingsViewProps,
  webSearchController: WebSearchSettingsController,
) {
  switch (props.activeCategory) {
    case "usage":
      return (
        <SettingsPanel>
          <TokenUsageOverview
            models={props.controller.models}
            selectedModelId={props.controller.selectedModelId}
          />
        </SettingsPanel>
      );
    case "models":
      return (
        <div className="settings-panel-stack">
          <ModelListSettingsPanel
            vendors={props.controller.vendors}
            models={props.controller.models}
            selectedModelId={props.controller.selectedModelId}
            onSelectModel={props.controller.selectModel}
            onSaveVendor={props.controller.saveVendor}
            onDeleteVendor={props.controller.deleteVendor}
            onDeleteModel={props.controller.deleteModel}
            onSetVendorEnabled={props.controller.setVendorEnabled}
            onSetModelEnabled={props.controller.setModelEnabled}
            credentialStorageStatus={props.controller.credentialStorageStatus}
            notify={props.notify}
          />
          <ModelRuntimeSettingsPanel
            models={props.controller.models}
            selectedModelId={props.controller.selectedModelId}
            credentialStorageStatus={props.controller.credentialStorageStatus}
            preferences={props.controller.agentGatewayPreferences}
            setPreferences={props.controller.setAgentGatewayPreferences}
          />
        </div>
      );
    case "web-search":
      return (
        <WebSearchSettingsPanel
          credentialStorageStatus={props.controller.credentialStorageStatus}
          credentialConfigured={props.controller.webSearchCredentialConfigured}
          preferences={props.controller.agentGatewayPreferences}
          setPreferences={props.controller.setAgentGatewayPreferences}
          controller={webSearchController}
        />
      );
    case "agent":
      return (
        <AgentBehaviorSettingsPanel
          executionStrategy={props.controller.executionStrategy}
          setExecutionStrategy={props.controller.setExecutionStrategy}
          limits={props.controller.agentStepLimits}
          setLimits={props.controller.setAgentStepLimits}
        />
      );
    case "data":
      return (
        <DataSettingsPanel
          localStoragePath={props.localStoragePath}
          onOpenWorkspace={props.onOpenWorkspace}
          notify={props.notify}
        />
      );
    case "templates":
      return (
        <PresentationSettingsPanel
          selectedDesignSystem={props.controller.selectedDesignSystem}
          defaultTemplateId={props.controller.defaultTemplateId}
          setDefaultTemplateId={props.controller.setDefaultTemplateId}
          activeSessionId={props.activeSessionId}
          notify={props.notify}
        />
      );
    case "appearance":
      return (
        <AppearanceSettingsPanel
          colorScheme={props.controller.colorScheme}
          setColorScheme={props.controller.setColorScheme}
          uiThemeId={props.controller.uiThemeId}
          setUiThemeId={props.controller.setUiThemeId}
          uiThemes={props.controller.uiThemes}
          onRefreshUiThemes={props.controller.refreshUiThemes}
          onOpenUiThemesDirectory={props.controller.openUiThemesDirectory}
          uiFontFamily={props.controller.uiFontFamily}
          setUiFontFamily={props.controller.setUiFontFamily}
          uiFontSize={props.controller.uiFontSize}
          setUiFontSize={props.controller.setUiFontSize}
          uiLineHeight={props.controller.uiLineHeight}
          setUiLineHeight={props.controller.setUiLineHeight}
        />
      );
    default: {
      const exhaustiveCategory: never = props.activeCategory;
      return exhaustiveCategory;
    }
  }
}

export function SettingsView(props: SettingsViewProps) {
  const { activeCategory, onSelectCategory, onBackToWorkspace, onStartPanelResize } = props;
  const webSearchController = useWebSearchSettings({
    preferences: props.controller.agentGatewayPreferences,
    setPreferences: props.controller.setAgentGatewayPreferences,
    onSaveCredential: props.controller.saveWebSearchCredential,
    onDeleteCredential: props.controller.deleteWebSearchCredential,
    notify: props.notify,
  });
  const saveStatus = props.controller.saveStatus;
  return (
    <>
      <div className="primary-sidebar-slot">
        <SettingsSidebar
          activeCategory={activeCategory}
          onSelectCategory={onSelectCategory}
          onBackToWorkspace={onBackToWorkspace}
        />
      </div>
      <div
        className="panel-resizer panel-resizer--primary"
        role="separator"
        aria-label="调整设置导航宽度"
        aria-orientation="vertical"
        onPointerDown={(event) => {
          event.preventDefault();
          onStartPanelResize("primary", event.clientX);
        }}
      />
      <div key="settings" className="rounded-canvas view-enter" data-ui-region="canvas">
        <div className="settings-page settings-console-container" data-ui-region="settings">
          <div className="settings-page-inner">
            <header className="settings-page-header">
              <h1 className="settings-page-title">{categoryTitles[activeCategory]}</h1>
              {activeCategory !== "usage" ? (
                <span className={cx("settings-status", saveStatus === "saving" && "is-saving")}>
                  {saveStatus === "failed"
                    ? "保存失败"
                    : saveStatus === "saving"
                      ? "保存中…"
                      : "已保存"}
                </span>
              ) : null}
            </header>
            <div key={activeCategory} className="view-enter">
              {renderCategory(props, webSearchController)}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
