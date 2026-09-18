import React from "react";
import { cx } from "../lib/cx";

export interface TitlebarTemplateMenuProps {
  activeSessionId?: string;
  defaultTemplateId: string;
  setDefaultTemplateId: (templateId: string) => void;
  onOpenTemplateSettings: () => void;
  notify: (message: string) => void;
}

/**
 * Compact titlebar menu for design-reference template import.
 * Reuses desktopApi import/list paths; does not embed SettingsView.
 */
export function TitlebarTemplateMenu({
  activeSessionId,
  defaultTemplateId,
  setDefaultTemplateId,
  onOpenTemplateSettings,
  notify,
}: TitlebarTemplateMenuProps) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [libraryCount, setLibraryCount] = React.useState(0);
  const [lastImportedId, setLastImportedId] = React.useState<string | null>(null);

  const refreshLibraryCount = React.useCallback(async () => {
    try {
      const list = await window.desktopApi.listApplicationTemplates();
      setLibraryCount(list.length);
    } catch {
      setLibraryCount(0);
    }
  }, []);

  React.useEffect(() => {
    void refreshLibraryCount();
  }, [refreshLibraryCount]);

  React.useEffect(() => {
    if (!open) return;
    void refreshLibraryCount();
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, refreshLibraryCount]);

  const canSetDefault = Boolean(lastImportedId) || libraryCount > 0;

  const handleImport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const selected = await window.desktopApi.selectTemplatePackage();
      if (!selected) return;
      const imported = await window.desktopApi.importProjectTemplate(activeSessionId, selected);
      setLastImportedId(imported.templateId);
      await refreshLibraryCount();
      const warningSuffix =
        imported.warnings.length > 0 ? `（${imported.warnings.length} 条警告）` : "";
      const scope = activeSessionId ? "并已应用到当前项目" : "到模板库";
      notify(
        `${imported.reusedExisting ? "已复用" : "已导入"}参考模板` +
          `「${imported.name}」${scope}${warningSuffix}`,
      );
      setOpen(false);
    } catch (error) {
      notify(error instanceof Error ? error.message : "导入参考模板失败");
    } finally {
      setBusy(false);
    }
  };

  const handleSetDefault = async () => {
    if (busy) return;
    setBusy(true);
    try {
      let templateId = lastImportedId;
      if (!templateId) {
        const list = await window.desktopApi.listApplicationTemplates();
        templateId = list[0]?.id ?? null;
      }
      if (!templateId) {
        notify("请先导入参考模板");
        return;
      }
      setDefaultTemplateId(templateId);
      notify("已设为新项目默认参考模板；之后新建对话将自动使用");
      setOpen(false);
    } catch (error) {
      notify(error instanceof Error ? error.message : "设置默认模板失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} className={cx("window-titlebar-template-menu", open && "is-open")}>
      <button
        type="button"
        className="window-titlebar-menu-trigger"
        title="参考模板"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        模板
      </button>
      {open ? (
        <div className="window-titlebar-menu" role="menu" aria-label="参考模板菜单">
          <button
            type="button"
            className="window-titlebar-menu-item"
            role="menuitem"
            disabled={busy}
            onClick={() => void handleImport()}
          >
            导入参考模板…
          </button>
          <button
            type="button"
            className="window-titlebar-menu-item"
            role="menuitem"
            disabled={busy || !canSetDefault}
            onClick={() => void handleSetDefault()}
          >
            设为新项目默认
            {defaultTemplateId.startsWith("uploaded/") ? " ✓" : ""}
          </button>
          <button
            type="button"
            className="window-titlebar-menu-item"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              onOpenTemplateSettings();
            }}
          >
            打开模板设置
          </button>
        </div>
      ) : null}
    </div>
  );
}
