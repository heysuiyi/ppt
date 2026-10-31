export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogValue =
  | null
  | boolean
  | number
  | string
  | readonly LogValue[]
  | { readonly [key: string]: LogValue };

export interface LogContext {
  readonly operation?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly threadId?: string;
  readonly queryId?: string;
  readonly runId?: string;
  readonly step?: number;
  readonly requestId?: string;
  readonly toolCallId?: string;
}

export type LogInput = Readonly<Record<string, unknown>>;
export type LogData = Readonly<Record<string, LogValue>>;

export interface LogRecord {
  readonly schemaVersion: 1;
  readonly timestamp: string;
  readonly instanceId: string;
  readonly sequence: number;
  readonly level: LogLevel;
  readonly name: string;
  readonly event: string;
  readonly context: LogContext;
  readonly data?: LogData;
}

export interface Logger {
  child(context: LogContext): Logger;
  isEnabled(level: LogLevel): boolean;
  debug(event: string, data?: LogInput): void;
  info(event: string, data?: LogInput): void;
  warn(event: string, data?: LogInput): void;
  error(event: string, data?: LogInput): void;
}

/** 输出只能同步受理记录；共享进程设施不随输出关闭。 */
export interface LogExporter {
  export(record: LogRecord): void;
  close(): Promise<void>;
}

export interface LogOutput {
  readonly id: string;
  readonly minimumLevel: LogLevel;
  readonly exporter: LogExporter;
}

export interface LogsOptions {
  readonly outputs: readonly LogOutput[];
}

export interface LogOutputStatus {
  readonly id: string;
  readonly failureCount: number;
  readonly lastFailure?: {
    readonly timestamp: string;
    readonly operation: "export" | "close";
  };
}

export interface LogsStatus {
  readonly state: "open" | "closing" | "closed";
  readonly lateWriteCount: number;
  readonly outputs: readonly LogOutputStatus[];
}

export interface Logs {
  getLogger(name: string): Logger;
  getStatus(): LogsStatus;
  close(): Promise<void>;
}

export interface NodeLogOutputOptions {
  readonly enabled: boolean;
  readonly minimumLevel?: LogLevel;
}

export interface NodeLogFileOptions extends NodeLogOutputOptions {
  readonly retentionDays?: number;
}

export interface NodeLogRecentOptions {
  readonly enabled?: boolean;
  readonly minimumLevel?: LogLevel;
  readonly capacity?: number;
}

export interface NodeLogsOptions {
  readonly directory: string;
  readonly terminal: NodeLogOutputOptions;
  readonly file: NodeLogFileOptions;
  readonly recent?: NodeLogRecentOptions;
}

export interface NodeLogOutputSettings {
  readonly enabled: boolean;
  readonly minimumLevel: LogLevel;
}

export interface NodeLogFileSettings extends NodeLogOutputSettings {
  readonly retentionDays: number;
}

export interface NodeLogRecentSettings extends NodeLogOutputSettings {
  readonly capacity: number;
}

export interface NodeLogsSettings {
  readonly terminal: NodeLogOutputSettings;
  readonly file: NodeLogFileSettings;
  readonly recent: NodeLogRecentSettings;
}

export interface NodeLogsSettingsPatch {
  readonly terminal?: Partial<NodeLogOutputSettings>;
  readonly file?: Partial<NodeLogFileSettings>;
  readonly recent?: Partial<NodeLogRecentSettings>;
}

export interface RecentLogQuery {
  readonly limit?: number;
  readonly minimumLevel?: LogLevel;
}

export interface LogFileStatus {
  readonly directory: string;
  readonly enabled: boolean;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly lastWrittenAt?: string;
  readonly failureCount: number;
}

/** 管理权归宿主，消费方只借用 Logger。设置不在模块内持久化。 */
export interface NodeLogs extends Logs {
  getSettings(): NodeLogsSettings;
  updateSettings(patch: NodeLogsSettingsPatch): Promise<NodeLogsSettings>;
  getRecentEntries(query?: RecentLogQuery): readonly LogRecord[];
  getFileStatus(): Promise<LogFileStatus>;
  clearFiles(): Promise<number>;
}
