import type { DatabaseSync } from "node:sqlite";
import type { RunIdentity } from "@agent-harness/core/protocol-values";
import type {
  AgentCheckpoint,
  StoredToolInvocation,
} from "@agent-harness/core/session/session-contract";
import type { HostToolOutcome } from "../../host-contract.js";
import { escapeDisplayControls } from "../../safe-display-text.js";
import { projectToolOutcome, sanitizeToolDisplay } from "../../tool-display.js";

/** 独立展示事实：位置属于 Query，绝不按跨轮重复的 callId 单独关联。 */
export interface StoredHostToolFact extends HostToolOutcome {
  readonly queryId: string;
  readonly step: number;
  readonly messageIndex: number;
  readonly contentIndex: number;
  readonly callId: string;
  readonly name: string;
  readonly identity: RunIdentity;
  readonly hasCompletion: boolean;
  readonly dispatched: boolean;
}

export function createToolDisplayWriter(
  database: DatabaseSync,
): (checkpoint: AgentCheckpoint) => void {
  const save = database.prepare(`
    INSERT INTO general_agent_host_tool_displays
      (agent_id, thread_id, query_id, step, message_index, content_index, call_id, name, tool_version, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, thread_id, query_id, step, message_index, content_index, call_id)
    DO UPDATE SET payload = CASE
      WHEN json_extract(general_agent_host_tool_displays.payload, '$.effects') = 'applied'
      THEN json_set(excluded.payload, '$.effects', 'applied')
      ELSE excluded.payload END
    WHERE json_extract(general_agent_host_tool_displays.payload, '$.hasCompletion') IS NOT 1
      OR json_extract(excluded.payload, '$.hasCompletion') = 1
  `);
  return (checkpoint) => {
    const inflight = "inflight" in checkpoint ? checkpoint.inflight : undefined;
    const batch =
      inflight?.type === "tools"
        ? inflight
        : inflight?.type === "resume"
          ? inflight.batch
          : undefined;
    if (!batch) return;
    const pending =
      checkpoint.status === "waiting"
        ? checkpoint.pending
        : inflight?.type === "resume"
          ? inflight.pending
          : undefined;
    const step = checkpoint.committed.step + 1;
    const messageIndex = checkpoint.committed.messages.length;
    const invocations = new Map<string, StoredToolInvocation>();
    for (const invocation of batch.remaining) invocations.set(invocation.call.callId, invocation);
    for (const entry of batch.completed)
      invocations.set(entry.invocation.call.callId, entry.invocation);
    if (pending) invocations.set(pending.invocation.call.callId, pending.invocation);
    const completed = new Map(
      batch.completed.map((entry) => [entry.invocation.call.callId, entry.completion]),
    );
    for (const [contentIndex, content] of batch.response.message.content.entries()) {
      if (content.type !== "tool-call") continue;
      const invocation = invocations.get(content.callId);
      if (!invocation || invocation.call.name !== content.name) continue;
      const completion = completed.get(content.callId);
      const outcome = projectToolOutcome(invocation, completion);
      // 派发不是完成；待审批也不证明工具已执行。展示结算由权威 completion 区分。
      const unresolved = completion
        ? {}
        : {
            ...(invocation.state === "dispatched" ? { effects: "unknown" as const } : {}),
            ...(pending?.invocation.call.callId === content.callId
              ? { effects: pending.effects }
              : {}),
          };
      const identity = invocation.identity;
      const payload = {
        ...outcome,
        ...unresolved,
        hasCompletion: completion !== undefined,
        dispatched:
          invocation.state === "dispatched" && pending?.invocation.call.callId !== content.callId,
        identity: {
          agentId: identity.agentId,
          threadId: identity.threadId,
          queryId: identity.queryId,
          runId: identity.runId,
        },
      };
      save.run(
        checkpoint.agentId,
        checkpoint.threadId,
        checkpoint.queryId,
        step,
        messageIndex,
        contentIndex,
        content.callId,
        content.name,
        invocation.toolVersion,
        JSON.stringify(payload),
      );
    }
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 旧库只读发现缺表时返回空，不初始化 schema，不重新访问工具目标文件。 */
export function readToolDisplayFacts(
  database: DatabaseSync,
  agentId: string,
  threadId: string,
): readonly StoredHostToolFact[] {
  if (
    !database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'general_agent_host_tool_displays'",
      )
      .get()
  )
    return [];
  const facts: StoredHostToolFact[] = [];
  for (const row of database
    .prepare(`SELECT query_id, step, message_index, content_index, call_id, name, tool_version, payload
    FROM general_agent_host_tool_displays WHERE agent_id = ? AND thread_id = ?
    ORDER BY message_index, content_index, step`)
    .all(agentId, threadId)) {
    let value: unknown;
    try {
      value = JSON.parse(row.payload as string);
    } catch {
      continue;
    }
    const payload = object(value);
    const identity = object(payload?.identity);
    if (
      !payload ||
      !identity ||
      identity.agentId !== agentId ||
      identity.threadId !== threadId ||
      identity.queryId !== row.query_id ||
      typeof identity.runId !== "string"
    )
      continue;
    if (
      ![row.step, row.message_index, row.content_index].every(
        (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
      )
    )
      continue;
    if (
      typeof row.query_id !== "string" ||
      typeof row.call_id !== "string" ||
      typeof row.name !== "string"
    )
      continue;
    const display = sanitizeToolDisplay(
      payload.display,
      row.name,
      row.tool_version as string | null,
    );
    const hasCompletion = payload.hasCompletion === true;
    const status =
      hasCompletion &&
      (payload.status === "completed" ||
        payload.status === "failed" ||
        payload.status === "unknown")
        ? payload.status
        : undefined;
    const effects =
      payload.effects === "none" || payload.effects === "applied" || payload.effects === "unknown"
        ? payload.effects
        : undefined;
    const error = object(payload.error);
    facts.push({
      queryId: row.query_id,
      step: row.step as number,
      messageIndex: row.message_index as number,
      contentIndex: row.content_index as number,
      callId: escapeDisplayControls(row.call_id),
      name: escapeDisplayControls(row.name),
      identity: { agentId, threadId, queryId: row.query_id, runId: identity.runId },
      hasCompletion,
      dispatched: payload.dispatched === true,
      ...(display ? { display } : {}),
      ...(status ? { status } : {}),
      ...(effects ? { effects } : {}),
      ...(hasCompletion &&
      status !== "completed" &&
      error &&
      typeof error.code === "string" &&
      typeof error.message === "string"
        ? {
            error: {
              code: escapeDisplayControls(error.code),
              message: escapeDisplayControls(error.message),
            },
          }
        : {}),
    });
  }
  return facts;
}
