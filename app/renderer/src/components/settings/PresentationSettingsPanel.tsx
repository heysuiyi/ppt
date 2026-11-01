import type { ProjectTemplateSummary } from "@app/shared/ipc";
import type { DesignSystemV2 } from "@design-system";
import { getBuiltinTemplate, listAutoPoolTemplates } from "@shared/template-catalog";
import {
  APPLICATION_DEFAULT_TEMPLATE_ID,
  type ProjectTemplatePolicy,
} from "@shared/template-protocol";
import React from "react";
import { Button } from "../Button";
import { Select } from "../Select";
import { SettingsPanel, SettingsRow, SettingsSection } from "./SettingsPrimitives";

type ProjectTemplatePackSummary = Awaited<
  ReturnType<typeof window.desktopApi.getProjectTemplatePack>
>;

type ProjectTemplateStatus = {
  policy: ProjectTemplatePolicy;
  templates: ProjectTemplateSummary[];
  pack: ProjectTemplatePackSummary;
};

type PackPalette = {
  background?: string;
  primary?: string;
  accent?: string;
  bodyText?: string;
  secondaryBg?: string;
  secondaryAccent?: string;
};

function projectPolicyLabel(
  sessionId: string | undefined,
  status: ProjectTemplateStatus | null,
  error: string | null,
  activeTemplate: ProjectTemplateSummary | undefined,
): string {
  if (!sessionId) return "无活动会话";
  if (error) return `读取失败：${error}`;
  if (!status) return "读取中…";
  if (status.policy.mode === "custom" && status.pack) {
    return `已应用到当前项目 · ${status.pack.name}（design-reference）`;
  }
  if (status.policy.mode === "custom" && activeTemplate) {
    return `自定义 · ${activeTemplate.name}（缺 pack，请重新应用）`;
  }
  if (status.policy.mode === "custom") {
    return (
      `自定义 · ${status.policy.customTemplateId ?? "?"}@` +
      `${status.policy.customTemplateRevisionId ?? "?"}（缺失，需重导）`
    );
  }
  if (status.policy.mode === "default") {
    return `固定默认 · ${status.policy.defaultTemplateId}`;
  }
  return `自动匹配 · 低置信回退 ${status.policy.defaultTemplateId}`;
}

function getPackPalette(pack: ProjectTemplatePackSummary): PackPalette | null {
  if (!pack?.designSystem || typeof pack.designSystem !== "object") return null;
  if (!("colorScheme" in pack.designSystem)) return null;
  const colorScheme = (pack.designSystem as { colorScheme?: unknown }).colorScheme;
  return typeof colorScheme === "object" && colorScheme !== null
    ? (colorScheme as PackPalette)
    : null;
}

export function PresentationSettingsPanel({
  selectedDesignSystem,
  defaultTemplateId,
  setDefaultTemplateId,
  activeSessionId,
  notify,
}: {
  selectedDesignSystem: DesignSystemV2;
  defaultTemplateId: string;
  setDefaultTemplateId: (value: string) => void;
  activeSessionId?: string;
  notify: (message: string) => void;
}) {
  const [status, setStatus] = React.useState<ProjectTemplateStatus | null>(null);
  const [statusError, setStatusError] = React.useState<string | null>(null);
  const [libraryTemplates, setLibraryTemplates] = React.useState<ProjectTemplateSummary[]>([]);

  const refreshLibraryTemplates = React.useCallback(async () => {
    try {
      setLibraryTemplates(await window.desktopApi.listApplicationTemplates());
    } catch {
      setLibraryTemplates([]);
    }
  }, []);

  const refreshProjectStatus = React.useCallback(async (sessionId: string) => {
    try {
      const [policy, templates, pack] = await Promise.all([
        window.desktopApi.getProjectTemplatePolicy(sessionId),
        window.desktopApi.listProjectTemplates(sessionId),
        window.desktopApi.getProjectTemplatePack(sessionId),
      ]);
      setStatus({ policy, templates, pack });
      setStatusError(null);
    } catch (error) {
      setStatus(null);
      setStatusError(error instanceof Error ? error.message : "读取项目模板状态失败");
    }
  }, []);

  React.useEffect(() => {
    void refreshLibraryTemplates();
  }, [refreshLibraryTemplates]);

  React.useEffect(() => {
    if (!activeSessionId) {
      setStatus(null);
      setStatusError(null);
      return;
    }
    void refreshProjectStatus(activeSessionId);
  }, [activeSessionId, refreshProjectStatus]);

  const uploadedTemplates = (status?.templates ?? []).filter((item) => item.kind === "uploaded");
  const activeCustomTemplate = uploadedTemplates.find(
    (item) =>
      item.id === status?.policy.customTemplateId &&
      item.revisionId === status?.policy.customTemplateRevisionId,
  );
  const projectPolicyMode = status?.policy.mode;
  const activePack = status?.pack ?? null;
  const packPalette = getPackPalette(activePack);
  const selectedColorSchemeName =
    typeof selectedDesignSystem.colorScheme === "string"
      ? selectedDesignSystem.colorScheme
      : (selectedDesignSystem.colorScheme.name ?? "custom");
  const templateOptions = [
    ...(listAutoPoolTemplates().length > 0
      ? listAutoPoolTemplates()
      : [getBuiltinTemplate(APPLICATION_DEFAULT_TEMPLATE_ID)!].filter(Boolean)
    ).map((template) => ({
      value: template.id,
      label: `${template.name}（${template.designSystem.visualStyle}）`,
    })),
    ...libraryTemplates.map((template) => ({
      value: template.id,
      label: `${template.name}（导入参考模板）`,
    })),
  ];

  const applyTemplate = async (template: ProjectTemplateSummary) => {
    if (!activeSessionId) return;
    try {
      await window.desktopApi.applyTemplateToProject(
        activeSessionId,
        template.id,
        template.revisionId,
      );
      await refreshProjectStatus(activeSessionId);
      notify(`已把「${template.name}」应用到当前项目`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "应用模板失败");
    }
  };

  const switchPolicy = async (mode: "auto" | "default") => {
    if (!activeSessionId || !status) return;
    try {
      await window.desktopApi.setProjectTemplatePolicy(activeSessionId, {
        mode,
        defaultTemplateId: status.policy.defaultTemplateId,
      });
      await refreshProjectStatus(activeSessionId);
      notify(mode === "auto" ? "已切换为自动匹配模板" : "已切换为固定默认模板");
    } catch (error) {
      notify(error instanceof Error ? error.message : "切换模板策略失败");
    }
  };

  const switchToCustomPolicy = async () => {
    if (!activeSessionId) return;
    const target = activeCustomTemplate ?? libraryTemplates[0] ?? uploadedTemplates[0];
    if (!target) {
      notify("请先导入参考模板");
      return;
    }
    try {
      await window.desktopApi.applyTemplateToProject(activeSessionId, target.id, target.revisionId);
      await refreshProjectStatus(activeSessionId);
      notify(`已应用自定义模板「${target.name}」`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "切换模板策略失败");
    }
  };

  const importTemplate = async () => {
    try {
      const selected = await window.desktopApi.selectTemplatePackage();
      if (!selected) return;
      const imported = await window.desktopApi.importProjectTemplate(activeSessionId, selected);
      if (activeSessionId) await refreshProjectStatus(activeSessionId);
      await refreshLibraryTemplates();
      const warningSuffix =
        imported.warnings.length > 0 ? `（${imported.warnings.length} 条警告）` : "";
      const scope = activeSessionId
        ? "并已应用到当前项目（写入 template-pack）"
        : "到模板库（可设为新项目默认或稍后应用）";
      notify(
        `${imported.reusedExisting ? "已复用" : "已导入"}参考模板` +
          `「${imported.name}」${scope}${warningSuffix}`,
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "导入参考模板失败");
    }
  };

  return (
    <SettingsPanel>
      <SettingsSection title="新项目默认">
        <SettingsRow label="画布比例">
          <span className="settings-hint">16:9 宽屏（当前唯一导出比例）</span>
        </SettingsRow>
        <SettingsRow label="新项目默认模板">
          <Select
            variant="settings"
            ariaLabel="新项目默认模板"
            value={defaultTemplateId}
            onChange={setDefaultTemplateId}
            options={templateOptions}
          />
        </SettingsRow>
        <SettingsRow label="说明">
          <span className="settings-hint">
            仅影响之后新建的项目。选择导入的参考模板时，新建对话会自动物化 template-pack + custom
            策略。已打开项目请用下方「应用到当前项目」。
            自动模式低置信度时回退到内置默认模板（非上传模板）。
          </span>
        </SettingsRow>
        <SettingsRow label="本地设计系统预览">
          <span className="settings-hint">
            {selectedDesignSystem.argumentMode} · {selectedDesignSystem.visualStyle} ·{" "}
            {selectedDesignSystem.readingMode} · {selectedColorSchemeName}
          </span>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="当前项目">
        <SettingsRow label="模板库（跨项目保留）">
          <span className="settings-hint">
            {libraryTemplates.length === 0
              ? "暂无导入模板"
              : libraryTemplates.map((item) => item.name).join("、")}
          </span>
        </SettingsRow>
        <SettingsRow label="当前项目策略">
          <span className="settings-hint">
            {projectPolicyLabel(activeSessionId, status, statusError, activeCustomTemplate)}
          </span>
        </SettingsRow>
        <SettingsRow label="应用到当前项目">
          <div className="settings-choice-group" role="group" aria-label="应用模板库模板">
            {libraryTemplates.length === 0 ? (
              <span className="settings-hint">先导入 PPTX/POTX 后可应用到项目</span>
            ) : (
              libraryTemplates.map((template) => {
                const active =
                  template.id === status?.policy.customTemplateId &&
                  template.revisionId === status?.policy.customTemplateRevisionId &&
                  projectPolicyMode === "custom" &&
                  Boolean(activePack);
                const isAppDefault = defaultTemplateId === template.id;
                return (
                  <div
                    key={`${template.id}@${template.revisionId}`}
                    className="settings-choice-group"
                  >
                    <Button
                      size="sm"
                      disabled={!activeSessionId}
                      aria-pressed={active}
                      onClick={() => void applyTemplate(template)}
                    >
                      <span>
                        {template.name}
                        {active ? "（已应用到当前项目）" : "（仅在模板库）"}
                      </span>
                    </Button>
                    <Button
                      size="sm"
                      aria-pressed={isAppDefault}
                      onClick={() => {
                        setDefaultTemplateId(template.id);
                        notify(`已把「${template.name}」设为新项目默认；之后新建对话将自动使用`);
                      }}
                    >
                      <span>{isAppDefault ? "新项目默认 ✓" : "设为新项目默认"}</span>
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        </SettingsRow>
        <SettingsRow label="继承预览">
          {!activePack ? (
            <span className="settings-hint">
              {activeSessionId ? "当前项目未应用参考模板 pack（仅在模板库或未导入）" : "无活动会话"}
            </span>
          ) : (
            <div className="settings-hint settings-palette-summary">
              <div className="settings-palette-row">
                <span>配色：</span>
                {packPalette
                  ? [
                      packPalette.background,
                      packPalette.primary,
                      packPalette.accent,
                      packPalette.bodyText,
                      packPalette.secondaryBg,
                      packPalette.secondaryAccent,
                    ]
                      .filter(Boolean)
                      .map((hex) => (
                        <span
                          key={hex}
                          title={hex}
                          className="settings-palette-swatch"
                          style={{ background: hex }}
                        />
                      ))
                  : "（无 custom palette）"}
              </div>
              <div>
                字体：{activePack.typography.sourceMajor || activePack.typography.title}
                {" / "}
                {activePack.typography.sourceMinor || activePack.typography.body}
              </div>
              <div>
                Logo：
                {activePack.inheritance.logo
                  ? activePack.assets
                      .filter((asset) => asset.role === "logo" || asset.role === "header")
                      .map((asset) => asset.path)
                      .join("、") || "已提取"
                  : "未提取"}
                {" · "}页眉页脚：{activePack.inheritance.headerFooter ? "有" : "无"}
                {" · "}标题框：{activePack.inheritance.titleFrame ? "有" : "无"}
              </div>
              <div>不继承：PowerPoint 母版切换、原 placeholder 编辑、导出母版关系</div>
              {(activePack.warnings?.length ?? 0) > 0 ? (
                <div>警告：{activePack.warnings!.slice(0, 3).join("；")}</div>
              ) : null}
            </div>
          )}
        </SettingsRow>
        <SettingsRow label="策略切换">
          <div className="settings-choice-group" role="group" aria-label="项目模板策略">
            <Button
              size="sm"
              disabled={!activeSessionId}
              onClick={() => void switchPolicy("auto")}
              aria-pressed={projectPolicyMode === "auto"}
            >
              <span>自动</span>
            </Button>
            <Button
              size="sm"
              disabled={!activeSessionId}
              onClick={() => void switchPolicy("default")}
              aria-pressed={projectPolicyMode === "default"}
            >
              <span>默认</span>
            </Button>
            <Button
              size="sm"
              disabled={
                !activeSessionId ||
                (libraryTemplates.length === 0 && uploadedTemplates.length === 0)
              }
              onClick={() => void switchToCustomPolicy()}
              aria-pressed={projectPolicyMode === "custom"}
            >
              <span>自定义</span>
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow label="能力等级">
          <span className="settings-hint">
            仅支持 design-reference（参考风格重生 SVG：配色/字体/logo/页眉页脚/标题框）。 不承诺
            PowerPoint 母版/占位符保真（master-backed 尚未启用）。
          </span>
        </SettingsRow>
        <SettingsRow label="导入 PPTX/POTX">
          <div className="settings-choice-group" role="group" aria-label="导入参考模板">
            <Button onClick={() => void importTemplate()}>选择并导入参考模板</Button>
          </div>
        </SettingsRow>
        <SettingsRow label="说明">
          <span className="settings-hint">
            模板存入应用模板库，切换会话不会丢失。应用到项目或设为新项目默认后，会物化
            design/template-pack.json（配色/字体/chrome/assets）并种子化 design-spec。 Agent
            必须沿用 pack，不得另选 builtin 风格。页面仍由 SVG 重生；导出不保留原母版。
          </span>
        </SettingsRow>
      </SettingsSection>
    </SettingsPanel>
  );
}
