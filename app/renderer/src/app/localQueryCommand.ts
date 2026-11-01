import { createDisplayEventId } from "@shared/card-display-protocol";
import { ingestDisplayEvent } from "@shared/cards/display-card-managers";
import type { Presentation } from "@shared/presentation";
import type { ChatMessage } from "./chatMessageRuntime";

const PREVIEW_PROMPT_PATTERN =
  /预览.*(?:ppt|幻灯片|演示文稿)|(?:ppt|幻灯片|演示文稿).*预览|打开.*预览/i;

interface LocalQueryCommandContext {
  prompt: string;
  presentation?: Presentation;
  sessionId: string;
  appendChatMessage: (message: ChatMessage) => void;
  clearRequest: () => void;
  openDeckPreview: () => void;
  notify: (message: string) => void;
}

type LocalQueryCommandHandler = (context: LocalQueryCommandContext) => boolean;

const handlePreviewCommand: LocalQueryCommandHandler = ({
  prompt,
  presentation,
  sessionId,
  appendChatMessage,
  clearRequest,
  openDeckPreview,
  notify,
}) => {
  if (!presentation || !PREVIEW_PROMPT_PATTERN.test(prompt.trim())) return false;

  appendChatMessage({ id: crypto.randomUUID(), role: "user", content: prompt });
  clearRequest();
  openDeckPreview();

  // Display Event 锚定到助手消息，使预览卡片能随该消息持久化和恢复。
  const previewMessageId = crypto.randomUUID();
  ingestDisplayEvent({
    protocolVersion: 1,
    eventId: createDisplayEventId("artifact-preview"),
    emittedAt: new Date().toISOString(),
    kind: "artifact.ready",
    category: "artifact",
    source: {
      kind: "frontend",
      feature: "deck-preview-command",
    },
    scope: {
      ...(sessionId ? { sessionId } : {}),
      anchorMessageId: previewMessageId,
    },
    semantics: {
      blocking: false,
      requiresResponse: false,
      priority: "normal",
    },
    payload: {
      artifactId: "deck",
      artifactType: "deck",
      title: presentation.title,
      revision: presentation.revision,
    },
  });
  appendChatMessage({
    id: previewMessageId,
    role: "assistant",
    content: "已打开演示文稿预览，你可以在右侧或弹窗中查看全部页面。",
  });
  notify("已打开演示文稿预览");
  return true;
};

// 用户输入在进入 Agent Controller 前依次匹配这些纯前端命令。
const LOCAL_QUERY_COMMAND_HANDLERS: LocalQueryCommandHandler[] = [handlePreviewCommand];

export function tryHandleLocalQueryCommand(context: LocalQueryCommandContext): boolean {
  return LOCAL_QUERY_COMMAND_HANDLERS.some((handler) => handler(context));
}
