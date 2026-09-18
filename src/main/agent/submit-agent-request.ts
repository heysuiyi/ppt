import type { AgentSettings } from "@shared/agent-settings";
import type { SubmitAgentRequest } from "@shared/ipc";
import { createSessionTitleFromPrompt, type SessionChatMessage } from "@shared/session";
import { toAgentMessageHistory } from "@shared/session-recovery";
import { resolveConfiguredModel } from "../agent-settings-store";
import type { FileSessionStore } from "../session-store";
import type { DurableServiceThread } from "./persistence/durable-service-store";

/** Called under Main's foreground-run reservation. No Renderer state is consulted. */
export async function acceptAgentRequest(
  store: FileSessionStore,
  settings: AgentSettings,
  request: SubmitAgentRequest,
) {
  const model = resolveConfiguredModel(settings, request.modelId);
  const fallbackId = settings.gateway.fallbackModelId;
  const fallbackEnabled = settings.vendors.some(
    (vendor) =>
      vendor.enabled && vendor.models.some((model) => model.id === fallbackId && model.enabled),
  );
  const fallbackModel =
    fallbackId && fallbackEnabled ? resolveConfiguredModel(settings, fallbackId) : undefined;
  if (store.conversationDatabase.hasRun(request.requestId)) {
    throw new Error("This request has already been accepted.");
  }
  if (request.target.type === "new-session" && request.action.type !== "message") {
    throw new Error("A new session requires a new message.");
  }
  if (
    request.target.type === "new-session" &&
    (request.editorContext?.currentSlideId || request.editorContext?.selectedElementIds.length)
  ) {
    throw new Error("A new session has no slide selection.");
  }
  const newSession =
    request.target.type === "new-session"
      ? await store.prepareSession({
          rootPath: request.target.rootPath,
          title: createSessionTitleFromPrompt(request.prompt),
          defaultTemplateId: settings.defaultTemplateId,
        })
      : undefined;
  const sessionId =
    request.target.type === "session" ? request.target.sessionId : newSession!.session.id;
  const snapshot = newSession ?? store.getSession(sessionId);
  const context = request.editorContext;
  if (
    context?.currentSlideId &&
    !snapshot.presentation.slides.some((slide) => slide.id === context.currentSlideId)
  ) {
    throw new Error("The selected slide no longer exists.");
  }
  if (context?.selectedElementIds.length) {
    throw new Error("The selected element no longer exists.");
  }
  let messages = snapshot.messages;
  let threadId: string | undefined;
  const latest = store.conversationDatabase.latestSessionRun(sessionId);
  const durable =
    latest && store.conversationDatabase.loadServiceThread<DurableServiceThread>(latest.threadId);
  if (request.action.type === "edit") {
    const messageId = request.action.messageId;
    const index = messages.findIndex(
      (message) => message.id === messageId && message.role === "user",
    );
    if (index < 0) throw new Error("The message being edited no longer exists.");
    messages = messages.slice(0, index);
  } else {
    if (
      request.action.type === "answer" &&
      (latest?.runId !== request.action.questionRunId || durable?.status !== "waiting_user")
    )
      throw new Error("This question is no longer awaiting an answer.");
    if (durable?.status === "active" || durable?.status === "waiting_user")
      threadId = durable.threadId;
  }
  const { fallbackModelId: _fallbackId, ...gateway } = settings.gateway;
  const history = toAgentMessageHistory(messages);
  if (threadId && durable?.status === "waiting_user") {
    messages = messages.map((message) =>
      message.runStatus === "waiting" && message.threadId === threadId
        ? { ...message, runStatus: "completed" as const }
        : message,
    );
  }
  if (request.action.type !== "inbox") {
    messages = [
      ...messages,
      {
        id: request.userMessageId,
        role: "user",
        content:
          request.action.type === "answer"
            ? (request.action.displayContent ?? request.prompt)
            : request.prompt,
      },
    ];
  }
  const anchor: SessionChatMessage = {
    id: request.assistantMessageId,
    role: "assistant",
    content: "",
    runId: request.requestId,
    runStatus: "running",
    runStartedAt: Date.now(),
    threadId: threadId ?? request.requestId,
  };
  await store.acceptAgentRun(
    sessionId,
    [...messages, anchor],
    {
      runId: request.requestId,
      sessionId,
      threadId: threadId ?? request.requestId,
      provider: model.provider,
      model: model.model,
      request: request.prompt,
    },
    newSession,
  );
  return {
    sessionId,
    threadId,
    history,
    model,
    services: { ...gateway, fallbackModel },
    stepLimits: settings.stepLimits,
    executionStrategy: request.executionStrategy ?? settings.executionStrategy,
    bootstrap: { ...store.getBootstrap(), activeSession: store.getSession(sessionId) },
  };
}
