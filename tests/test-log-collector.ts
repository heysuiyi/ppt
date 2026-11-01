import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogs, type LogRecord, type Logs } from "@agent-harness/logs/logs";
import { afterEach } from "vitest";
import { contextualLogger } from "../app/main/logging/log-context";

const activeLogs: Logs[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(activeLogs.splice(0).map((logs) => logs.close()));
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

export function createTestLogCollector(name = "test") {
  const records: LogRecord[] = [];
  const logs = createLogs({
    outputs: [
      {
        id: "test-records",
        minimumLevel: "debug",
        exporter: {
          export(record) {
            records.push(record);
          },
          async close() {},
        },
      },
    ],
  });
  activeLogs.push(logs);
  return { records, logger: contextualLogger(logs.getLogger(name)) };
}

export function createTestGatewayOptions(logDirectory?: string) {
  if (!logDirectory) {
    logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-gateway-logs-"));
    directories.push(logDirectory);
  }
  return { logDirectory, logger: createTestLogCollector("gateway").logger };
}
