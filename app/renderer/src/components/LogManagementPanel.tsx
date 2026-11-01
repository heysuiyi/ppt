import type { AppLogEntry, AppLogLevel, LogManagerStatus } from "@shared/logging";
import { normalizeWorkspacePath } from "@shared/workspace";
import React from "react";
import { Button } from "./Button";
import { FolderIcon, RefreshIcon, TrashIcon } from "./Icons";
import { Select } from "./Select";
import { Switch } from "./Switch";
import { RangeField, SettingsRow, SettingsSection } from "./settings/SettingsPrimitives";

interface LogManagementPanelProps {
  notify: (message: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatEntryDetail(entry: AppLogEntry): string | undefined {
  for (const detail of [entry.error, entry.reason]) {
    if (detail && typeof detail === "object" && "message" in detail) {
      return String((detail as { message?: unknown }).message ?? "");
    }
  }
  if (typeof entry.message === "string") return entry.message;
  if (typeof entry.reason === "string") return entry.reason;
  if (Array.isArray(entry.arguments)) {
    return (
      entry.arguments
        .map((argument) => {
          if (typeof argument === "string") return argument;
          if (argument && typeof argument === "object" && "message" in argument) {
            return String((argument as { message?: unknown }).message ?? "");
          }
          return "";
        })
        .filter(Boolean)
        .join(" · ") || undefined
    );
  }
  return undefined;
}

export const LogManagementPanel: React.FC<LogManagementPanelProps> = ({ notify }) => {
  const [status, setStatus] = React.useState<LogManagerStatus | null>(null);
  const [entries, setEntries] = React.useState<AppLogEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [retentionDraft, setRetentionDraft] = React.useState(7);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const [nextStatus, nextEntries] = await Promise.all([
        window.desktopApi.getLogManagerStatus(),
        window.desktopApi.getRecentLogs(50, "warn"),
      ]);
      setStatus(nextStatus);
      setRetentionDraft(nextStatus.retentionDays);
      setEntries(nextEntries);
    } catch (error) {
      notify(`读取日志状态失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateSettings = async (
    patch: Partial<{
      level: AppLogLevel;
      fileEnabled: boolean;
      retentionDays: number;
    }>,
  ) => {
    try {
      await window.desktopApi.updateLogManagerSettings(patch);
      await refresh();
      notify("日志设置已保存");
    } catch (error) {
      notify(`保存日志设置失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const commitRetention = () => {
    if (!status || retentionDraft === status.retentionDays) return;
    void updateSettings({ retentionDays: retentionDraft });
  };

  const openDirectory = async () => {
    if (!(await window.desktopApi.openLogDirectory())) notify("无法打开日志目录");
  };

  const clearLogs = async () => {
    if (!window.confirm("确定清理全部日志文件吗？此操作不会影响项目和会话数据。")) return;
    try {
      const count = await window.desktopApi.clearLogs();
      await refresh();
      notify(`已清理 ${count} 个日志文件`);
    } catch (error) {
      notify(`清理日志失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="settings-panel-stack">
      <SettingsSection
        className="log-management-summary"
        title="日志采集"
        hint={status?.fileEnabled ? "运行中" : "仅控制台"}
      >
        <div className="log-status-grid">
          <div>
            <span>文件</span>
            <strong>{status?.fileCount ?? "—"}</strong>
          </div>
          <div>
            <span>占用空间</span>
            <strong>{status ? formatBytes(status.totalBytes) : "—"}</strong>
          </div>
          <div>
            <span>保留周期</span>
            <strong>{status ? `${status.retentionDays} 天` : "—"}</strong>
          </div>
          <div>
            <span>归档方式</span>
            <strong>每日一个文件</strong>
          </div>
        </div>

        <div className="settings-form-stack">
          <SettingsRow label="最低记录级别">
            <Select
              variant="block"
              className="log-level-select"
              ariaLabel="最低记录级别"
              value={status?.level ?? "info"}
              disabled={!status}
              onChange={(next) => void updateSettings({ level: next as AppLogLevel })}
              options={[
                { value: "debug", label: "Debug（完整诊断）" },
                { value: "info", label: "Info（推荐）" },
                { value: "warn", label: "Warn（仅问题）" },
                { value: "error", label: "Error（仅错误）" },
              ]}
            />
          </SettingsRow>
          <SettingsRow label="写入日志文件">
            <Switch
              label="写入日志文件"
              checked={status?.fileEnabled ?? false}
              disabled={!status}
              onChange={(event) => void updateSettings({ fileEnabled: event.target.checked })}
            />
          </SettingsRow>
          <SettingsRow label="保留天数">
            <RangeField
              valueLabel={`${retentionDraft} 天`}
              min={1}
              max={90}
              step={1}
              disabled={!status}
              value={retentionDraft}
              onChange={(event) => setRetentionDraft(parseInt(event.target.value, 10))}
              onMouseUp={commitRetention}
              onTouchEnd={commitRetention}
              onKeyUp={commitRetention}
              aria-label="日志保留天数"
            />
          </SettingsRow>
        </div>

        <div className="log-management-actions">
          <Button onClick={() => void refresh()} disabled={loading}>
            <RefreshIcon size={14} /> {loading ? "刷新中" : "刷新"}
          </Button>
          <Button onClick={() => void openDirectory()}>
            <FolderIcon size={14} /> 打开目录
          </Button>
          <Button variant="danger" className="log-clear-btn" onClick={() => void clearLogs()}>
            <TrashIcon size={14} /> 清理日志
          </Button>
        </div>
        {status && (
          <div className="settings-path-display">
            <FolderIcon size={14} />
            <span>{normalizeWorkspacePath(status.directory)}</span>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="最近问题" hint={`Warn / Error · ${entries.length}`}>
        <div className="log-entry-list">
          {entries.length === 0 ? (
            <div className="log-empty-state">最近日志中没有捕获到警告或错误</div>
          ) : (
            entries.map((entry) => (
              <div
                className={`log-entry log-entry--${entry.level}`}
                key={`${entry.timestamp}-${entry.event}-${formatEntryDetail(entry) ?? ""}`}
              >
                <div className="log-entry-topline">
                  <span className="log-entry-level">{entry.level}</span>
                  <code>
                    {entry.module ? `${entry.module} · ` : ""}
                    {entry.event}
                  </code>
                  <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                </div>
                {formatEntryDetail(entry) && <p>{formatEntryDetail(entry)}</p>}
              </div>
            ))
          )}
        </div>
      </SettingsSection>
    </div>
  );
};
