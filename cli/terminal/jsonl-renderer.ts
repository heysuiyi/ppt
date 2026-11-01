import type { TerminalRecord } from "./terminal-contract.js";
import { sanitizeTerminalRecord } from "./terminal-projection.js";

/** Only versioned records cross stdout; views, previews and local messages have no encoder. */
export function encodeTerminalRecord(record: TerminalRecord): string {
  return `${JSON.stringify(sanitizeTerminalRecord(record))}\n`;
}
