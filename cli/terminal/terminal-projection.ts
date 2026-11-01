import type { AgentRunResult } from "@agent-harness/core/agent-contract";
import { AgentError } from "@agent-harness/core/protocol-errors";
import type {
  InteractionRequest,
  ProtocolError,
  RunIdentity,
} from "@agent-harness/core/protocol-values";
import type { StoredToolInvocation } from "@agent-harness/core/session/session-contract";
import type { RuntimeEvent } from "@agent-harness/core/session/session-events";
import type { TerminalTimelinePart, TerminalTurnSettlement } from "./renderer-contract.js";
import type {
  TerminalInteractionDisplay,
  TerminalInteractionReference,
  TerminalRecord,
  TerminalToolReference,
} from "./terminal-contract.js";
import { sanitizeTerminalText as safe } from "./terminal-text.js";
import { projectToolDisplay, sanitizeToolDisplay } from "./tool-display.js";

export function terminalIdentity(value: RunIdentity): RunIdentity {
  return {
    agentId: safe(value.agentId),
    threadId: safe(value.threadId),
    queryId: safe(value.queryId),
    runId: safe(value.runId),
  };
}

/** Only Core's public error class is trusted at a catch boundary. SDK/server values stay private. */
export function terminalError(error: unknown): ProtocolError {
  if (error instanceof AgentError) return sanitizeProtocolError(error);
  return {
    code: "TERMINAL_OPERATION_FAILED",
    message: "The operation failed; private diagnostic details were withheld.",
  };
}

/** These fields are already public protocol values, not arbitrary caught exceptions. */
function sanitizeProtocolError(error: ProtocolError): ProtocolError {
  return { code: safe(error.code), message: safe(error.message) };
}

export function interactionReference(request: InteractionRequest): TerminalInteractionReference {
  return {
    interactionId: safe(request.id),
    owner: safe(request.owner),
    payloadType: safe(request.payload.type),
    payloadVersion: request.payload.version,
  };
}

export function terminalInteractionDisplay(
  display: TerminalInteractionDisplay,
): TerminalInteractionDisplay {
  if (display.support !== "supported") return { support: "unsupported" };
  return {
    support: "supported",
    summary: safe(display.summary),
    confirmation: display.confirmation,
    choices: display.choices.map((choice) => ({
      id: safe(choice.id),
      label: safe(choice.label),
      responseType: choice.responseType,
    })),
  };
}

function invocationReference(invocation: StoredToolInvocation): TerminalToolReference {
  return {
    invocationIdentity: terminalIdentity(invocation.identity),
    callId: safe(invocation.call.callId),
    name: safe(invocation.call.name),
    toolVersion: invocation.toolVersion === null ? null : safe(invocation.toolVersion),
  };
}

export function projectTerminalEvent(
  event: RuntimeEvent,
  describe: (request: InteractionRequest) => TerminalInteractionDisplay,
): TerminalRecord | undefined {
  if (event.kind !== "fact") return undefined;
  const identity = terminalIdentity(event.identity);
  switch (event.type) {
    case "run.started":
    case "run.completed":
    case "run.cancelled":
    case "run.interrupted":
      return { version: 1, type: "progress", identity, phase: event.type };
    case "run.waiting":
      return {
        version: 1,
        type: "progress",
        identity,
        phase: event.type,
        interactionId: safe(event.interactionId),
      };
    case "run.failed":
      return {
        version: 1,
        type: "progress",
        identity,
        phase: event.type,
        error: sanitizeProtocolError(event.error),
      };
    case "model.completed":
      return sanitizeTerminalRecord({
        version: 1,
        type: "model.completed",
        identity,
        requestId: event.requestId,
        step: event.step,
        durationMs: event.durationMs,
        ...(event.usage ? { usage: event.usage } : {}),
      });
    case "step.started":
      return { version: 1, type: "progress", identity, phase: event.type, step: event.step };
    case "step.committed":
      return {
        version: 1,
        type: "progress",
        identity,
        phase: event.type,
        step: event.step,
        historyRevision: event.historyRevision,
      };
    case "tool.started":
    case "tool.completed": {
      const tool = invocationReference(event.invocation);
      const display = projectToolDisplay(
        event.invocation,
        event.type === "tool.completed" && event.completion.status === "succeeded"
          ? event.completion.presentation
          : undefined,
      );
      const base = {
        version: 1 as const,
        type: "tool" as const,
        identity,
        invocationIdentity: tool.invocationIdentity,
        callId: tool.callId,
        name: tool.name,
        toolVersion: tool.toolVersion,
        step: event.step,
        ...(display
          ? {
              display:
                event.type === "tool.completed" && display.output.length === 0
                  ? { ...display, output: ["结果预览不可用"] }
                  : display,
            }
          : {}),
      };
      if (event.type === "tool.started") return { ...base, phase: "started" };
      if (event.completion.status === "succeeded")
        return {
          ...base,
          phase: "completed",
          status: "succeeded",
          effects: event.completion.effects,
        };
      return {
        ...base,
        phase: "completed",
        status: event.completion.status,
        effects: event.completion.effects,
        error: sanitizeProtocolError(event.completion.error),
      };
    }
    case "interaction.requested": {
      const reference = interactionReference(event.interaction);
      return {
        version: 1,
        type: "interaction",
        identity,
        tool: invocationReference(event.invocation),
        phase: "requested",
        interactionId: reference.interactionId,
        owner: reference.owner,
        payloadType: reference.payloadType,
        payloadVersion: reference.payloadVersion,
        display: terminalInteractionDisplay(describe(event.interaction)),
      };
    }
    case "interaction.resolved":
      return {
        version: 1,
        type: "interaction",
        identity,
        tool: invocationReference(event.invocation),
        phase: "resolved",
        interactionId: safe(event.response.interactionId),
        responseType: event.response.type,
      };
  }
}

export function projectTerminalResult(
  result: AgentRunResult,
  describe: (request: InteractionRequest) => TerminalInteractionDisplay,
): readonly TerminalRecord[] {
  const identity = terminalIdentity(result.identity);
  const records: TerminalRecord[] = [];
  if (result.status === "completed") {
    result.output.forEach((message, messageIndex) => {
      if (message.role !== "assistant") return;
      message.content.forEach((part, contentIndex) => {
        if (part.type === "reasoning" && part.text.length > 0)
          records.push({
            version: 1,
            type: "assistant.reasoning",
            identity,
            messageIndex,
            contentIndex,
            text: safe(part.text),
          });
      });
      const content = message.content.flatMap((part, contentIndex) =>
        part.type === "text" && part.text.length > 0
          ? [{ contentIndex, text: safe(part.text) }]
          : [],
      );
      if (content.length > 0)
        records.push({ version: 1, type: "assistant.message", identity, messageIndex, content });
    });
    records.push({ version: 1, type: "query.result", identity, status: "completed" });
  } else if (result.status === "waiting") {
    records.push({
      version: 1,
      type: "query.result",
      identity,
      status: "waiting",
      interaction: interactionReference(result.interaction),
      display: terminalInteractionDisplay(describe(result.interaction)),
    });
  } else if (result.status === "failed") {
    records.push({
      version: 1,
      type: "query.result",
      identity,
      status: "failed",
      error: sanitizeProtocolError(result.error),
    });
  } else {
    records.push({ version: 1, type: "query.result", identity, status: result.status });
  }
  return records;
}

/** Public canonical positions only; tool payloads and private replay never cross this boundary. */
export function projectTerminalSettlement(
  result: AgentRunResult,
  describe: (request: InteractionRequest) => TerminalInteractionDisplay,
): TerminalTurnSettlement {
  const timeline: TerminalTimelinePart[] = [];
  const pendingCalls = new Map<string, number>();
  if (result.status === "completed") {
    result.output.forEach((message, messageIndex) => {
      message.content.forEach((part, contentIndex) => {
        if (message.role === "assistant" && part.type === "text" && part.text.length > 0) {
          timeline.push({ type: "text", messageIndex, contentIndex, text: safe(part.text) });
        } else if (
          message.role === "assistant" &&
          part.type === "reasoning" &&
          part.text.length > 0
        ) {
          timeline.push({ type: "reasoning", messageIndex, contentIndex, text: safe(part.text) });
        } else if (part.type === "tool-call" || part.type === "tool-result") {
          const callId = safe(part.callId);
          const pending = pendingCalls.get(callId) ?? 0;
          if (part.type === "tool-call") {
            pendingCalls.set(callId, pending + 1);
            timeline.push({ type: "tool", callId });
          } else if (pending > 0) {
            pendingCalls.set(callId, pending - 1);
          } else timeline.push({ type: "tool", callId });
        }
      });
    });
  }
  return { records: projectTerminalResult(result, describe), timeline };
}

function safeTool(tool: TerminalToolReference): TerminalToolReference {
  return {
    invocationIdentity: terminalIdentity(tool.invocationIdentity),
    callId: safe(tool.callId),
    name: safe(tool.name),
    toolVersion: tool.toolVersion === null ? null : safe(tool.toolVersion),
  };
}

/** Reconstruct at the output boundary too: structural typing does not remove extra payloads. */
export function sanitizeTerminalRecord(record: TerminalRecord): TerminalRecord {
  switch (record.type) {
    case "session":
      return {
        version: 1,
        type: "session",
        threadId: safe(record.threadId),
        ...(record.model
          ? { model: { id: safe(record.model.id), label: safe(record.model.label) } }
          : {}),
        ...(record.capabilities
          ? {
              capabilities: record.capabilities.map((item) => ({
                id: safe(item.id),
                label: safe(item.label),
              })),
            }
          : {}),
      };
    case "progress": {
      const identity = terminalIdentity(record.identity);
      switch (record.phase) {
        case "run.failed":
          return {
            version: 1,
            type: "progress",
            identity,
            phase: record.phase,
            error: sanitizeProtocolError(record.error),
          };
        case "run.waiting":
          return {
            version: 1,
            type: "progress",
            identity,
            phase: record.phase,
            interactionId: safe(record.interactionId),
          };
        case "step.started":
          return { version: 1, type: "progress", identity, phase: record.phase, step: record.step };
        case "step.committed":
          return {
            version: 1,
            type: "progress",
            identity,
            phase: record.phase,
            step: record.step,
            historyRevision: record.historyRevision,
          };
        default:
          return { version: 1, type: "progress", identity, phase: record.phase };
      }
    }
    case "tool": {
      const tool = safeTool(record);
      const display = sanitizeToolDisplay(record.display, record.name, record.toolVersion);
      const base = {
        version: 1 as const,
        type: "tool" as const,
        identity: terminalIdentity(record.identity),
        invocationIdentity: tool.invocationIdentity,
        callId: tool.callId,
        name: tool.name,
        toolVersion: tool.toolVersion,
        step: record.step,
        ...(display ? { display } : {}),
      };
      if (record.phase === "started") return { ...base, phase: "started" };
      if (record.status === "succeeded")
        return { ...base, phase: "completed", status: record.status, effects: record.effects };
      return {
        ...base,
        phase: "completed",
        status: record.status,
        effects: record.effects,
        error: sanitizeProtocolError(record.error),
      };
    }
    case "interaction": {
      const base = {
        version: 1 as const,
        type: "interaction" as const,
        identity: terminalIdentity(record.identity),
        tool: safeTool(record.tool),
        interactionId: safe(record.interactionId),
      };
      if (record.phase === "resolved")
        return { ...base, phase: "resolved", responseType: record.responseType };
      return {
        ...base,
        phase: "requested",
        owner: safe(record.owner),
        payloadType: safe(record.payloadType),
        payloadVersion: record.payloadVersion,
        display: terminalInteractionDisplay(record.display),
      };
    }
    case "assistant.message":
      return {
        version: 1,
        type: record.type,
        identity: terminalIdentity(record.identity),
        messageIndex: record.messageIndex,
        content: record.content.map((part) => ({
          contentIndex: part.contentIndex,
          text: safe(part.text),
        })),
      };
    case "assistant.reasoning":
      return {
        version: 1,
        type: record.type,
        identity: terminalIdentity(record.identity),
        messageIndex: record.messageIndex,
        contentIndex: record.contentIndex,
        text: safe(record.text),
      };
    case "model.completed": {
      const usage = record.usage;
      return {
        version: 1,
        type: record.type,
        identity: terminalIdentity(record.identity),
        requestId: safe(record.requestId),
        step: record.step,
        durationMs: Number.isFinite(record.durationMs) ? Math.max(0, record.durationMs) : 0,
        ...(usage &&
        Number.isSafeInteger(usage.inputTokens) &&
        usage.inputTokens >= 0 &&
        Number.isSafeInteger(usage.outputTokens) &&
        usage.outputTokens >= 0
          ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } }
          : {}),
      };
    }
    case "query.result": {
      const identity = terminalIdentity(record.identity);
      if (record.status === "failed")
        return {
          version: 1,
          type: record.type,
          identity,
          status: record.status,
          error: sanitizeProtocolError(record.error),
        };
      if (record.status === "waiting")
        return {
          version: 1,
          type: record.type,
          identity,
          status: record.status,
          interaction: {
            interactionId: safe(record.interaction.interactionId),
            owner: safe(record.interaction.owner),
            payloadType: safe(record.interaction.payloadType),
            payloadVersion: record.interaction.payloadVersion,
          },
          display: terminalInteractionDisplay(record.display),
        };
      return { version: 1, type: record.type, identity, status: record.status };
    }
    case "error":
      return {
        version: 1,
        type: record.type,
        stage: record.stage,
        error: sanitizeProtocolError(record.error),
        outcomeUncertain: record.outcomeUncertain,
        ...(record.identity ? { identity: terminalIdentity(record.identity) } : {}),
      };
    case "process.finished": {
      const lastRun = record.lastRun
        ? {
            identity: terminalIdentity(record.lastRun.identity),
            ...(record.lastRun.status ? { status: record.lastRun.status } : {}),
          }
        : undefined;
      switch (record.exitCode) {
        case 0:
          return {
            version: 1,
            type: record.type,
            exitCode: 0,
            reason: record.reason,
            ...(lastRun ? { lastRun } : {}),
          };
        case 1:
          return {
            version: 1,
            type: record.type,
            exitCode: 1,
            reason: "failure",
            stage: record.stage,
            ...(lastRun ? { lastRun } : {}),
          };
        case 2:
          return {
            version: 1,
            type: record.type,
            exitCode: 2,
            reason: "arguments",
            ...(lastRun ? { lastRun } : {}),
          };
        case 3:
          return {
            version: 1,
            type: record.type,
            exitCode: 3,
            reason: "waiting",
            ...(lastRun ? { lastRun } : {}),
          };
        case 130:
          return {
            version: 1,
            type: record.type,
            exitCode: 130,
            reason: record.reason,
            ...(lastRun ? { lastRun } : {}),
          };
        case 143:
          return {
            version: 1,
            type: record.type,
            exitCode: 143,
            reason: "host-terminated",
            ...(lastRun ? { lastRun } : {}),
          };
        case 141:
          return {
            version: 1,
            type: record.type,
            exitCode: 141,
            reason: "broken-pipe",
            ...(lastRun ? { lastRun } : {}),
          };
      }
    }
  }
}
