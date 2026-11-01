import type { ChatMessage } from "../chatMessageRuntime";

interface PrepareAgentRunMessagesOptions {
  sourceMessages: ChatMessage[];
  activeRequest: string;
  userDisplayContent: string | null;
  isSidechain: boolean;
  editedMessageId?: string;
  streamMessage: ChatMessage;
  createMessageId: () => string;
}

export interface PreparedAgentRunMessages {
  runMessages: ChatMessage[];
  forkedMessages?: ChatMessage[];
  retainedMessageIds?: Set<string>;
}

/**
 * 纯函数：根据发送类型生成本次运行可见的消息快照，不直接修改 React 状态或持久化数据。
 * 调用方负责提交 runMessages，并根据 retainedMessageIds 清理被截断分支的 Display Card。
 */
export function prepareAgentRunMessages({
  sourceMessages,
  activeRequest,
  userDisplayContent,
  isSidechain,
  editedMessageId,
  streamMessage,
  createMessageId,
}: PrepareAgentRunMessagesOptions): PreparedAgentRunMessages {
  // sidechain 是后台回合，不插入可见用户消息，也不参与编辑消息分支。
  if (isSidechain) {
    return { runMessages: [...sourceMessages, streamMessage] };
  }

  if (editedMessageId) {
    const editedIndex = sourceMessages.findIndex((message) => message.id === editedMessageId);
    if (editedIndex === -1) {
      return { runMessages: [...sourceMessages, streamMessage] };
    }

    // 编辑旧消息等价于从该消息处创建新分支，后续旧消息及其卡片都应被截断。
    const forkedMessages = sourceMessages.slice(0, editedIndex + 1);
    forkedMessages[editedIndex] = {
      ...forkedMessages[editedIndex],
      id: createMessageId(),
      content: userDisplayContent ?? activeRequest,
    };

    return {
      forkedMessages,
      retainedMessageIds: new Set(forkedMessages.map((message) => message.id)),
      runMessages: [...forkedMessages, streamMessage],
    };
  }

  if (userDisplayContent !== null) {
    // userDisplayContent 可与真实 prompt 不同；null 明确表示只运行、不展示用户气泡。
    return {
      runMessages: [
        ...sourceMessages,
        { id: createMessageId(), role: "user", content: userDisplayContent },
        streamMessage,
      ],
    };
  }

  return { runMessages: [...sourceMessages, streamMessage] };
}
