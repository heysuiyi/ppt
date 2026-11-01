export type AppLogLevel = "debug" | "info" | "warn" | "error";

export interface AppLogEntry {
  timestamp: string;
  level: AppLogLevel;
  scope: string;
  event: string;
  module?: string;
  /** 展示列表身份，不以事件文本去重。 */
  id?: string;
  [key: string]: unknown;
}

export interface LogManagerSettings {
  level: AppLogLevel;
  fileEnabled: boolean;
  retentionDays: number;
}

export interface LogManagerStatus extends LogManagerSettings {
  directory: string;
  fileCount: number;
  totalBytes: number;
  lastWrittenAt?: string;
  failureCount?: number;
  settingsPersistenceError?: boolean;
  maintenanceSkipped?: string[];
}

export interface LogClearResult {
  removedFiles: number;
  /** 活动实例或无法确认归属的范围，不得报告为已清理。 */
  skipped: string[];
}

export interface RendererLogReport {
  level: AppLogLevel;
  event: string;
  data?: Record<string, unknown>;
}
