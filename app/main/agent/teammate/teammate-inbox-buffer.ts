import type { AgentMailboxMessage, MessageBus } from "./message-bus";

export class TeammateInboxBuffer {
  private readonly buffered: AgentMailboxMessage[] = [];

  constructor(
    private readonly bus: MessageBus,
    private readonly name: string,
  ) {}

  async takeAll(): Promise<AgentMailboxMessage[]> {
    const fresh = await this.bus.readInbox(this.name);
    this.buffered.push(...fresh);
    return this.shiftAll();
  }

  pushBack(messages: AgentMailboxMessage[]): void {
    this.buffered.unshift(...messages);
  }

  private shiftAll(): AgentMailboxMessage[] {
    return this.buffered.splice(0);
  }
}
