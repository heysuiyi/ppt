import type { DatabaseSync } from "node:sqlite";
import { AgentConversationHistoryMapper } from "./agent-conversation-history/agent-conversation-history.mapper";
import { AppStateMapper } from "./app-state/app-state.mapper";
import { CheckpointMapper } from "./checkpoint/checkpoint.mapper";
import { ContextSnapshotMapper } from "./context-snapshot/context-snapshot.mapper";
import { ConversationEventMapper } from "./conversation-event/conversation-event.mapper";
import { MessageMapper } from "./message/message.mapper";
import { ProjectMapper } from "./project/project.mapper";
import { RunMapper } from "./run/run.mapper";
import { ServiceThreadMapper } from "./service-thread/service-thread.mapper";
import { SessionMapper } from "./session/session.mapper";

export interface ConversationMappers {
  readonly appState: AppStateMapper;
  readonly projects: ProjectMapper;
  readonly sessions: SessionMapper;
  readonly messages: MessageMapper;
  readonly runs: RunMapper;
  readonly conversationEvents: ConversationEventMapper;
  readonly checkpoints: CheckpointMapper;
  readonly serviceThreads: ServiceThreadMapper;
  readonly agentConversationHistories: AgentConversationHistoryMapper;
  readonly contextSnapshots: ContextSnapshotMapper;
}

export function createConversationMappers(database: DatabaseSync): ConversationMappers {
  return {
    appState: new AppStateMapper(database),
    projects: new ProjectMapper(database),
    sessions: new SessionMapper(database),
    messages: new MessageMapper(database),
    runs: new RunMapper(database),
    conversationEvents: new ConversationEventMapper(database),
    checkpoints: new CheckpointMapper(database),
    serviceThreads: new ServiceThreadMapper(database),
    agentConversationHistories: new AgentConversationHistoryMapper(database),
    contextSnapshots: new ContextSnapshotMapper(database),
  };
}
